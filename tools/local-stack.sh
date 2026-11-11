#!/usr/bin/env bash
# Shared lifecycle checks; callers hold data/local/stack.lock and run at the repo root.

tracked_pid() {
  local pid
  [[ -f "data/local/$1.pid" ]] || return 1
  read -r pid < "data/local/$1.pid" || return 1
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
  printf '%s\n' "$pid"
}

process_generation() {
  # /proc start time survives exec, distinguishes PID reuse, and excludes zombies.
  local stat fields
  IFS= read -r stat 2>/dev/null < "/proc/$1/stat" || return 1
  read -ra fields <<< "${stat##*) }"
  [[ "${fields[0]}" != Z && "${fields[0]}" != X ]] || return 1
  printf '%s\n' "${fields[19]}"
}

owned() {
  local service="$1" pid="${2:-}" executable
  local -a args
  [[ -n "$pid" ]] || pid=$(tracked_pid "$service") || return 1
  process_generation "$pid" >/dev/null || return 1
  [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$PWD" ]] || return 1
  executable=$(readlink "/proc/$pid/exe" 2>/dev/null) || return 1
  case "$service" in
    core) [[ "$executable" == "$PWD/target/debug/sitegraph" ]] ;;
    admin)
      [[ "$executable" == "$(readlink -f "$(command -v node)")" ]] || return 1
      mapfile -d '' -t args 2>/dev/null < "/proc/$pid/cmdline" || return 1
      [[ "${#args[@]}" == 8 && "${args[1]}" == "$PWD/admin/node_modules/vite/bin/vite.js" &&
         "${args[*]:2}" == 'admin --host 0.0.0.0 --port 5174 --strictPort' ]]
      ;;
    *) return 1 ;;
  esac
}

listeners_match() {
  local listeners="$1" pid="$2" port="$3" state recv send address rest
  [[ -n "$listeners" ]] || return 1
  while read -r state recv send address rest; do
    [[ "$address" == "0.0.0.0:$port" && "$rest" == *"pid=$pid,"* ]] || return 1
  done <<< "$listeners"
}

check_service_slot() {
  local service="$1" port="$2" pid listeners
  pid=$(tracked_pid "$service") || pid=''
  if [[ -n "$pid" ]] && process_generation "$pid" >/dev/null; then
    owned "$service" "$pid" || {
      echo "$service PID is alive but does not match this checkout's service; leaving it untouched." >&2
      return 1
    }
  fi
  listeners=$(ss -H -ltnp "sport = :$port") || return 1
  if [[ -n "$listeners" ]] && { ! owned "$service" || ! listeners_match "$listeners" "$pid" "$port"; }; then
    echo "Port $port is occupied by an untracked process; leaving it untouched." >&2
    return 1
  fi
}

launch_service() {
  local service="$1"
  shift
  # Disable job control so setsid execs in this PID instead of forking a new leader.
  set +m
  setsid "$@" >"logs/$service.log" 2>&1 < /dev/null 9>&- &
  echo "$!" >"data/local/$service.pid"
}

monotonic_centiseconds() {
  local uptime rest
  read -r uptime rest < /proc/uptime
  printf '%s\n' "$(( ${uptime%.*} * 100 + 10#${uptime#*.} ))"
}

wait_http() {
  local service="$1" url="$2" port="$3" launching="${4:-false}" timeout="${5:-30}"
  local pid generation current listeners identified=false deadline
  deadline=$(( $(monotonic_centiseconds) + timeout * 100 ))
  pid=$(tracked_pid "$service") || { echo "Missing valid $service PID." >&2; return 1; }
  generation=$(process_generation "$pid") || {
    echo "$service exited; see logs/$service.log." >&2; return 1;
  }
  while true; do
    current=$(process_generation "$pid") || current=''
    [[ "$current" == "$generation" ]] || {
      echo "$service exited or its PID was replaced; see logs/$service.log." >&2; return 1;
    }
    if owned "$service" "$pid"; then
      identified=true
    elif ! "$launching" || "$identified"; then
      echo "$service PID does not match the expected service; leaving it untouched." >&2
      return 1
    fi
    listeners=$(ss -H -ltnp "sport = :$port") || return 1
    if [[ -n "$listeners" ]] && ! listeners_match "$listeners" "$pid" "$port"; then
      echo "Port $port is occupied by an untracked process; leaving it untouched." >&2
      return 1
    fi
    # A fresh child may still be between fork and exec. Liveness alone never
    # authorizes HTTP success: require the target executable AND its own listener.
    if "$identified" && listeners_match "$listeners" "$pid" "$port" &&
        curl --max-time 1 -fsS "$url" >/dev/null 2>&1 &&
        owned "$service" "$pid" && [[ "$(process_generation "$pid")" == "$generation" ]] &&
        listeners_match "$(ss -H -ltnp "sport = :$port")" "$pid" "$port"; then
      return 0
    fi
    # Include a final probe at the deadline. Integer SECONDS can truncate almost
    # a second; /proc/uptime is monotonic with centisecond resolution on Linux.
    (( $(monotonic_centiseconds) >= deadline )) && break
    sleep 0.2
  done
  echo "$service readiness timed out after $timeout seconds; see logs/$service.log. PID retained for the next start/stop." >&2
  return 1
}
