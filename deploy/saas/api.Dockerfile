# syntax=docker/dockerfile:1.7
ARG RUST_IMAGE=rust:1.98.1-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot
FROM ${RUST_IMAGE} AS build
ARG CARGO_BUILD_JOBS=2
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY operator/ operator/
COPY migrations/ migrations/
ARG FIREFLINT_BUILD_REVISION=development
ARG FIREFLINT_SOURCE_SHA256=
ENV FIREFLINT_BUILD_REVISION=${FIREFLINT_BUILD_REVISION} FIREFLINT_SOURCE_SHA256=${FIREFLINT_SOURCE_SHA256}
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p sitegraph-bin && \
    install -D target/release/sitegraph /out/sitegraph && mkdir /out/assets

FROM ${RUNTIME_IMAGE}
ARG FIREFLINT_BUILD_REVISION=development
ARG FIREFLINT_SOURCE_SHA256=
LABEL org.opencontainers.image.title="FireFlint API" \
    org.opencontainers.image.revision=${FIREFLINT_BUILD_REVISION} \
    io.neurofunken.fireflint.source-sha256=${FIREFLINT_SOURCE_SHA256}
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/sitegraph /usr/local/bin/sitegraph
COPY --from=build --chown=65532:65532 /out/assets /var/lib/fireflint/assets
ENV APP_ENV=production SITEGRAPH_LOAD_DOTENV=0 BIND=0.0.0.0:8080 ASSET_DIR=/var/lib/fireflint/assets
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/sitegraph"]
