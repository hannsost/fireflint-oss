#!/usr/bin/env bash
# Stop only PID-tracked processes whose working directory belongs to FireFlint.
set -euo pipefail
cd "$(dirname "$0")"
[[ "${1:-}" == "" || "${1:-}" == --db ]] || { echo "Usage: ./stop-local.sh [--db]" >&2; exit 2; }
mkdir -p data/local
exec 9>data/local/stack.lock
flock -n 9 || { echo "Another FireFlint start/stop is running." >&2; exit 1; }
source tools/local-stack.sh
for service in core admin; do
  pid_file="data/local/$service.pid"
  [[ -f "$pid_file" ]] || continue
  pid=$(tracked_pid "$service") || {
    echo "Ignoring invalid $service PID file." >&2; continue;
  }
  if generation=$(process_generation "$pid"); then
    owned "$service" "$pid" || {
      echo "Ignoring $service PID: it does not match this checkout's service." >&2; continue;
    }
    [[ "$(process_generation "$pid")" == "$generation" ]] || continue
    kill -INT "$pid" 2>/dev/null || true
    for ((i=0; i<20; i++)); do
      [[ "$(process_generation "$pid" || true)" == "$generation" ]] || break
      sleep 0.2
    done
    if [[ "$(process_generation "$pid" || true)" == "$generation" ]]; then
      echo "$service is still shutting down; keeping its PID file." >&2
      continue
    fi
    echo "Stopped FireFlint $service."
  fi
  rm -f "$pid_file"
done

if [[ "${1:-}" == --db ]]; then
  podman stop fireflint-db
fi
