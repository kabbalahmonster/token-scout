# Operations

## Local

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173>. API/OpenAPI are at ports 3001 and `/docs`.

## Hetzner / VPS

Install Docker Engine and Compose, clone the repository, copy `.env.example`,
and set `AUTH_TOKEN` to `openssl rand -hex 32`. Keep Compose bound to loopback.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100 api worker
```

Point the example Caddy config at `127.0.0.1:8080`. Allow inbound 22, 80, and
443 only; do not expose 3001 or the SQLite volume. `PUBLIC_READ=false` is the
safe default. Enter the bearer token in the console's top bar; it is retained
only in that browser's local storage. Set `PUBLIC_READ=true` only when public
research records are intentional. Mutations always require the token on a
non-local API bind. Health and readiness remain unauthenticated for orchestration.

## Upgrade and rollback

Back up first, fetch a reviewed revision, then rebuild. A rollback is a checkout
of the prior revision plus restore only if its schema cannot read the new file.

```bash
DATABASE_PATH=./data/doomscout.db pnpm db:backup
git pull --ff-only
docker compose up -d --build
```

For Compose volume backups, stop worker/API briefly or use SQLite `.backup`
inside the API image. Never copy a live database file without WAL coordination.

Restore is intentionally gated and requires stopped processes:

```bash
pnpm db:restore backups/doomscout-....db --confirm
```

Teardown keeps evidence with `docker compose down`. `docker compose down -v`
deletes the named volume and should only be used after an independently tested
backup.
