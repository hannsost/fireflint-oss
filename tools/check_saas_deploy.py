#!/usr/bin/env python3
"""Offline release packaging checks. No cluster, registry, build or secret access."""
import argparse
import ast
import base64
import copy
import json
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required for offline manifest checks")

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "deploy/saas/helm/fireflint"


def command(args, *, success=True, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT,
                            text=True, capture_output=True, env=env)
    if (result.returncode == 0) != success:
        raise AssertionError(f"Unexpected command result: {args[0:3]}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def fixture_values():
    return {
        "runtime": {"existingSecret": "test-runtime"},
        "api": {"image": {"repository": "registry.invalid/fireflint-api", "digest": "sha256:" + "a" * 64}},
        "admin": {"image": {"repository": "registry.invalid/fireflint-admin", "digest": "sha256:" + "b" * 64}},
        "assets": {"storageClass": "test-storage"},
        "ingress": {"className": "test-ingress", "host": "fireflint.invalid", "tlsSecretName": "test-tls"},
        "networkPolicy": {
            "ingressPeers": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ingress"}}}],
            "databasePeers": [{"ipBlock": {"cidr": "192.0.2.10/32"}}]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default=shutil.which("helm"))
    args = parser.parse_args()
    if not args.helm:
        parser.error("Provide --helm /path/to/helm for real offline rendering")
    values = fixture_values()
    with tempfile.TemporaryDirectory(prefix="fireflint-chart-check-") as directory:
        path = Path(directory) / "values.yaml"

        def render(settings, *, success=True):
            path.write_text(yaml.safe_dump(settings))
            result = command([args.helm, "template", "test", CHART, "--namespace", "fireflint-test", "-f", path], success=success)
            return [doc for doc in yaml.safe_load_all(result) if doc] if success else []

        objects = render(values)
        command([args.helm, "lint", CHART, "--strict", "-f", path])
        by_kind = {}
        for obj in objects:
            by_kind.setdefault(obj["kind"], []).append(obj)
        assert set(by_kind) == {"StatefulSet", "Deployment", "Service", "PersistentVolumeClaim", "Ingress", "NetworkPolicy"}
        api = by_kind["StatefulSet"][0]
        admin = by_kind["Deployment"][0]
        assert api["spec"]["replicas"] == 1
        assert api["spec"]["serviceName"] == "test-api-headless"
        assert by_kind["PersistentVolumeClaim"][0]["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep"
        services = {obj["metadata"]["name"]: obj for obj in by_kind["Service"]}
        assert services["test-api"]["spec"].get("clusterIP") != "None"
        assert services["test-api-headless"]["spec"]["clusterIP"] == "None"
        for controller in (api, admin):
            pod = controller["spec"]["template"]["spec"]
            assert pod["automountServiceAccountToken"] is False
            assert pod["securityContext"]["runAsNonRoot"] is True
            for container in [*pod.get("initContainers", []), *pod["containers"]]:
                assert "@sha256:" in container["image"]
                assert container["securityContext"]["readOnlyRootFilesystem"] is True
                assert container["securityContext"]["allowPrivilegeEscalation"] is False
        pod = api["spec"]["template"]["spec"]
        assert pod["initContainers"][0]["args"] == ["migrate"]
        container = pod["containers"][0]
        assert container["args"] == ["serve"]
        assert container["readinessProbe"]["httpGet"]["path"] == "/readyz"
        assert container["livenessProbe"]["httpGet"]["path"] == "/healthz"
        env = {e["name"]: e for e in container["env"]}
        assert env["APP_ENV"]["value"] == "production"
        assert env["SITEGRAPH_LOAD_DOTENV"]["value"] == "0"
        for name in ("DATABASE_URL", "JWT_SECRET", "AI_CONNECTOR_ENCRYPTION_KEY"):
            assert env[name]["valueFrom"]["secretKeyRef"]["name"] == "test-runtime"
        assert by_kind["Ingress"][0]["spec"]["tls"][0]["secretName"] == "test-tls"
        assert not any(name.startswith("OIDC_") for name in env)
        assert "FIREFLINT_CAMPAIGN_DISPATCH_TOKEN" not in env
        assert not any(name.startswith("INSTAGRAM_") for name in env)
        campaigns = copy.deepcopy(values)
        peers = [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "campaign-workers"}}, "podSelector": {"matchLabels": {"app": "draft-worker"}}}]
        campaigns["campaigns"] = {"dispatchExistingSecret": "test-campaign-dispatch", "dispatchSecretKey": "token", "ingressPeers": peers}
        campaign_objects = render(campaigns)
        campaign_pod = next(obj for obj in campaign_objects if obj["kind"] == "StatefulSet")["spec"]["template"]["spec"]
        campaign_env = {entry["name"]: entry for entry in campaign_pod["containers"][0]["env"]}
        assert campaign_env["FIREFLINT_CAMPAIGN_DISPATCH_TOKEN"]["valueFrom"]["secretKeyRef"] == {"name": "test-campaign-dispatch", "key": "token"}
        assert all(entry["name"] != "FIREFLINT_CAMPAIGN_DISPATCH_TOKEN" for entry in campaign_pod["initContainers"][0]["env"])
        campaign_policy = next(obj for obj in campaign_objects if obj["kind"] == "NetworkPolicy" and obj["metadata"]["name"] == "test-api")
        assert {"from": peers, "ports": [{"protocol": "TCP", "port": 8080}]} in campaign_policy["spec"]["ingress"]
        disabled = copy.deepcopy(campaigns)
        disabled["campaigns"]["dispatchExistingSecret"] = ""
        disabled_policy = next(obj for obj in render(disabled) if obj["kind"] == "NetworkPolicy" and obj["metadata"]["name"] == "test-api")
        assert len(disabled_policy["spec"]["ingress"]) == 1
        campaigns["campaigns"]["dispatchExistingSecret"] = "invalid/secret"
        render(campaigns, success=False)

        # Single sign-on must use the public application's origin and an
        # explicit egress route; migration/maintenance do not need IdP secrets.
        oidc = copy.deepcopy(values)
        oidc["oidc"] = {"enabled": True, "issuerUrl": "https://identity.example.test/realms/fireflint",
                        "clientId": "fireflint", "existingSecret": "test-oidc"}
        oidc["networkPolicy"]["oidcPeers"] = [{"ipBlock": {"cidr": "192.0.2.20/32"}}]
        oidc_objects = render(oidc)
        oidc_pod = next(obj for obj in oidc_objects if obj["kind"] == "StatefulSet")["spec"]["template"]["spec"]
        oidc_env = {entry["name"]: entry for entry in oidc_pod["containers"][0]["env"]}
        assert oidc_env["OIDC_REDIRECT_URI"]["value"] == "https://fireflint.invalid/oidc/callback"
        assert oidc_env["OIDC_POST_LOGOUT_REDIRECT_URI"]["value"] == "https://fireflint.invalid/login"
        assert oidc_env["OIDC_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"] == {"name": "test-oidc", "key": "client-secret"}
        assert oidc_env["OIDC_REQUIRE_APP_GROUP"]["value"] == "false"
        restricted_oidc = copy.deepcopy(oidc)
        restricted_oidc["oidc"]["requireAppGroup"] = True
        restricted_api = next(obj for obj in render(restricted_oidc) if obj["kind"] == "StatefulSet")
        restricted_env = {entry["name"]: entry for entry in restricted_api["spec"]["template"]["spec"]["containers"][0]["env"]}
        assert restricted_env["OIDC_REQUIRE_APP_GROUP"]["value"] == "true"
        restricted_oidc["oidc"]["requireAppGroup"] = "true"
        render(restricted_oidc, success=False)
        assert not any(entry["name"].startswith("OIDC_") for entry in oidc_pod["initContainers"][0]["env"])
        policy = next(obj for obj in oidc_objects if obj["kind"] == "NetworkPolicy" and obj["metadata"]["name"] == "test-api")
        assert {"to": oidc["networkPolicy"]["oidcPeers"], "ports": [{"protocol": "TCP", "port": 443}]} in policy["spec"]["egress"]
        public_oidc = copy.deepcopy(oidc)
        public_oidc["networkPolicy"].update(oidcPeers=[], allowPublicHTTPS=True)
        render(public_oidc)
        for section, key, invalid in [("oidc", "issuerUrl", "http://identity.example.test"),
                                      ("oidc", "clientId", ""), ("oidc", "existingSecret", ""),
                                      ("networkPolicy", "oidcPeers", [])]:
            bad = copy.deepcopy(oidc)
            bad[section][key] = invalid
            render(bad, success=False)

        instagram = copy.deepcopy(values)
        instagram["instagram"] = {"enabled": True, "existingSecret": "test-instagram", "apiVersion": "v24.0"}
        instagram["networkPolicy"]["allowPublicHTTPS"] = True
        instagram_objects = render(instagram)
        instagram_api = next(obj for obj in instagram_objects if obj["kind"] == "StatefulSet")
        instagram_pod = instagram_api["spec"]["template"]["spec"]
        instagram_env = {entry["name"]: entry for entry in instagram_pod["containers"][0]["env"]}
        assert instagram_env["INSTAGRAM_APP_ID"]["valueFrom"]["secretKeyRef"] == {"name": "test-instagram", "key": "app-id"}
        assert instagram_env["INSTAGRAM_APP_SECRET"]["valueFrom"]["secretKeyRef"] == {"name": "test-instagram", "key": "app-secret"}
        assert instagram_env["INSTAGRAM_PUBLIC_ORIGIN"]["value"] == "https://fireflint.invalid"
        assert instagram_env["INSTAGRAM_API_VERSION"]["value"] == "v24.0"
        assert instagram_env["INSTAGRAM_LOGIN_MODE"]["value"] == "instagram_login"
        assert "INSTAGRAM_CONFIG_ID" not in instagram_env
        assert "INSTAGRAM_WEBHOOK_VERIFY_TOKEN" not in instagram_env
        assert not any(entry["name"].startswith("INSTAGRAM_") for entry in instagram_pod["initContainers"][0]["env"])
        for section, key, invalid in [("instagram", "existingSecret", ""), ("instagram", "apiVersion", ""),
                                      ("instagram", "apiVersion", "latest"), ("networkPolicy", "allowPublicHTTPS", False)]:
            bad = copy.deepcopy(instagram)
            bad[section][key] = invalid
            render(bad, success=False)

        # Unified credentials and configuration must not be silently treated as
        # a legacy Instagram Login grant. The verifier stays in a Secret.
        unified = copy.deepcopy(instagram)
        unified["instagram"].update(loginMode="unified", configurationId="123456789012345",
                                    webhookVerifyTokenSecretKey="business-webhook-verifier")
        unified_objects = render(unified)
        unified_pod = next(obj for obj in unified_objects if obj["kind"] == "StatefulSet")["spec"]["template"]["spec"]
        unified_env = {entry["name"]: entry for entry in unified_pod["containers"][0]["env"]}
        assert unified_env["INSTAGRAM_LOGIN_MODE"]["value"] == "unified"
        assert unified_env["INSTAGRAM_CONFIG_ID"]["value"] == "123456789012345"
        assert unified_env["INSTAGRAM_WEBHOOK_VERIFY_TOKEN"]["valueFrom"]["secretKeyRef"] == {
            "name": "test-instagram", "key": "business-webhook-verifier"}
        assert not any(entry["name"].startswith("INSTAGRAM_") for entry in unified_pod["initContainers"][0]["env"])
        for source, key, invalid in [(unified, "configurationId", ""),
                                     (unified, "configurationId", "123?scope=ads_management"),
                                     (unified, "configurationId", 123),
                                     (unified, "webhookVerifyTokenSecretKey", ""),
                                     (unified, "loginMode", "automatic"),
                                     (instagram, "configurationId", "123")]:
            bad = copy.deepcopy(source)
            bad["instagram"][key] = invalid
            render(bad, success=False)

        boot = copy.deepcopy(values)
        boot["bootstrap"] = {"enabled": True, "existingSecret": "test-bootstrap", "runId": "check"}
        job = next(obj for obj in render(boot) if obj["kind"] == "Job")
        bootstrap = job["spec"]["template"]["spec"]["containers"][0]
        assert bootstrap["args"] == ["bootstrap-admin"]
        names = {entry["name"] for entry in bootstrap["env"]}
        assert {"BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_ADMIN_ORG_NAME", "BOOTSTRAP_ADMIN_ORG_SLUG"} <= names
        existing = copy.deepcopy(values)
        existing["assets"] = {"existingClaim": "restored-assets", "storageClass": ""}
        assert all(obj["kind"] != "PersistentVolumeClaim" for obj in render(existing))
        ca = copy.deepcopy(boot)
        ca["database"] = {"caSecret": "test-ca", "caKey": "root.crt"}
        for obj in render(ca):
            if obj["kind"] not in ("StatefulSet", "Job"):
                continue
            ca_pod = obj["spec"]["template"]["spec"]
            assert any(v["name"] == "database-ca" for v in ca_pod["volumes"])
            for c in [*ca_pod["initContainers"], *ca_pod["containers"]]:
                assert any(v["mountPath"] == "/etc/fireflint/database" for v in c["volumeMounts"])

        negative = [
            ("api", "replicas", 2), ("runtime", "existingSecret", ""),
            ("ingress", "tlsSecretName", ""), ("ingress", "host", "http://bad"),
            ("networkPolicy", "databasePeers", []), ("networkPolicy", "ingressPeers", []),
            ("assets", "storageClass", ""),
        ]
        for section, key, invalid in negative:
            bad = copy.deepcopy(values)
            bad.setdefault(section, {})[key] = invalid
            render(bad, success=False)
        bad = copy.deepcopy(values)
        bad["api"]["image"]["digest"] = "latest"
        render(bad, success=False)
        render({}, success=False)
        print("PASS Helm lint/render, production guards, bootstrap, retained/existing PVC, OIDC and both Instagram login modes with invalid configuration rejection")

    nginx = (ROOT / "deploy/saas/nginx.conf.template").read_text()
    assert "proxy_cache off;" in nginx
    assert "private, no-store" in nginx
    assert "location /_static/" in nginx and "location /assets/" in nginx
    log_format = next(line for line in nginx.splitlines() if "log_format" in line)
    assert "$request_uri" not in log_format and "$request " not in log_format and "$uri " in log_format
    assert "envsubst '${API_UPSTREAM}'" in (ROOT / "deploy/saas/admin-entrypoint.sh").read_text()
    for block in nginx.split("location ")[1:]:
        if "add_header " in block:
            assert "include /etc/fireflint/security-headers.conf;" in block
    headers = (ROOT / "deploy/saas/nginx-security-headers.conf").read_text()
    assert "Content-Security-Policy" in headers and "script-src 'self'" in headers
    command(["sh", "-n", ROOT / "deploy/saas/admin-entrypoint.sh"])
    # Parse without emitting a pyc into the repository.
    ops = (ROOT / "deploy/saas/ops.py").read_text()
    compile(ops, "ops.py", "exec")
    namespace = {"__name__": "fireflint_ops_check"}
    exec(compile(ops, "ops.py", "exec"), namespace)
    pg_env = namespace["postgres_environment"]("postgresql://test:p%27%24%28false%29%40@db.invalid:5433/fireflint?sslmode=verify-full")
    quoted = subprocess.run(["bash"], input=pg_env + 'printf "%s" "$PGPASSWORD"', text=True, capture_output=True)
    assert quoted.returncode == 0 and quoted.stdout == "p'$(false)@"
    with tempfile.TemporaryDirectory(prefix="fireflint-archive-check-") as archive_directory:
        archive_path = Path(archive_directory) / "assets.tar"
        for unsafe_name, symlink in [("../escape", False), ("/absolute", False), ("link", True), ("unprefixed", False)]:
            with tarfile.open(archive_path, "w") as archive:
                member = tarfile.TarInfo(unsafe_name)
                if symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/tmp/never-opened"
                archive.addfile(member, io.BytesIO())
            try:
                namespace["validate_asset_tar"](archive_path)
            except namespace["OperationError"]:
                pass
            else:
                raise AssertionError("Unsafe archive was accepted")
        with tarfile.open(archive_path, "w") as archive:
            member = tarfile.TarInfo("./org/file")
            member.size = 3
            archive.addfile(member, io.BytesIO(b"abc"))
        namespace["validate_asset_tar"](archive_path)
    encoded = lambda value: base64.b64encode(value.encode()).decode()
    backup_keys = {"jwt-secret": encoded("historical-jwt-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
                   "ai-connector-encryption-key": encoded("persistent-ai-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ")}
    fresh_jwt = encoded("fresh-target-jwt-9876543210-ZYXWVUTSRQPONMLKJIHGFEDCBA")
    assert namespace["restore_key_patch"](backup_keys, {"jwt-secret": fresh_jwt}) == {
        "ai-connector-encryption-key": backup_keys["ai-connector-encryption-key"]}
    for invalid_jwt in (backup_keys["jwt-secret"], backup_keys["ai-connector-encryption-key"], encoded("weak")):
        try:
            namespace["restore_key_patch"](backup_keys, {"jwt-secret": invalid_jwt})
        except namespace["OperationError"]:
            pass
        else:
            raise AssertionError("Restore accepted a reused or weak JWT key")
    for node in ast.walk(ast.parse(ops)):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "execute" and node.args:
            script = ast.literal_eval(node.args[0])
            result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
            assert result.returncode == 0, result.stderr
    command([sys.executable, ROOT / "deploy/saas/ops.py", "backup", "--dry-run",
             "--context", "never-contact", "--namespace", "test", "--name", "test",
             "--runtime-secret", "test-runtime", "--asset-claim", "test-assets",
             "--tools-image", "postgres@sha256:" + "c" * 64,
             "--recipient", "age1fixture", "--output", "/tmp/never-written.age"])
    compose = yaml.safe_load((ROOT / "deploy/saas/compose.yaml").read_text())
    assert "ports" not in compose["services"]["db"] and "ports" not in compose["services"]["api"]
    assert compose["networks"]["private"]["internal"] is True
    assert compose["services"]["api"]["environment"]["APP_ENV"] == "production"
    if shutil.which("docker"):
        environment = dict(os.environ, FIXTURE_DB_PASSWORD="f" * 48,
                           FIXTURE_JWT_SECRET="0123456789abcdefghijklmnopqrstuv",  # gitleaks:allow (synthetic fixture)
                           FIXTURE_AI_KEY="ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")
        command(["docker", "compose", "--env-file", "/dev/null", "-f", ROOT / "deploy/saas/compose.yaml", "config", "--quiet"], env=environment)
        print("PASS Docker Compose configuration (no daemon/build/start)")
    print("PASS nginx/entrypoint contracts, operations CLI dry-run and isolated production fixture")


if __name__ == "__main__":
    main()
