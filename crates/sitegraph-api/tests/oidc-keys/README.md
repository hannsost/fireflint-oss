# Public test fixtures

These two generated RSA key pairs are deliberately committed test material for
signature, key rotation and wrong-key regressions. They are never used by the
application or the Keycloak fixture. Do not use them for a deployment.

For the open-source release these key pairs were freshly regenerated (they never
existed in any earlier repository or deployment). They are allow-listed for
secret scanners in `.gitleaks.toml` because they are intentional, public test
fixtures.
