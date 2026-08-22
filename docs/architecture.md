# Architecture

- `apps/api`: Actix API, auth, jobs, admin controls. Persists to MongoDB and
  stores map assets (source `.dd2vtt` files and generated webp images) in
  RustFS (S3-compatible object storage).
- `apps/web`: React/Vite frontend powered by RxJS stores and FlexSearch.
- `infra/docker`: Docker build assets.
- `infra/helm/vtt-maps-site`: Kubernetes chart.

## Datastore

MongoDB is the only datastore (`MONGO_URI`). Key collections: `users`,
`sessions`, `oauth_states`, `maps`, `views`/`downloads`/`votes`, `jobs`,
`sync_runs`.

## Object storage

RustFS holds the raw `.dd2vtt` source files and the generated `full.webp`/
`thumb.webp` images, addressed via `RUSTFS_ENDPOINT`/`RUSTFS_BUCKET`. It's
never exposed to the frontend directly -- the API proxies reads through
`GET /api/v1/assets/{key}` (anonymous) and the gated `.dd2vtt` download
route, so RustFS stays cluster/compose-internal only.

## Asset sync

A background job discovers `.dd2vtt` files in the configured GitHub
repository (`GITHUB_URL`, `GITHUB_TOKEN`, `GITHUB_BRANCH`) via the GitHub
API, downloads new files into RustFS, and extracts/encodes the embedded
map image into full-size and thumbnail webp images. The sync can be
triggered by an admin (`POST /admin/assets/sync`) or runs automatically on
a nightly loop; each run is recorded in the `sync_runs` collection.

## Auth

Single super-admin gate: the Discord account whose ID matches
`SUPER_ADMIN_DISCORD_ID` is always granted the `admin` role on login; all
other users keep whatever role was previously assigned to them (roles set
via the admin UI persist across logins).
