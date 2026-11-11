#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
test -x target/debug/sitegraph
test -f admin/node_modules/vite/bin/vite.js
mkdir -p data/mobile/postgres data/mobile/assets data/mobile/logs
container=fireflint-release-db
if podman container exists "$container"; then
  test "$(podman inspect "$container" --format '{{index .Config.Labels "io.fireflint.fixture"}}')" = mobile-2026-09-18 || { echo 'Foreign release fixture; refusing takeover' >&2; exit 1; }
  test "$(podman port "$container" 5432/tcp)" = 0.0.0.0:15433
else
  test -z "$(ss -H -ltn 'sport = :15433')"
  podman create --name "$container" --label io.fireflint.fixture=mobile-2026-09-18 \
    -e POSTGRES_USER=fireflint_test -e POSTGRES_PASSWORD=fireflint-test-only \
    -e POSTGRES_DB=fireflint_release_test -p 0.0.0.0:15433:5432 \
    -v "$root/data/mobile/postgres:/var/lib/postgresql/data:Z" docker.io/library/postgres:16-alpine >/dev/null
fi
if ! systemctl --user is-active --quiet fireflint-mobile-db.service; then
  systemctl --user reset-failed fireflint-mobile-db.service 2>/dev/null || true
  systemd-run --user --unit=fireflint-mobile-db --collect --property=Restart=on-failure \
    /usr/bin/podman start --attach "$container"
fi
for attempt in {1..30}; do
  if podman exec "$container" pg_isready -U fireflint_test -d fireflint_release_test >/dev/null; then break; fi
  if test "$attempt" = 30; then echo 'Release database not ready' >&2; exit 1; fi
  sleep 1
done
if ! systemctl --user is-active --quiet fireflint-mobile-api.service; then
  test -z "$(ss -H -ltn 'sport = :18090')" || { echo 'API port occupied; refusing takeover' >&2; exit 1; }
  systemctl --user reset-failed fireflint-mobile-api.service 2>/dev/null || true
  systemd-run --user --unit=fireflint-mobile-api --collect --property="WorkingDirectory=$root" \
    --property=Restart=on-failure --property="StandardOutput=append:$root/data/mobile/logs/api.log" \
    --property="StandardError=append:$root/data/mobile/logs/api.log" \
    --setenv=SITEGRAPH_LOAD_DOTENV=0 --setenv=APP_ENV=development --setenv=BIND=0.0.0.0:18090 \
    --setenv=DATABASE_URL=postgres://fireflint_test:fireflint-test-only@127.0.0.1:15433/fireflint_release_test \
    --setenv=JWT_SECRET=fireflint-mobile-isolated-public-test-jwt \
    --setenv=AI_CONNECTOR_ENCRYPTION_KEY=development-only-connector-key \
    --setenv="ASSET_DIR=$root/data/mobile/assets" --setenv=WEBHOOK_ALLOW_PRIVATE=true \
    --setenv=RUST_LOG=warn "$root/target/debug/sitegraph"
fi
for attempt in {1..30}; do
  if curl --noproxy '*' -fsS --max-time 1 http://127.0.0.1:18090/readyz >/dev/null; then break; fi
  if test "$attempt" = 30; then echo 'Release API not ready' >&2; exit 1; fi
  sleep 1
done
if ! systemctl --user is-active --quiet fireflint-mobile-release-admin.service; then
  test -z "$(ss -H -ltn 'sport = :15174')" || { echo 'Admin port occupied; refusing takeover' >&2; exit 1; }
  systemctl --user reset-failed fireflint-mobile-release-admin.service 2>/dev/null || true
  systemd-run --user --unit=fireflint-mobile-release-admin --collect --property="WorkingDirectory=$root" \
    --property="StandardOutput=append:$root/data/mobile/logs/release-admin.log" \
    --property="StandardError=append:$root/data/mobile/logs/release-admin.log" \
    --setenv=SITEGRAPH_LOAD_DOTENV=0 --setenv=VITE_API_URL=http://127.0.0.1:18090 \
    --setenv=ADMIN_PORT=15174 /usr/bin/node "$root/admin/node_modules/vite/bin/vite.js" \
    "$root/admin" --host 0.0.0.0 --port 15174 --strictPort
fi
echo 'Own release services ready; data ownership is checked again by each fixture before mutations.'
