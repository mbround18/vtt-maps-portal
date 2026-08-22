# Operations

## Datastore

MongoDB is the only datastore, configured via `MONGO_URI`. There are no
schema migrations to run — collections and indexes are created on demand /
at startup.

## Seeded admin

`SUPER_ADMIN_DISCORD_ID` is granted role `admin` on every login. All other
users keep whatever role was last assigned to them via the admin UI (role
changes are no longer reverted on next login).

## Assets sync

`POST /admin/assets/sync` enqueues a `sync_maps` job that discovers
`.dd2vtt` files under `maps/` in the GitHub repository configured by
`GITHUB_URL` (with `GITHUB_TOKEN`, `GITHUB_BRANCH`), downloads new files
into RustFS, and enqueues an `extract_image` job per new map to generate
`full.webp`/`thumb.webp`. A nightly background loop triggers the same sync
automatically. Review sync history via `GET /admin/sync-runs`, and overall
status via `GET /admin/assets/status`.

## Jobs

Job records are persisted in the `jobs` MongoDB collection (job types:
`sync_maps`, `extract_image`). Progress and cancellation are tracked per
job document; there is no separate queue/lock service.

## Object storage

Map assets (source `.dd2vtt` files and generated webp images) live in
RustFS, an S3-compatible object store, configured via `RUSTFS_ENDPOINT`,
`RUSTFS_BUCKET`, `RUSTFS_ACCESS_KEY`, and `RUSTFS_SECRET_KEY`. RustFS itself
never needs to be network-reachable from outside the cluster/compose
network: the API proxies every read through `GET /api/v1/assets/{key}`
(anonymous, for map images/thumbnails) or the gated `.dd2vtt` download route,
so the frontend only ever talks to RustFS indirectly, through the API.
