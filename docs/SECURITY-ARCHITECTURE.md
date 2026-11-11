# Security Policy

## Reporting a vulnerability

Please report security issues privately (do **not** open a public issue):
email the maintainers and allow reasonable time for a fix before disclosure.

## Built-in safeguards

- **Auth:** argon2 password hashing; short-lived access JWT + separate refresh
  token; API tokens stored only as SHA-256 hashes.
- **Multi-tenancy:** every repository query is scoped by `org_id`.
- **Production guards:** with `APP_ENV=production` the core refuses to start on
  the insecure default `JWT_SECRET`; CORS is an explicit allowlist
  (`CORS_ALLOWED_ORIGINS`).
- **Webhooks:** outbound targets are validated against an SSRF guard
  (loopback/private/link-local blocked unless `WEBHOOK_ALLOW_PRIVATE=true`);
  payloads are HMAC-SHA256 signed (`X-FireFlint-Signature`).
- **Response headers:** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Secrets:** storage endpoint/credential references stay opaque; connection
  secrets are never serialized to API responses.

## Known limitations

See `README.md` → "Bekannte Einschränkungen" and `UNTESTED-CHANGES.md`.
