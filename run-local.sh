#!/usr/bin/env bash
# Start only the existing FireFlint stack. Never read secret files.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
mkdir -p data/local logs
exec 9>data/local/stack.lock
flock -n 9 || { echo "Another FireFlint start/stop is running." >&2; exit 1; }
for command in podman cargo node curl ss python3 setsid readlink; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 127; }
done

# Public demo defaults; inherited variables may override credentials. Fixed bind.
# No shell or dotenv configuration files are read.
export SITEGRAPH_LOAD_DOTENV=0 BIND=0.0.0.0:8090
export DATABASE_URL="${DATABASE_URL:-postgres://sitegraph:sitegraph@localhost:5433/sitegraph}"
export VITE_API_URL="${VITE_API_URL:-http://localhost:8090}"
python3 - <<'PY'
import os
from urllib.parse import urlsplit
url = urlsplit(os.environ["DATABASE_URL"])
if url.scheme not in ("postgres", "postgresql") or url.hostname not in ("localhost", "127.0.0.1") or url.port != 5433:
    raise SystemExit("DATABASE_URL must target the local FireFlint Postgres on port 5433.")
PY

source tools/local-stack.sh
check_service_slot core 8090
check_service_slot admin 5174

podman container exists fireflint-db || {
  echo "Missing existing container fireflint-db; restore the project stack first." >&2; exit 1;
}
[[ "$(podman inspect fireflint-db --format '{{range (index .HostConfig.PortBindings "5432/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}')" == "0.0.0.0:5433" ]] || {
  echo "fireflint-db must publish 0.0.0.0:5433; existing container left untouched." >&2; exit 1;
}
podman start fireflint-db >/dev/null 9>&-
ready=false
for ((i=0; i<30; i++)); do
  if podman exec fireflint-db pg_isready -U sitegraph >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo "Postgres readiness timed out after 30 seconds." >&2; exit 1; }

core_launching=false
if ! owned core; then
  cargo build -p sitegraph-bin 9>&-
  launch_service core "$PWD/target/debug/sitegraph"
  core_launching=true
fi
wait_http core http://localhost:8090/readyz 8090 "$core_launching"

admin_launching=false
if ! owned admin; then
  [[ -f admin/node_modules/vite/bin/vite.js ]] || {
    echo "Missing admin dependencies: run npm --prefix admin ci." >&2; exit 1;
  }
  launch_service admin node "$PWD/admin/node_modules/vite/bin/vite.js" admin --host 0.0.0.0 --port 5174 --strictPort
  admin_launching=true
fi
wait_http admin http://localhost:5174/ 5174 "$admin_launching"
echo "FireFlint ready: Admin http://localhost:5174 · API http://localhost:8090 · Postgres :5433"
echo "Demo login: owner@demo.test / demo1234. Stop only this stack with ./stop-local.sh."
