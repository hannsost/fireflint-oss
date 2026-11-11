#!/usr/bin/env python3
"""Exercise production lifecycle against one explicitly disposable local database.

Requires the dedicated fireflint-release-db Podman container on loopback:15433.
Never loads .env, accepts real credentials, touches another database, or emits
generated application secrets. Run with the already-built --binary path. An
existing test database requires the explicit --reset-test-database flag.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
CONTAINER = "fireflint-release-db"
DATABASE = "fireflint_production_test"
DB_USER = "fireflint_test"
DB_PASSWORD = "release-tests-only"  # Public, dedicated disposable test fixture.
DATABASE_URL = f"postgres://{DB_USER}:{DB_PASSWORD}@127.0.0.1:15433/{DATABASE}"
ADMIN_EMAIL = "lifecycle-admin@example.test"
ORG_SLUG = "production-lifecycle-fixture"


class Harness:
    def __init__(self, binary, report):
        self.binary = str(binary.resolve())
        self.report = report
        self.secret_values = set()
        self.results = []
        # Do not inherit application credentials or read configuration files.
        self.process_env = {
            name: os.environ[name]
            for name in ("PATH", "HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")
            if name in os.environ
        }
        self.env = {
            **self.process_env,
            "SITEGRAPH_LOAD_DOTENV": "0",
            "APP_ENV": "production",
            "DATABASE_URL": DATABASE_URL,
            "JWT_SECRET": self.secret(),
            "AI_CONNECTOR_ENCRYPTION_KEY": self.secret(),
            "CORS_ALLOWED_ORIGINS": "https://admin.example.test",
            "RUST_LOG": "info,sqlx=warn",
        }
        self.password = self.secret()
        self.bootstrap = {
            "BOOTSTRAP_ADMIN_EMAIL": ADMIN_EMAIL,
            "BOOTSTRAP_ADMIN_PASSWORD": self.password,
            "BOOTSTRAP_ADMIN_ORG_NAME": "Production lifecycle fixture",
            "BOOTSTRAP_ADMIN_ORG_SLUG": ORG_SLUG,
        }
        self.server = None
        self.base = None
        self.http_client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def secret(self):
        value = secrets.token_urlsafe(48)
        self.secret_values.add(value)
        return value

    def redact(self, text):
        for value in sorted(self.secret_values, key=len, reverse=True):
            text = text.replace(value, "[REDACTED]")
        return text

    def remember_tokens(self, value):
        if isinstance(value, dict):
            for key, entry in value.items():
                if key in ("access_token", "refresh_token", "password_hash") and isinstance(entry, str):
                    self.secret_values.add(entry)
                else:
                    self.remember_tokens(entry)
        elif isinstance(value, list):
            for entry in value:
                self.remember_tokens(entry)

    def check(self, name, action):
        started = time.monotonic()
        try:
            action()
        except Exception as error:
            detail = self.redact(str(error))[:1500]
            self.results.append({"name": name, "status": "failed", "error": detail})
            self.write_report()
            raise AssertionError(f"{name}: {detail}") from None
        self.results.append({"name": name, "status": "passed", "seconds": round(time.monotonic() - started, 3)})
        print(f"PASS {name}", flush=True)
        self.write_report()

    def write_report(self):
        if self.report:
            self.report.write_text(json.dumps({
                "database": DATABASE,
                "database_port": 15433,
                "credentials": "random application secrets held only in process environment/memory; not recorded",
                "checks": self.results,
            }, indent=2) + "\n")

    def sql(self, query, *, database=DATABASE):
        if database not in (DATABASE, "postgres"):
            raise AssertionError("refusing a non-test database")
        result = subprocess.run([
            "podman", "exec", "-i", "--env", "PGPASSWORD", CONTAINER,
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", DB_USER, "-d", database,
        ], input=query, text=True, capture_output=True, timeout=20,
            env={**self.process_env, "PGPASSWORD": DB_PASSWORD})
        if result.returncode:
            raise AssertionError(f"test-database SQL failed: {self.redact(result.stderr)}")
        return result.stdout.strip()

    def command(self, command, overrides=None, *, expected_error=None):
        env = {**self.env, **(overrides or {})}
        env = {key: value for key, value in env.items() if value is not None}
        result = subprocess.run([self.binary, command], env=env, cwd=ROOT,
                                stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=20)
        output = result.stdout + result.stderr
        if expected_error is None:
            if result.returncode:
                raise AssertionError(f"{command} unexpectedly failed: {self.redact(output)}")
        elif result.returncode == 0 or expected_error not in output:
            raise AssertionError(f"{command} must reject {expected_error}: {self.redact(output)}")
        return output

    def http(self, path, data=None, token=None, *, timeout=6):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self.base + path, headers=headers,
                                         data=None if data is None else json.dumps(data).encode())
        try:
            response = self.http_client.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            value = json.loads(body) if body else None
            self.remember_tokens(value)
            return response.status, value

    def expect_http(self, status, path, data=None, token=None):
        actual, value = self.http(path, data, token)
        if actual != status:
            raise AssertionError(f"{path}: expected {status}, got {actual}: {self.redact(json.dumps(value))}")
        return value

    def start_server(self, assets):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        env = {**self.env, "BIND": f"127.0.0.1:{port}", "ASSET_DIR": str(assets)}
        self.server = subprocess.Popen([self.binary, "serve"], cwd=ROOT, env=env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                raise AssertionError(f"production server exited: {self.redact(self.server.communicate()[0])}")
            try:
                if self.http("/readyz")[0] == 200:
                    return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        raise AssertionError("production server did not become ready")

    def stop_server(self, *, verify=False):
        if self.server is None:
            return
        process, self.server = self.server, None
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError("SIGTERM did not stop the test server within 10 seconds") from None
        if verify and (process.returncode != 0 or "shutdown signal received" not in output):
            raise AssertionError(f"SIGTERM did not exit cleanly: {self.redact(output)}")

    def snapshot(self):
        return json.loads(self.sql("""
            SELECT json_build_object(
                'users', (SELECT count(*) FROM users),
                'tokens', (SELECT count(*) FROM api_tokens),
                'markers', (SELECT count(*) FROM installation_bootstrap),
                'workspace', (SELECT count(*) FROM organizations WHERE slug='production-lifecycle-fixture'),
                'owners', (SELECT count(*) FROM memberships m JOIN organizations o ON o.id=m.org_id
                          WHERE o.slug='production-lifecycle-fixture' AND m.role='owner'));
        """))

    def run(self, reset):
        mapping = subprocess.run(["podman", "port", CONTAINER, "5432/tcp"], env=self.process_env,
                                 text=True, capture_output=True, check=True).stdout.strip()
        assert mapping == "127.0.0.1:15433", "dedicated database must bind only loopback:15433"
        exists = self.sql(f"SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='{DATABASE}');", database="postgres") == "t"
        if exists and not reset:
            raise AssertionError("test database already exists; use --reset-test-database explicitly to recreate only this disposable fixture")
        if exists:
            self.sql(f"DROP DATABASE {DATABASE} WITH (FORCE);", database="postgres")
        self.sql(f"CREATE DATABASE {DATABASE};", database="postgres")

        invalid = [
            ("production-default-credentials", {"JWT_SECRET": None, "AI_CONNECTOR_ENCRYPTION_KEY": None, "CORS_ALLOWED_ORIGINS": None}, "JWT_SECRET"),
            ("weak-jwt-key", {"JWT_SECRET": "short"}, "JWT_SECRET"),
            ("low-entropy-jwt-key", {"JWT_SECRET": "a" * 64}, "JWT_SECRET"),
            ("missing-encryption-key", {"AI_CONNECTOR_ENCRYPTION_KEY": None}, "AI_CONNECTOR_ENCRYPTION_KEY"),
            ("weak-encryption-key", {"AI_CONNECTOR_ENCRYPTION_KEY": "short"}, "AI_CONNECTOR_ENCRYPTION_KEY"),
            ("shared-signing-encryption-key", {"AI_CONNECTOR_ENCRYPTION_KEY": self.env["JWT_SECRET"]}, "must be distinct"),
            ("missing-cors", {"CORS_ALLOWED_ORIGINS": None}, "explicit HTTPS origins"),
            ("wildcard-cors", {"CORS_ALLOWED_ORIGINS": "*"}, "explicit HTTPS origins"),
            ("http-cors", {"CORS_ALLOWED_ORIGINS": "http://admin.example.test"}, "explicit HTTPS origins"),
            ("path-in-cors", {"CORS_ALLOWED_ORIGINS": "https://admin.example.test/path"}, "explicit HTTPS origins"),
            ("unknown-app-env", {"APP_ENV": "staging-typo"}, "APP_ENV must be"),
            ("production-private-webhook-override", {"WEBHOOK_ALLOW_PRIVATE": "true"}, "development-only"),
        ]
        for name, overrides, error in invalid:
            self.check(name, lambda overrides=overrides, error=error: self.command("serve", overrides, expected_error=error))

        def migrate():
            self.command("migrate")
            assert self.snapshot() == {"users": 0, "tokens": 0, "markers": 0, "workspace": 0, "owners": 0}
            self.command("migrate")
            assert self.snapshot()["users"] == 0 and self.snapshot()["tokens"] == 0
        self.check("migrate-is-repeatable-without-users-or-delivery-tokens", migrate)

        def bootstrap():
            self.command("bootstrap-admin", self.bootstrap)
            assert self.snapshot() == {"users": 1, "tokens": 0, "markers": 1, "workspace": 1, "owners": 1}
            assert self.sql("SELECT is_platform_admin FROM users WHERE email='lifecycle-admin@example.test';") == "t"
            assert self.sql("SELECT count(*) FROM memberships WHERE org_id=(SELECT id FROM organizations WHERE slug='production-lifecycle-fixture');") == "1"
        self.check("bootstrap-creates-one-admin-and-private-workspace", bootstrap)
        self.admin_id = self.sql("SELECT id FROM users WHERE email='lifecycle-admin@example.test';")
        self.org_id = self.sql("SELECT id FROM organizations WHERE slug='production-lifecycle-fixture';")
        original_hash = self.sql(f"SELECT password_hash FROM users WHERE id='{self.admin_id}';")
        self.secret_values.add(original_hash)

        def repeat():
            self.command("bootstrap-admin", {**self.bootstrap, "BOOTSTRAP_ADMIN_PASSWORD": self.secret()})
            assert self.sql(f"SELECT password_hash FROM users WHERE id='{self.admin_id}';") == original_hash
            assert self.snapshot() == {"users": 1, "tokens": 0, "markers": 1, "workspace": 1, "owners": 1}
        self.check("repeat-bootstrap-does-not-reset-password-or-duplicate-account", repeat)

        def changed_identity():
            for override in [{"BOOTSTRAP_ADMIN_EMAIL": "other@example.test"}, {"BOOTSTRAP_ADMIN_ORG_SLUG": "other-workspace"}]:
                self.command("bootstrap-admin", {**self.bootstrap, **override}, expected_error="will not recreate accounts")
            assert self.snapshot()["users"] == 1 and self.snapshot()["workspace"] == 1
        self.check("bootstrap-refuses-changed-account-or-workspace-identity", changed_identity)

        def revoked_roles():
            self.sql(f"UPDATE users SET is_platform_admin=false WHERE id='{self.admin_id}';")
            self.command("bootstrap-admin", self.bootstrap, expected_error="will not recreate accounts")
            assert self.sql(f"SELECT is_platform_admin FROM users WHERE id='{self.admin_id}';") == "f"
            self.sql(f"UPDATE users SET is_platform_admin=true WHERE id='{self.admin_id}';")
            self.sql(f"UPDATE memberships SET role='viewer' WHERE user_id='{self.admin_id}' AND org_id='{self.org_id}';")
            self.command("bootstrap-admin", self.bootstrap, expected_error="will not recreate accounts")
            assert self.sql(f"SELECT role FROM memberships WHERE user_id='{self.admin_id}' AND org_id='{self.org_id}';") == "viewer"
            self.sql(f"UPDATE memberships SET role='owner' WHERE user_id='{self.admin_id}' AND org_id='{self.org_id}';")
        self.check("bootstrap-does-not-restore-revoked-platform-or-workspace-roles", revoked_roles)

        with tempfile.TemporaryDirectory(prefix="fireflint-production-assets-") as assets:
            self.check("production-server-starts-and-readyz-is-healthy", lambda: self.start_server(assets))
            tokens = self.expect_http(200, "/auth/login", {"email": ADMIN_EMAIL, "password": self.password})
            self.expect_http(200, "/api/me", token=tokens["access_token"])
            def reset_password():
                replacement = self.secret()
                self.command("reset-password", {"RESET_ACCOUNT_EMAIL": ADMIN_EMAIL, "RESET_ACCOUNT_PASSWORD": replacement})
                assert self.sql(f"SELECT session_version FROM users WHERE id='{self.admin_id}';") == "1"
                self.expect_http(401, "/api/me", token=tokens["access_token"])
                self.expect_http(401, "/auth/refresh", {"refresh_token": tokens["refresh_token"]})
                self.expect_http(401, "/auth/login", {"email": ADMIN_EMAIL, "password": self.password})
                fresh = self.expect_http(200, "/auth/login", {"email": ADMIN_EMAIL, "password": replacement})
                self.expect_http(200, "/api/me", token=fresh["access_token"])
                self.password = replacement
            self.check("operator-reset-revokes-old-jwts-and-allows-new-login", reset_password)

            def database_failure():
                self.sql(f"ALTER DATABASE {DATABASE} ALLOW_CONNECTIONS false;", database="postgres")
                try:
                    self.sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{DATABASE}';", database="postgres")
                    started = time.monotonic()
                    status, body = self.http("/readyz", timeout=5)
                    assert status == 503 and body == {"status": "unavailable"}
                    assert time.monotonic() - started < 3, "readiness must fail promptly when DB is unavailable"
                    self.expect_http(200, "/healthz")
                finally:
                    self.sql(f"ALTER DATABASE {DATABASE} ALLOW_CONNECTIONS true;", database="postgres")
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if self.http("/readyz")[0] == 200:
                        return
                    time.sleep(0.2)
                raise AssertionError("readiness did not recover after test database became available")
            self.check("readyz-fails-promptly-and-recovers-while-healthz-stays-live", database_failure)
            self.check("sigterm-drains-and-exits-with-status-zero", lambda: self.stop_server(verify=True))

        def demo_database():
            demo_id = "00000000-0000-0000-0000-00000000000a"
            self.sql(f"INSERT INTO users(id,email,name,password_hash) VALUES('{demo_id}','owner@demo.test','Disposable demo guard fixture','not-a-login-hash');")
            try:
                self.command("serve", expected_error="known demo accounts/delivery credentials")
            finally:
                self.sql(f"DELETE FROM users WHERE id='{demo_id}' AND email='owner@demo.test';")
            token_hash = hashlib.sha256(b"sg_demo_token").hexdigest()
            self.sql(f"INSERT INTO api_tokens(org_id,name,token_hash) VALUES('{self.org_id}','disposable-demo-guard','{token_hash}');")
            try:
                self.command("serve", expected_error="known demo accounts/delivery credentials")
            finally:
                self.sql(f"DELETE FROM api_tokens WHERE name='disposable-demo-guard' AND token_hash='{token_hash}';")
            assert self.snapshot()["users"] == 1 and self.snapshot()["tokens"] == 0
        self.check("production-rejects-both-demo-account-and-known-demo-token", demo_database)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--reset-test-database", action="store_true", help="Recreate only fireflint_production_test; destroys that disposable fixture")
    args = parser.parse_args()
    if not args.binary.is_file():
        parser.error("--binary must point to an already-built sitegraph executable")
    harness = Harness(args.binary, args.report)
    try:
        harness.run(args.reset_test_database)
    except Exception as error:
        print(f"FAIL {harness.redact(str(error))}", file=sys.stderr, flush=True)
        return 1
    finally:
        harness.stop_server()
    print(f"PASS {len(harness.results)} production lifecycle checks; no generated secrets recorded", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
