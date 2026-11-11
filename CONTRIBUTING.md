# Contributing to FireFlint

Thanks for your interest in improving FireFlint! This document explains how to propose changes.

## Ground rules

- Be respectful — this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Never commit secrets, real customer data, personal data or production configuration.
  Use placeholders and the provided `*.example` files.
- Report security vulnerabilities privately (see [SECURITY.md](SECURITY.md)).

## Development workflow

1. Fork the repository and create a topic branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Make focused commits with clear messages (Conventional Commits are appreciated, e.g. `fix(api): handle empty payload`).
3. Add or update tests for behaviour changes.
4. Run the checks locally before opening a pull/merge request:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cd admin && npm ci && npm run typecheck && npm run test:unit
```

5. Open a pull request (GitHub) or merge request (GitLab) and describe *what* and *why*.
   Link related issues. CI must be green before review.

The MCP server has its own dependency-free tests: `cd mcp && npm test`.

## Coding style

Rust: `rustfmt` + `clippy -D warnings`. TypeScript: strict mode, keep components small and accessible.

## Licensing of contributions

By contributing you agree that your contributions are licensed under the project's [MIT License](LICENSE).
