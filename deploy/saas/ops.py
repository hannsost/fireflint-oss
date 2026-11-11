#!/usr/bin/env python3
"""Encrypted, quiesced FireFlint backups; restore only into an empty target.

Uses explicit kubectl context/namespace and the operator's existing DB Secret.
Never prints credentials. Requires kubectl, age and a PostgreSQL tools image.
No network/cluster access occurs with --dry-run.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit


KEYS = ("jwt-secret", "ai-connector-encryption-key")
FILES = ("database.dump", "assets.tar", "keys.json")
DNS_NAME = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")


class OperationError(Exception):
    pass


def run(args, *, input_data=None, stdout=None, stdin=None, step="command"):
    result = subprocess.run(args, input=input_data, stdin=stdin,
                            stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Provider/psql/kubectl diagnostics can contain connection strings or data.
        raise OperationError(f"{step} failed (exit {result.returncode}); sensitive output suppressed")
    return result.stdout


def validate_asset_tar(path):
    with tarfile.open(path, "r:") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise OperationError("Asset archive contains an unsafe path or special file")
            # Backup records entries relative to '.', and restore strips that
            # component so tar never changes the CSI-owned mount root itself.
            if member.name != "." and not member.name.startswith("./"):
                raise OperationError("Asset archive must use the backup's ./ relative layout")


def restore_key_patch(backup_keys, target_keys):
    """Keep a fresh target JWT key so restore cannot resurrect revoked sessions."""
    old_jwt = base64.b64decode(backup_keys["jwt-secret"], validate=True).decode()
    new_jwt = base64.b64decode(target_keys["jwt-secret"], validate=True).decode()
    ai_key = base64.b64decode(backup_keys["ai-connector-encryption-key"], validate=True).decode()
    if (not 32 <= len(new_jwt.encode()) <= 4096 or len(set(new_jwt)) < 10
            or new_jwt != new_jwt.strip() or "change-me" in new_jwt or "development-only" in new_jwt):
        raise OperationError("Restore requires a strong, newly generated target JWT secret")
    if new_jwt in (old_jwt, ai_key):
        raise OperationError("Target JWT secret must differ from the backup JWT and AI keys; generate a fresh key")
    return {"ai-connector-encryption-key": backup_keys["ai-connector-encryption-key"]}


def unpack_archive(path, destination):
    expected = {*FILES, "manifest.json"}
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != expected:
            raise OperationError("Unexpected backup archive layout")
        for member in members:
            if not member.isfile():
                raise OperationError("Backup members must be regular files")
            with archive.extractfile(member) as source, (destination / member.name).open("wb") as target:
                shutil.copyfileobj(source, target)
    manifest = json.loads((destination / "manifest.json").read_text())
    if manifest.get("format") != "fireflint-backup-v1":
        raise OperationError("Unsupported backup format")
    for filename in FILES:
        if digest(destination / filename) != manifest.get("sha256", {}).get(filename):
            raise OperationError(f"Backup checksum mismatch: {filename}")
    keys = json.loads((destination / "keys.json").read_text())
    if set(keys) != set(KEYS) or not all(isinstance(v, str) and v for v in keys.values()):
        raise OperationError("Backup encryption/session keys are missing")
    validate_asset_tar(destination / "assets.tar")
    return keys


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def postgres_environment(database_url):
    """Parse a single-host SQLx URI into libpq env; never put secrets in argv."""
    uri = urlsplit(database_url)
    if uri.scheme not in ("postgres", "postgresql") or not uri.hostname or not uri.path.strip("/"):
        raise OperationError("Backup requires a single-host PostgreSQL URI with an explicit database")
    if uri.fragment or "," in uri.hostname:
        raise OperationError("Backup does not support URI fragments or multi-host PostgreSQL URLs")
    env = {"PGHOST": unquote(uri.hostname), "PGPORT": str(uri.port or 5432),
           "PGDATABASE": unquote(uri.path[1:]), "PGCONNECT_TIMEOUT": "10"}
    if uri.username is not None:
        env["PGUSER"] = unquote(uri.username)
    if uri.password is not None:
        env["PGPASSWORD"] = unquote(uri.password)
    parameters = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT",
                  "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "sslcrl": "PGSSLCRL",
                  "connect_timeout": "PGCONNECT_TIMEOUT", "application_name": "PGAPPNAME",
                  "options": "PGOPTIONS", "target_session_attrs": "PGTARGETSESSIONATTRS"}
    for key, value in parse_qsl(uri.query, keep_blank_values=True):
        if key not in parameters:
            raise OperationError(f"Unsupported PostgreSQL URL option for backup: {key}")
        env[parameters[key]] = value
    if any("\0" in value for value in env.values()):
        raise OperationError("PostgreSQL URL contains a null byte")
    return "\n".join(f"export {key}={shlex.quote(value)}" for key, value in env.items()) + "\n"


class Cluster:
    def __init__(self, args):
        self.args = args
        self.base = ["kubectl", "--context", args.context, "--namespace", args.namespace]
        self.pod = f"{args.name}-maintenance-{uuid.uuid4().hex[:8]}"
        self.created = False

    def k(self, *args, **kwargs):
        return run([*self.base, *args], **kwargs)

    def statefulset(self):
        raw = self.k("get", "statefulset", f"{self.args.name}-api", "--ignore-not-found", "-o", "json",
                     step="read API controller")
        return json.loads(raw) if raw.strip() else None

    def wait_for_no_api(self):
        deadline = time.monotonic() + self.args.timeout
        selector = f"app.kubernetes.io/instance={self.args.name},app.kubernetes.io/component=api"
        while True:
            pods = json.loads(self.k("get", "pods", "-l", selector, "-o", "json", step="wait for API stop"))
            if not pods["items"]:
                return
            if time.monotonic() >= deadline:
                raise OperationError("API did not terminate; no forced deletion was attempted")
            time.sleep(2)

    def helper(self, *, readonly):
        a = self.args
        pod = {
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {"name": self.pod, "labels": {
                "app.kubernetes.io/instance": a.name, "app.kubernetes.io/component": "maintenance"}},
            "spec": {
                "restartPolicy": "Never", "activeDeadlineSeconds": a.timeout,
                "automountServiceAccountToken": False,
                "securityContext": {"runAsNonRoot": True, "runAsUser": 65532, "runAsGroup": 65532,
                                    "fsGroup": 65532, "fsGroupChangePolicy": "OnRootMismatch",
                                    "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [{
                    "name": "tools", "image": a.tools_image, "imagePullPolicy": "IfNotPresent",
                    "command": ["sleep", str(a.timeout)],
                    "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {
                        "name": a.runtime_secret, "key": "database-url"}}}],
                    "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                        "capabilities": {"drop": ["ALL"]}},
                    "resources": {"requests": {"cpu": "100m", "memory": "128Mi"},
                                  "limits": {"cpu": "1", "memory": "512Mi"}},
                    "volumeMounts": [{"name": "assets", "mountPath": "/assets", "readOnly": readonly},
                                     {"name": "tmp", "mountPath": "/tmp"}]}],
                "volumes": [{"name": "assets", "persistentVolumeClaim": {"claimName": a.asset_claim}},
                            {"name": "tmp", "emptyDir": {"sizeLimit": "128Mi"}}]}}
        if a.pull_secret:
            pod["spec"]["imagePullSecrets"] = [{"name": name} for name in a.pull_secret]
        if a.database_ca_secret:
            pod["spec"]["volumes"].append({"name": "database-ca", "secret": {
                "secretName": a.database_ca_secret, "items": [{"key": a.database_ca_key, "path": "ca.crt"}]}})
            pod["spec"]["containers"][0]["volumeMounts"].append({
                "name": "database-ca", "mountPath": "/etc/fireflint/database", "readOnly": True})
        self.k("create", "-f", "-", input_data=json.dumps(pod).encode(), step="create maintenance pod")
        self.created = True
        self.k("wait", "--for=condition=Ready", f"pod/{self.pod}", f"--timeout={a.timeout}s",
               step="wait for maintenance volume mount")
        runtime = json.loads(self.k("get", "secret", a.runtime_secret, "-o", "json", step="read database configuration"))
        database_url = base64.b64decode(runtime["data"]["database-url"], validate=True).decode()
        environment = postgres_environment(database_url)
        self.execute('umask 077; cat > /tmp/fireflint-pg-env', input_data=environment.encode(),
                     step="configure PostgreSQL tools without credential arguments")

    def execute(self, script, **kwargs):
        return self.k("exec", "-i", self.pod, "--", "bash", "-ceu", script, **kwargs)

    def delete_helper(self):
        if self.created:
            self.k("delete", "pod", self.pod, "--wait=true", f"--timeout={self.args.timeout}s",
                   step="release maintenance volume")
            self.created = False


def backup(args, temporary):
    output = Path(args.output).resolve()
    if output.exists() or not output.parent.is_dir():
        raise OperationError("Output must be a new filename in an existing directory")
    cluster = Cluster(args)
    controller = cluster.statefulset()
    if not controller or controller["spec"].get("replicas") != 1:
        raise OperationError("Backup requires the existing single-replica API StatefulSet")
    volumes = controller["spec"]["template"]["spec"]["volumes"]
    claim = next((v.get("persistentVolumeClaim", {}).get("claimName") for v in volumes if v["name"] == "assets"), None)
    if claim != args.asset_claim:
        raise OperationError("Requested asset claim does not match the running API")
    actual = next((e.get("valueFrom", {}).get("secretKeyRef", {}).get("name")
                   for e in controller["spec"]["template"]["spec"]["containers"][0]["env"]
                   if e["name"] == "DATABASE_URL"), None)
    if actual != args.runtime_secret:
        raise OperationError("Requested runtime Secret does not match the running API")
    scaled = False
    try:
        print("Stopping API writes for a consistent database and asset backup.")
        cluster.k("scale", "statefulset", f"{args.name}-api", "--replicas=0", step="stop API")
        scaled = True
        cluster.wait_for_no_api()
        cluster.helper(readonly=True)
        with (temporary / "database.dump").open("wb") as target:
            cluster.execute('source /tmp/fireflint-pg-env; exec pg_dump --no-password -Fc --no-owner --no-acl',
                            stdout=target, step="dump PostgreSQL")
        with (temporary / "assets.tar").open("wb") as target:
            cluster.execute("exec tar -C /assets --exclude='./lost+found' -cf - .",
                            stdout=target, step="archive asset bytes")
        raw = cluster.k("get", "secret", args.runtime_secret, "-o", "json", step="read protected key bundle")
        data = json.loads(raw)["data"]
        if not all(data.get(key) for key in KEYS):
            raise OperationError("Runtime Secret has missing keys")
        (temporary / "keys.json").write_text(json.dumps({key: data[key] for key in KEYS}))
        manifest = {"format": "fireflint-backup-v1", "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "source_namespace": args.namespace, "source_name": args.name,
                    "sha256": {filename: digest(temporary / filename) for filename in FILES}}
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2))
        with tarfile.open(temporary / "backup.tar", "w") as archive:
            for filename in (*FILES, "manifest.json"):
                archive.add(temporary / filename, arcname=filename)
        run(["age", "--recipient", args.recipient, "--output", str(temporary / "backup.age"),
             str(temporary / "backup.tar")], step="encrypt backup")
        # Exclusive creation avoids overwriting another backup, even in a race.
        with output.open("xb") as target, (temporary / "backup.age").open("rb") as source:
            shutil.copyfileobj(source, target)
        os.chmod(output, 0o600)
        print(f"Encrypted backup created: {output}")
    finally:
        # A RWOP volume must be released before the API can return.
        cluster.delete_helper()
        if scaled:
            cluster.k("scale", "statefulset", f"{args.name}-api", "--replicas=1", step="restart API")
            print("API desired replicas restored to one; verify readiness before ending maintenance.")


def restore(args, temporary):
    if not args.confirm_empty_target:
        raise OperationError("Restore requires --confirm-empty-target and an empty database/PVC")
    run(["age", "--decrypt", "--identity", args.identity, "--output", str(temporary / "backup.tar"),
         args.archive], step="decrypt backup")
    keys = unpack_archive(temporary / "backup.tar", temporary)
    cluster = Cluster(args)
    controller = cluster.statefulset()
    if controller and controller["spec"].get("replicas", 1) != 0:
        raise OperationError("Target API must be absent or explicitly stopped before restore")
    cluster.wait_for_no_api()
    target = json.loads(cluster.k("get", "secret", args.runtime_secret, "-o", "json",
                                  step="verify fresh target session key"))
    restored_keys = restore_key_patch(keys, target["data"])
    try:
        cluster.helper(readonly=False)
        count = cluster.execute('source /tmp/fireflint-pg-env; exec psql --no-password -X -At -v ON_ERROR_STOP=1 -c '
                                '"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace '
                                "WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' "
                                "AND c.relkind IN ('r','p','v','m','S','f')\"", step="check empty target database")
        if count.strip() != b"0":
            raise OperationError("Target database already contains user objects; refusing to overwrite")
        existing = cluster.execute('find /assets -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit',
                                   step="check empty target assets")
        if existing.strip():
            raise OperationError("Target asset PVC is not empty; refusing to overwrite")
        with (temporary / "database.dump").open("rb") as source:
            cluster.execute('set -o pipefail; source /tmp/fireflint-pg-env; '
                            'pg_restore --no-owner --no-acl --file=- | '
                            'psql --no-password -X --set=ON_ERROR_STOP=1 --single-transaction', stdin=source,
                            step="restore PostgreSQL into empty target")
        with (temporary / "assets.tar").open("rb") as source:
            cluster.execute('exec tar --strip-components=1 --no-same-owner -C /assets -xf -',
                            stdin=source, step="restore asset bytes without changing the volume mount root")
        patch = temporary / "keys.patch.json"
        patch.write_text(json.dumps({"data": restored_keys}))
        # Preserve the target DB URL and fresh JWT key; restore only the AI key.
        cluster.k("patch", "secret", args.runtime_secret, "--type=merge", "--patch-file", str(patch),
                  step="restore AI encryption key while retaining the fresh session key")
        print("Restored DB, assets and AI key; fresh target JWT retained, interactive clients must sign in again. "
              "Target API remains stopped; validate, then deploy/start it.")
        print("Before starting, reconcile account/password/role and static delivery-token changes since the backup; "
              "historical DB credentials and grants are restored too.")
    finally:
        cluster.delete_helper()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "restore"))
    for name in ("context", "namespace", "name", "runtime-secret", "asset-claim", "tools-image"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--pull-secret", action="append", default=[])
    parser.add_argument("--database-ca-secret")
    parser.add_argument("--database-ca-key", default="ca.crt")
    parser.add_argument("--recipient")
    parser.add_argument("--output")
    parser.add_argument("--archive")
    parser.add_argument("--identity")
    parser.add_argument("--confirm-empty-target", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for name in ("namespace", "name", "runtime_secret", "asset_claim"):
        if not DNS_NAME.fullmatch(getattr(args, name)) or len(getattr(args, name)) > (40 if name == "name" else 63):
            parser.error(f"Invalid Kubernetes name: --{name.replace('_', '-')}")
    if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", args.tools_image):
        parser.error("--tools-image must be a PostgreSQL tools image pinned by sha256 digest")
    if not 60 <= args.timeout <= 86400:
        parser.error("--timeout must be between 60 and 86400 seconds")
    required = ("recipient", "output") if args.operation == "backup" else ("archive", "identity")
    if not all(getattr(args, name) for name in required):
        parser.error("Required for this operation: " + ", ".join(f"--{name}" for name in required))
    if args.dry_run:
        print(f"Plan only: {args.operation}, context={args.context}, namespace={args.namespace}, name={args.name}")
        print("Backup stops API writes and restores desired replicas; restore refuses nonempty targets and keeps API stopped.")
        return
    for binary in ("kubectl", "age"):
        if not shutil.which(binary):
            raise OperationError(f"Required local tool not found: {binary}")
    os.umask(0o077)
    # Plaintext exists only in this private local temporary directory; choose
    # an encrypted filesystem via TMPDIR when the host's /tmp is not suitable.
    with tempfile.TemporaryDirectory(prefix="fireflint-backup-") as directory:
        (backup if args.operation == "backup" else restore)(args, Path(directory))


if __name__ == "__main__":
    try:
        main()
    except (OperationError, OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"FireFlint operation failed: {error}", file=sys.stderr)
        sys.exit(1)
