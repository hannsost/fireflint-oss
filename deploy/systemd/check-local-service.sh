#!/usr/bin/env bash
# systemd-only readiness/preflight checks. No dotenv files, builds or installs.
# Call from the canonical project root; systemd's WorkingDirectory supplies it.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

preflight_lock() {
  mkdir -p data/local
  exec 9>data/local/stack.lock
  flock --shared --nonblock 9 || fail 'A bare FireFlint start/stop owns stack.lock. Finish the documented handover first.'
}

check_free_service() {
  local service="$1" port="$2" pid listeners
  # Never adopt or kill a process; even a tracked bare service must stop first.
  if [[ -f "data/local/$service.pid" ]]; then
    read -r pid < "data/local/$service.pid" || pid=''
    if [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] && kill -0 "$pid" 2>/dev/null; then
      fail "$service has a live bare-stack PID. Use ./stop-local.sh --db before switching to systemd."
    fi
  fi
  listeners=$(ss -H -ltnp "sport = :$port") || fail "Could not inspect port $port."
  [[ -z "$listeners" ]] || fail "Port $port is occupied. Its process was left untouched."
}

ready_http() {
  local port="$1" path="$2" deadline=$((SECONDS + 40)) listeners state recv send address rest owns_port
  [[ "${MAINPID:-}" =~ ^[0-9]+$ && "$MAINPID" -gt 1 ]] || fail 'systemd MAINPID is unavailable.'
  while (( SECONDS < deadline )); do
    kill -0 "$MAINPID" 2>/dev/null || fail 'The managed service exited before readiness.'
    listeners=$(ss -H -ltnp "sport = :$port") || fail "Could not inspect port $port."
    owns_port=false
    if [[ -n "$listeners" ]]; then
      owns_port=true
      while read -r state recv send address rest; do
        if [[ "$address" != "0.0.0.0:$port" || "$rest" != *"pid=$MAINPID,"* ]]; then
          fail "Port $port does not belong to the managed PID on 0.0.0.0. Its process was left untouched."
        fi
      done <<< "$listeners"
    fi
    if "$owns_port" && curl --noproxy '*' --max-time 1 --fail --silent "http://127.0.0.1:$port$path" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "Managed service on port $port was not ready within 40 seconds."
}

case "${1:-}" in
  preflight-db)
    preflight_lock
    podman container exists fireflint-db || fail 'The existing fireflint-db container is missing; no replacement was created.'
    binding=$(podman inspect fireflint-db --format '{{range (index .HostConfig.PortBindings "5432/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}')
    [[ "$binding" == '0.0.0.0:5433' ]] || fail 'fireflint-db must publish exactly 0.0.0.0:5433. Container unchanged.'
    running=$(podman inspect fireflint-db --format '{{.State.Running}}')
    [[ "$running" == false ]] || fail 'fireflint-db already runs outside this unit. Complete ./stop-local.sh --db first.'
    ;;
  preflight-core)
    preflight_lock
    [[ -x target/debug/sitegraph ]] || fail 'Build the API first: cargo build --locked -p sitegraph-bin.'
    check_free_service core 8090
    ;;
  preflight-admin)
    preflight_lock
    [[ -f admin/node_modules/vite/bin/vite.js ]] || fail 'Install admin dependencies first: npm --prefix admin ci.'
    [[ -x /usr/bin/node ]] || fail '/usr/bin/node is missing; adjust the explicit unit path to the installed Node binary.'
    check_free_service admin 5174
    ;;
  ready-db)
    deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
      if podman exec fireflint-db pg_isready -U sitegraph -d sitegraph >/dev/null 2>&1; then exit 0; fi
      sleep 1
    done
    fail 'fireflint-db was not ready within 30 seconds.'
    ;;
  ready-core) ready_http 8090 /readyz ;;
  ready-admin) ready_http 5174 / ;;
  *) fail 'Expected preflight-db/core/admin or ready-db/core/admin.' ;;
esac
