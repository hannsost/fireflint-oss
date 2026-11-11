# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG NGINX_IMAGE=nginx:1.30.4-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /src/admin
COPY admin/package.json admin/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY admin/ ./
ENV SITEGRAPH_LOAD_DOTENV=0 VITE_API_URL= VITE_BFF_URL=
RUN npm run build

FROM ${NGINX_IMAGE}
# Alpine 3.24 libuuid fixes; the base tag alone still contains 2.42.1-r0.
# Allow a later vendor fix, and record the resolved version in the image scan.
RUN apk add --no-cache --upgrade 'libuuid>=2.42.3-r1'
ARG FIREFLINT_BUILD_REVISION=development
ARG FIREFLINT_SOURCE_SHA256=
LABEL org.opencontainers.image.title="FireFlint Administration" \
    org.opencontainers.image.revision=${FIREFLINT_BUILD_REVISION} \
    io.neurofunken.fireflint.source-sha256=${FIREFLINT_SOURCE_SHA256}
COPY --from=build /src/admin/dist/ /usr/share/nginx/html/
COPY deploy/saas/nginx.conf.template /etc/fireflint/nginx.conf.template
COPY deploy/saas/nginx-security-headers.conf /etc/fireflint/security-headers.conf
COPY --chmod=755 deploy/saas/admin-entrypoint.sh /usr/local/bin/fireflint-admin
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/fireflint-admin"]
