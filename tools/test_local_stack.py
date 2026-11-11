#!/usr/bin/env python3
"""Real /proc lifecycle regression; network responses are controlled, no ports bound.

Run from the project: python3 tools/test_local_stack.py
All fixtures live under data/local and only fixture children are terminated.
"""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "tools/local-stack.sh"
NODE = shutil.which("node")
OWN_LISTENER = '''
ss() {
  if owned "$service"; then
    printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:* users:(("fixture",pid=%s,fd=3))\\n' "$port" "$(tracked_pid "$service")"
  fi
}
curl() { touch http-probed; }
'''


class LocalStackTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "data/local").mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="startup-test-", dir=ROOT / "data/local")
        self.path = Path(self.temp.name)
        self.children = []
        self.detached = []
        for directory in ("data/local", "logs", "target/debug", "admin/node_modules/vite/bin", "tools"):
            (self.path / directory).mkdir(parents=True)
        self.vite = self.path / "admin/node_modules/vite/bin/vite.js"
        self.vite.write_text("setInterval(() => {}, 1000);\n")
        self.core = self.path / "target/debug/sitegraph"
        shutil.copy2(shutil.which("sleep"), self.core)
        (self.path / "tools/local-stack.sh").symlink_to(HELPER)
        for script in ("run-local.sh", "stop-local.sh"):
            shutil.copy2(ROOT / script, self.path / script)

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        for pid in self.detached:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.temp.cleanup()

    def spawn(self, command, service="admin", cwd=None):
        child = subprocess.Popen(command, cwd=cwd or self.path, start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        self.children.append(child)
        (self.path / f"data/local/{service}.pid").write_text(f"{child.pid}\n")
        return child

    def admin(self):
        return self.spawn([NODE, str(self.vite), "admin", "--host", "0.0.0.0", "--port", "5174", "--strictPort"])

    def bash(self, body, service="admin", ok=True):
        prelude = f'set -euo pipefail\nsource "{HELPER}"\nservice={service}\nport={5174 if service == "admin" else 8090}\n'
        result = subprocess.run(["bash", "-c", prelude + body], cwd=self.path,
                                text=True, capture_output=True, timeout=8)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_delayed_exec_for_both_services(self):
        for service in ("core", "admin"):
            with self.subTest(service=service):
                command = ('exec "$PWD/target/debug/sitegraph" 30' if service == "core" else
                           'exec node "$PWD/admin/node_modules/vite/bin/vite.js" admin --host 0.0.0.0 --port 5174 --strictPort')
                child = self.spawn(["bash", "-c", f'while [[ ! -f allow-{service} ]]; do sleep 0.01; done; sleep 0.6; ' + command], service)
                started = time.monotonic()
                self.bash(OWN_LISTENER + '''
! owned "$service"
process_generation "$(tracked_pid "$service")" >/dev/null
touch "allow-$service"
wait_http "$service" http://fixture/ "$port" true 3
owned "$service"
''', service)
                self.assertGreater(time.monotonic() - started, 0.5)
                self.assertIsNone(child.poll())

    def test_existing_foreign_program_is_not_granted_startup_grace(self):
        child = self.spawn([shutil.which("python3"), "-c", "import time; time.sleep(30)", str(self.vite)])
        result = self.bash(OWN_LISTENER + 'check_service_slot admin 5174', ok=False)
        self.assertIn("does not match", result.stderr)
        self.assertIsNone(child.poll())
        self.assertFalse((self.path / "http-probed").exists())

    def test_node_with_vite_as_an_unrelated_argument_is_foreign(self):
        self.spawn([NODE, "-e", "setInterval(() => {}, 1000)", str(self.vite)])
        self.bash('! owned admin')

    def test_different_working_directory_is_foreign(self):
        child = self.spawn([NODE, str(self.vite), "admin", "--host", "0.0.0.0", "--port", "5174", "--strictPort"], cwd=self.path / "tools")
        self.bash('! owned admin')
        self.assertIsNone(child.poll())

    def test_foreign_listener_cannot_supply_readiness(self):
        child = self.admin()
        result = self.bash('''
ss() { echo 'LISTEN 0 128 0.0.0.0:5174 0.0.0.0:* users:(("foreign",pid=1,fd=3))'; }
curl() { touch http-probed; }
wait_http admin http://fixture/ 5174 true 2
''', ok=False)
        self.assertIn("untracked process", result.stderr)
        self.assertFalse((self.path / "http-probed").exists())
        self.assertIsNone(child.poll())

    def test_loopback_only_listener_is_rejected(self):
        self.admin()
        self.bash(OWN_LISTENER.replace("0.0.0.0:%s", "127.0.0.1:%s") +
                  'wait_http admin http://fixture/ 5174 true 2', ok=False)
        self.assertFalse((self.path / "http-probed").exists())

    def test_exit_before_readiness_is_reported(self):
        self.spawn(["bash", "-c", "sleep 0.3; exit 7"])
        result = self.bash(OWN_LISTENER + 'wait_http admin http://fixture/ 5174 true 3', ok=False)
        self.assertIn("exited", result.stderr)
        self.assertFalse((self.path / "http-probed").exists())

    def test_zombie_and_stale_pid_are_not_live(self):
        child = self.spawn(["true"])
        # Deliberately do not poll/wait: the unreaped child is a zombie in /proc.
        deadline = time.monotonic() + 3
        while Path(f"/proc/{child.pid}/stat").read_text().rsplit(") ", 1)[1].split()[0] != "Z":
            self.assertLess(time.monotonic(), deadline, "Fixture did not exit")
            time.sleep(0.01)
        self.bash(f'! process_generation {child.pid}')
        child.wait(timeout=2)
        self.bash('ss() { :; }; check_service_slot admin 5174')
        result = self.bash('wait_http admin http://fixture/ 5174 true 2', ok=False)
        self.assertIn("exited", result.stderr)

    def test_timeout_keeps_pid_and_retry_reuses_process(self):
        child = self.admin()
        started = time.monotonic()
        result = self.bash(OWN_LISTENER + '''
curl() { return 22; }
wait_http admin http://fixture/ 5174 true 1
''', ok=False)
        self.assertIn("timed out", result.stderr)
        self.assertLess(time.monotonic() - started, 2.5)
        self.bash(OWN_LISTENER + 'check_service_slot admin 5174; wait_http admin http://fixture/ 5174 false 2')
        self.assertEqual((self.path / "data/local/admin.pid").read_text().strip(), str(child.pid))
        self.assertIsNone(child.poll())

    def test_unidentified_child_times_out_and_blocks_duplicate_start(self):
        child = self.spawn(["sleep", "30"])
        result = self.bash('ss() { :; }; wait_http admin http://fixture/ 5174 true 1', ok=False)
        self.assertIn("timed out", result.stderr)
        self.bash('ss() { :; }; check_service_slot admin 5174', ok=False)
        self.assertIsNone(child.poll())

    def test_death_during_successful_http_probe_is_not_success(self):
        self.admin()
        result = self.bash(OWN_LISTENER + '''
curl() { kill -KILL "$(tracked_pid admin)"; sleep 0.1; }
wait_http admin http://fixture/ 5174 false 2
''', ok=False)
        self.assertIn("exited", result.stderr)

    def test_identity_change_after_recognition_is_rejected(self):
        shutil.copy2(shutil.which("bash"), self.core)
        self.spawn([str(self.core), "-c", 'while [[ ! -f switch-exec ]]; do sleep 0.01; done; exec sleep 30'], "core")
        result = self.bash(OWN_LISTENER + '''
curl() { touch switch-exec; sleep 0.1; return 22; }
wait_http core http://fixture/ 8090 true 2
''', service="core", ok=False)
        self.assertIn("does not match", result.stderr)

    def test_readiness_limit_does_not_truncate_partial_seconds(self):
        self.spawn(["bash", "-c", 'sleep 1.5; exec node "$PWD/admin/node_modules/vite/bin/vite.js" admin --host 0.0.0.0 --port 5174 --strictPort'])
        self.bash(OWN_LISTENER + '''
sleep 0.7
wait_http admin http://fixture/ 5174 true 1
''')

    def test_launch_and_repeated_start_preserve_pid_with_job_control(self):
        try:
            self.bash(OWN_LISTENER + '''
set -m
launch_service admin node "$PWD/admin/node_modules/vite/bin/vite.js" admin --host 0.0.0.0 --port 5174 --strictPort
wait_http admin http://fixture/ 5174 true 3
original=$(tracked_pid admin)
for ((i=0; i<3; i++)); do
  check_service_slot admin 5174
  owned admin
  wait_http admin http://fixture/ 5174 false 2
  [[ "$(tracked_pid admin)" == "$original" ]]
done
''')
        finally:
            path = self.path / "data/local/admin.pid"
            if path.exists():
                self.detached.append(int(path.read_text()))
        self.assertEqual(os.getsid(self.detached[0]), self.detached[0])

    def test_stop_rejects_foreign_pid_and_preserves_it(self):
        child = self.spawn(["sleep", "30"])
        result = self.bash('./stop-local.sh')
        self.assertIn("Ignoring admin PID", result.stderr)
        self.assertIsNone(child.poll())
        self.assertTrue((self.path / "data/local/admin.pid").exists())

    def test_stop_cleans_owned_and_dead_processes(self):
        child = self.admin()
        self.bash('owned admin; ./stop-local.sh')
        child.wait(timeout=2)
        self.assertFalse((self.path / "data/local/admin.pid").exists())
        (self.path / "data/local/admin.pid").write_text(f"{child.pid}\n")
        self.bash('./stop-local.sh')
        self.assertFalse((self.path / "data/local/admin.pid").exists())

    def test_start_and_stop_share_lock(self):
        self.bash('''
exec 8>data/local/stack.lock
flock -n 8
for script in run-local.sh stop-local.sh; do
  if output=$("./$script" 2>&1); then exit 1; fi
  [[ "$output" == *"Another FireFlint start/stop is running."* ]]
done
''')


if __name__ == "__main__":
    unittest.main(verbosity=2)
