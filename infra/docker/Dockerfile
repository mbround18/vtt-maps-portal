FROM node:26-bookworm AS web-builder
# Non-interactive: without this, pnpm refuses to reconcile node_modules after
# the second COPY below (no TTY to confirm a modules-dir purge) and aborts.
ENV CI=true
# Node 26 no longer bundles corepack by default; install pnpm directly.
RUN npm install -g pnpm@11.22.0
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web .
RUN pnpm run build

FROM rust:1.97.1-bookworm AS rust-builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY apps/api/Cargo.toml apps/api/Cargo.toml
COPY apps/api/src apps/api/src
RUN cargo build -p api --release --bins

FROM debian:bookworm-slim AS runtime
# `git` is required at runtime by the `mapper preload` CLI (it clones the
# configured maps repo into a temp dir); harmless for the `api` server.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-builder /app/target/release/api /app/api
COPY --from=rust-builder /app/target/release/mapper /app/mapper
COPY --from=web-builder /app/apps/web/dist /app/apps/web/dist
ENV PORT=8080
EXPOSE 8080
CMD ["/app/api"]
