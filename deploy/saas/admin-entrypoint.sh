#!/bin/sh
set -eu
: "${API_UPSTREAM:?Set API_UPSTREAM to the internal API service host:port}"
if ! printf '%s\n' "$API_UPSTREAM" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$'; then
  echo 'API_UPSTREAM must be a service hostname and numeric port' >&2
  exit 1
fi
# Substitute only this deployment value; preserve nginx's own $variables.
envsubst '${API_UPSTREAM}' < /etc/fireflint/nginx.conf.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
