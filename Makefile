.PHONY: setup web api dev e2e preload compose-up compose-down

setup:
	cd apps/web && pnpm install

web:
	cd apps/web && pnpm run dev

api:
	cargo run -p api

# Starts mongo+rustfs (if not already up), then runs api + web together.
# Ctrl+C stops api/web; infra containers keep running for the next `make dev`.
dev:
	docker compose up -d mongo rustfs
	@trap 'kill 0' INT TERM EXIT; \
	cargo run -p api --bin api & \
	(cd apps/web && pnpm run dev) & \
	wait

e2e:
	cd apps/web && pnpm run test:e2e

# Clones the configured GITHUB_URL repo into a temp dir and ingests any new
# maps (source upload + webp extraction), same code path a k8s CronJob would
# run via the `mapper` binary. Requires mongo+rustfs to be reachable.
preload:
	cargo run -p api --bin mapper -- preload

compose-up:
	docker compose up --build

compose-down:
	docker compose down -v
