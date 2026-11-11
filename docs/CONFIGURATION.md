# Configuration reference

FireFlint is configured through environment variables. Never commit real values — start from
[`deploy/.env.example`](../deploy/.env.example) and keep secrets in your secret manager or Kubernetes Secrets.

## Core API (`sitegraph-bin`)

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | – | PostgreSQL connection string (required) |
| `BIND` | `0.0.0.0:8090` | API listen address |
| `APP_ENV` | `dev` | `production` enables guardrails: strong, distinct secrets; explicit CORS |
| `JWT_SECRET` | dev-only default | Access-token signing key (required in production) |
| `AI_CONNECTOR_ENCRYPTION_KEY` | – | Encryption key for stored AI provider keys (required in production, ≠ `JWT_SECRET`) |
| `CORS_ALLOWED_ORIGINS` | *(permissive in dev)* | Comma-separated allowlist |
| `ASSET_DIR` | `./data/assets` | Media storage |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Dev only: allow webhooks to private/loopback targets |
| `SITEGRAPH_LOAD_DOTENV` | `1` | Set `0` to ignore `.env` files |
| `RUST_LOG` | `info` | Log filter |

## Single sign-on (optional)

| Variable | Description |
| --- | --- |
| `OIDC_ISSUER_URL` | Issuer URL of your OIDC provider |
| `OIDC_LABEL` | Button label in the login screen |
| `OIDC_REQUIRE_APP_GROUP` | Require a group/role claim for access |
| `OIDC_ALLOW_LOOPBACK_HTTP` | Dev only: allow an `http://127.0.0.1` issuer |

Client ID/secret are provided via the deployment secret; see [KEYCLOAK.md](KEYCLOAK.md).

## AI (optional)

`AI_ALLOWED_PROVIDER_HOSTS`, `AI_ALLOW_PRIVATE_PROVIDERS` — see [AI-PROVIDERS.md](AI-PROVIDERS.md).

## Instagram publishing (optional)

`INSTAGRAM_LOGIN_MODE`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_PUBLIC_ORIGIN`,
`INSTAGRAM_API_VERSION`, `INSTAGRAM_CONFIG_ID`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` — see the German documentation in
[README.de.md](README.de.md).

## Admin UI build (Vite)

| Variable | Description |
| --- | --- |
| `VITE_API_URL` | API base URL for the admin UI |
| `VITE_PUBLIC_ORIGIN` | Public origin of this instance (brand-image validation) |
| `VITE_BRAND_ASSET_ORIGIN` | Optional external website whose `/assets/` images may be referenced |
| `VITE_OPERATOR_NAME`, `VITE_OPERATOR_ADDRESS`, `VITE_OPERATOR_EMAIL`, `VITE_LEGAL_URL` | Operator details for the legal-notice page — **required before running a public instance** |

## Kubernetes operator

`WATCH_NAMESPACE`, `LEADER_ELECTION_NAMESPACE`, `LEADER_ELECTION_LEASE`, `HEALTH_BIND`, `POD_NAME`,
`OPERATOR_DEPLOYMENT` — see [operator/SUPPORT-MATRIX.md](operator/SUPPORT-MATRIX.md).

## MCP server

See [MCP-AND-SKILLS.md](MCP-AND-SKILLS.md).
