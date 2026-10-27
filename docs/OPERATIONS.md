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
research records are intentional. Production mutations always require the
token, including behind a loopback reverse proxy. Health and readiness remain
unauthenticated for orchestration.

For a non-Compose reverse-proxy deployment, set `TRUST_PROXY=true` only while
the API remains loopback/private-network bound. Never combine it with a
directly internet-accessible API port, because clients could forge forwarding
headers and evade per-IP rate limits.

### DoomDash subpath deployment

The live `https://doomdash.ca/doomscout/` console uses a separate
`apps/web/dist-hosted` bundle so ordinary root-path builds cannot overwrite the
served assets. Build it with `pnpm build:hosted`. The `doomscout-web.service`
preview process must serve `--outDir dist-hosted`. The generic Docker deployment
continues to build and serve `apps/web/dist` at the domain root.

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

After a scoring-algorithm upgrade, preview recalculation against retained local
evidence before changing the ranked board. The default command is read-only;
`--apply` stores a new versioned swing study and score for every candidate.

```bash
pnpm rescore
pnpm rescore -- --apply
```

Back up the database before `--apply`. Rescoring makes no provider calls and
does not reinterpret or delete old score history, so rollback remains an app
revision rollback plus selection of the earlier retained score records if needed.

Restore is intentionally gated and requires stopped processes:

```bash
pnpm db:restore backups/doomscout-....db --confirm
```

Teardown keeps evidence with `docker compose down`. `docker compose down -v`
deletes the named volume and should only be used after an independently tested
backup.
