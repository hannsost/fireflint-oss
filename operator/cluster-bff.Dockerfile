# Multi-stage build with cargo-chef so dependency compilation is cached and only
# the workspace crates recompile on a source change.
#
# Build context is the repo root:
#   docker build -f operator/cluster-bff.Dockerfile -t sitegraph-cluster-bff .
FROM rust:1.93-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /src

# 1) Plan: capture the dependency recipe from the full workspace.
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY operator ./operator
RUN cargo chef prepare --recipe-path recipe.json

# 2) Cook: build only the BFF's dependencies (this layer is cached).
FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json -p sitegraph-cluster-bff
# 3) Build: copy sources and compile just the workspace crates.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY operator ./operator
RUN cargo build --locked --release -p sitegraph-cluster-bff

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/target/release/sitegraph-cluster-bff /usr/local/bin/sitegraph-cluster-bff
ENTRYPOINT ["/usr/local/bin/sitegraph-cluster-bff"]
