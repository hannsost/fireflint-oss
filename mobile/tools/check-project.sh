#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export SITEGRAPH_LOAD_DOTENV=0
trap 'code=$?; printf "%s\n" "$code" > "$root/data/mobile/logs/project-gates.exit"' EXIT
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix admin run typecheck
npm --prefix admin run build
