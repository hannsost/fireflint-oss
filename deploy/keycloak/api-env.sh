#!/usr/bin/env bash
# Source only for the isolated development API on 28090. Never for production.
if [[ "${APP_ENV:-development}" == "production" ]]; then
  printf '%s\n' 'Refusing development OIDC configuration in production.' >&2
  return 1 2>/dev/null || exit 1
fi
export OIDC_ISSUER_URL='http://localhost:28180/realms/fireflint-local'
export OIDC_CLIENT_ID='fireflint-hub'
export OIDC_CLIENT_SECRET='dev-only-oidc-client-secret'
export OIDC_REDIRECT_URI='http://localhost:28091/oidc/callback'
export OIDC_POST_LOGOUT_REDIRECT_URI='http://localhost:28091/login'
export OIDC_LABEL='Keycloak (lokale Testinstanz)'
export OIDC_ALLOW_LOOPBACK_HTTP='1'
