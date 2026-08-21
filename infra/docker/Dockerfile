FROM node:22-bookworm AS web-builder
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web .
RUN pnpm run build

FROM rust:1.91-bookworm AS rust-builder
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
