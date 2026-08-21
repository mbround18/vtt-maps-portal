# vtt-maps-site

Full rewrite of the VTT Maps site.

## Stack
- Backend: Rust + Actix + MongoDB + RustFS (S3-compatible object storage)
- Frontend: React + Vite + RxJS + FlexSearch
- Observability: OpenTelemetry
- Deployment: Docker, Compose, Helm

## Local quick start
1. Copy `.env.example` to `.env` and fill values.
2. Start infra: `docker compose up -d mongo rustfs`
3. Run backend: `cargo run -p api`
4. Run frontend: `cd apps/web && pnpm install && pnpm run dev`

## Testing
- Backend: `cargo test --workspace`
- Frontend unit tests: `cd apps/web && pnpm run test`
- Frontend e2e (Playwright, requires the dev server): `cd apps/web && pnpm run test:e2e`
  (first run: `pnpm exec playwright install chromium`)

## Docker
Build and run full app:
- `docker compose up --build`

## `mapper` CLI
`mapper` is a standalone binary (`apps/api/src/bin/mapper.rs`) sharing the
same `MONGO_URI`/`RUSTFS_*`/`GITHUB_*` config as the API server, for
operational tasks that shouldn't run inside the long-lived server process:

- `make preload` (or `cargo run -p api --bin mapper -- preload`) — clones
  the configured `GITHUB_URL`/`GITHUB_BRANCH` repo into a temp dir with a
  shallow `git clone`, ingests any `.dd2vtt` files under `maps/` not
  already known, extracts each one's embedded image into a full-size and
  1/8-scale webp, and uploads everything to RustFS. Exits non-zero if any
  map failed, writes a `sync_runs` document either way — this is what
  `infra/helm/vtt-maps-site`'s `preload` CronJob (disabled by default, see
  `values.yaml`'s `preload.*` keys) runs on a schedule, as an alternative
  or supplement to the API server's own in-process nightly GitHub-API sync.

## Notes
- The API server's own nightly loop discovers maps via the GitHub API
  (tree + contents endpoints, no git clone) — see `services::assets::sync_maps`.
  `mapper preload` (above) is a separate, git-clone-based path meant for
  batch/cron use.
- `SUPER_ADMIN_DISCORD_ID` is granted the `admin` role at login.
