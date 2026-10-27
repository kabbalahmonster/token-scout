# DoomScout / Token Scout

**A read-only, self-hosted token discovery and market-structure workbench for
selecting candidates for the Robinhood Chain Grid Trading Bot.** It discovers
and tracks EVM tokens, measures actual tradability and repeatable swing
behaviour, exposes risks, and produces an operator-reviewed bot-configuration
draft. It never holds a private key, signs a transaction, or directs a bot to
trade automatically.

This README is the product and engineering contract for the application. Build
to this document; do not replace it with a static demo, a price-prediction toy,
or a wallet-connected trading interface.

> This is research tooling, not financial advice or a profitability engine. A
> high score means a token passed documented checks at a point in time; it does
> not mean it is safe, liquid forever, or likely to profit.

## Implemented application

The repository now contains the working TypeScript MVP described below:

- React/Vite operator console with Scoutboard filters/presets, token details,
  retained-history charts, swing ledger, score/risk/route explanations,
  discovery import, watchlists, in-app alerts, operations, and exports;
- Fastify REST/OpenAPI/SSE API with schema validation, rate limits, mutation
  auth, redacted errors/logs, health/readiness, CSV/JSON history, and JSON/.env
  recommendation drafts;
- separate SQLite-backed worker with idempotent discovery, watched polling,
  assessment, retention, and alert jobs;
- credential-free DexScreener, Robinhood RPC, Blockscout, CoinGecko, and Sushi
  adapters with source budgets, timeout/retry/cache/circuit state;
- SQLite WAL evidence storage with immutable raw snapshots, 5-minute and hourly
  aggregates, versioned studies/scans/scores, migrations, backup, and restore;
- strict domain algorithms, fixture/unit/integration/E2E tests, Docker Compose,
  CI, and loopback-first Hetzner deployment examples.

Static findings remain deliberately conservative: transfer-tax and
concentration state stays `unknown` when free evidence cannot establish it.
That is correct behaviour, not a clean bill of health.

### Quick start

Node.js 22 and Corepack are required.

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173>; generated OpenAPI is at
<http://127.0.0.1:3001/docs>. The local placeholder bearer token in
`.env.example` is not a secret and **must be replaced** before a public/TLS
deployment.

```bash
# production / VPS (still published on loopback by default)
cp .env.example .env
# Replace AUTH_TOKEN with: openssl rand -hex 32
docker compose up -d --build
```

See [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md),
[sources](docs/DATA_SOURCES.md), [swing methodology](docs/SWING_ALGORITHM.md),
[scoring](docs/SCORING.md), [API](docs/API.md), [threat model](docs/THREAT_MODEL.md),
[operations](docs/OPERATIONS.md), and [development](docs/DEVELOPMENT.md).

## Goals

1. Find new and existing Robinhood Chain tokens using free/public data only.
2. Rank candidates for **grid/gridless suitability**, not hype or upside.
3. Measure repeatable price swings at multiple thresholds from retained
   observations, not a provider's single 24-hour percentage.
4. Test planned-size buy/sell economics when a free quote endpoint is
   available. Chart price is not executable economics.
5. Show market, contract, liquidity, source-quality, and route risks before a
   human creates a bot configuration.
6. Retain an auditable history of scores, inputs, flags, sources, and exports.
7. Run locally or on a small Hetzner VPS with Docker Compose.

## Hard boundaries

- Never access private keys, seed phrases, wallets, approvals, or transactions.
- Never automatically rotate tokens, deploy a bot, or present a recommendation
  as a command to a bot.
- Never claim a token is safe, scam-free, a buy, or profitable.
- Never require paid data, a paid RPC, or a mandatory API key for core use.
- Never manufacture a route result, historical data point, or safety finding
  when a source is unavailable.

## Target-bot compatibility

DoomScout is compatible with the documented [Robinhood Chain Grid Trading Bot
capabilities](https://github.com/kabbalahmonster/robinhood-grid-bot-py/blob/main/docs/AI_STRATEGY_CAPABILITY_REFERENCE.md).
That bot is long-only, spot-only, single-wallet and single-token per process;
it trades native ETH/WETH against one ERC-20, using classic grid or gridless
`threshold`, `drawdown_ladder`, and `survivor` allocation modes.

The scout must only generate reviewable configurations within those supported
limits. It must distinguish a gross/chart price from an executable quote, and
must never relax the bot's route, tax, gas, local-simulation, balance-reserve,
receipt, settlement, accounting, or unresolved-broadcast protections.

The recommendation UI must state whether an idea is configuration-only or
needs bot code. It must not assume existing support for shorts, leverage,
limit orders, cross-token portfolios, arbitrary indicators, social/news
execution signals, automatic discovery/rotation, or AI transaction signing.
It must prominently note the referenced bot's known stop-loss caveat: ordinary
losing gridless stop-loss exits can be blocked by an earlier profit precheck.

## Scope and staged rollout

MVP supports **Robinhood Chain (EVM chain ID 4663)**. The data model and
adapters must retain `chain_id` everywhere so Base (8453) and Ethereum (1) can
be added without a migration. Do not claim Solana support: it needs distinct
token, pool, discovery, and risk adapters.

| Stage | Deliverable |
| --- | --- |
| MVP | Robinhood discovery, assessments, watchlists, swing history, rankings, risk cards, configuration export, Docker deployment. |
| v1 | Base/Ethereum adapters, comparison view, alerts, richer history/export, historical diagnostics. |
| Later | Separate Solana adapter only after equivalent sources and risk analysis exist. |

## Free data-source policy

The product must remain useful without credentials. Every source adapter needs
a timeout, concurrency/rate limiter, cache, retry with exponential backoff,
circuit breaker, status indicator, and explicit degraded state.

| Information | Primary source | Requirement |
| --- | --- | --- |
| Discovery, pairs, prices, liquidity, volume, pair age | DexScreener public API | Treat profiles/pairs as untrusted leads; retain our own normalized history. |
| Contract code, ERC-20 reads, logs, gas | Robinhood public JSON-RPC | Use a configurable tested RPC pool. |
| Explorer and optional verification context | Robinhood Blockscout public explorer/API | Enrichment only; lack of verification is uncertainty, not safety evidence. |
| ETH/USD reference | CoinGecko free endpoint | Heavily cached; lack of USD conversion cannot block ETH-denominated analysis. |
| Route feasibility | Free public quote adapters supported by the bot, initially Sushi | Optional and read-only; never pretend a quote is guaranteed execution. |

Uniswap's key-gated API, paid RPCs, commercial honeypot APIs, paid indexers,
and social APIs may be optional extras but can never be requirements. A missing
optional adapter is `not_configured`, not a token failure.

## UX specification

Design a dark, dense-but-readable operator console that is excellent on phone
and desktop. Use accessible controls, visible source freshness, keyboard
navigation, plain-language explanations, and tooltips for every score/flag.

### Scoutboard

- Live rankable table/card layout: token, chain, score, verdict, confidence,
  price, liquidity, FDV/market cap when available, pair age, volume,
  buy/sell count, swing score, route state, flags, and freshness.
- Filter by chain, watchlist, verdict, minimum liquidity/age/volume/score,
  source freshness, route state, and individual risk flags.
- Sort by composite/swing score, liquidity, volume-to-liquidity, age, price
  change, route recovery, and latest update. Persist named filter presets.
- Clearly distinguish `unassessed`, `collecting history`, `assessed`, `stale`,
  `rejected`, and `watched`.

### Token detail

- Overview, score/verdict explanation, metric cards and market/pool breakdown.
- Interactive chart from retained snapshots; visibly break lines at data gaps.
- Swing study, event ledger, route-test results, source freshness, contract
  evidence, every flag, historical score changes, notes/tags, and exports.
- Links to DexScreener and Blockscout open externally and never execute a trade.

### Discovery, watchlists, recommendations, operations

- Discovery inbox dedupes by `(chain_id, token_address)`, supports manual
  address/CSV import, and makes bulk-rate impact explicit.
- Named watchlists have labels/tags, assessment budget and intended position
  count; alerts can cover score, flags, routes, liquidity/volume, swings, and
  stale data. Start with in-app alerts and optional Telegram integration.
- Recommendation review exports JSON or `.env`-style values but never writes
  to a bot host or starts a bot.
- Operations displays source/RPC health, queue/job lag, cache age, poll rate,
  storage, errors, migrations, and manual refresh.

## Functional requirements

### Discovery and lifecycle

- Poll configured discovery feeds by default every 15 minutes and retain source
  time, ingest time, raw source ID, and ingestion outcome.
- Validate EVM addresses, reject EOAs with `eth_getCode`, and retain chain ID.
- Merge pools under one token, choosing a canonical pair by documented highest
  trustworthy USD liquidity while retaining all pair identities and allowing a
  user override.
- States: `discovered`, `queued`, `collecting_history`, `assessed`, `watched`,
  `stale`, `rejected`, `archived`.
- Provider failure must create an observation/error record, never silently
  delete a candidate.

### Snapshots and history

Each normalized immutable snapshot contains: quote/native/USD price if present,
canonical pair and DEX, liquidity, FDV/market cap if present, volume and
transaction counts for available windows, pair creation time, source time,
ingest time, source identity, and raw-data fingerprint.

- Default watched cadence is 60 seconds, bounded/configurable from 30 seconds
  to 15 minutes, with jitter and global source budgets.
- Use SQLite in WAL mode by default. Retain raw samples for 7 days, 5-minute
  candles for 90 days, and hourly aggregates for 2 years; all policies are
  configurable.
- Store unavailable as `null`, not zero. UI and scoring must distinguish zero,
  unknown, stale, and failed.
- Calculate history quality: sample count, coverage %, largest gap, sources,
  earliest/latest point. Insufficient history caps confidence.

### Swing-pattern engine

Calculate all swings from stored normalized prices; version the algorithm and
parameters, preserve input snapshot IDs, and show the outputs in the UI.

For thresholds ±2%, ±5%, ±10%, ±20% (configurable) and horizons 1h, 6h, 24h,
7d, 30d where data exists, calculate:

- upward/downward crossings and completed round trips;
- event frequency/day, time since last event, median/mean/p25/p75/min/max
  duration between comparable events;
- amplitude and excursion distribution, maximum drawdown, adverse excursion
  before recovery, and a log-return volatility proxy;
- trend/drift, range compression/expansion, and time inside dominant range;
- swing suitability based on event frequency, regularity, amplitude, history
  coverage, liquidity stability, and trend penalty.

Definitions must prevent hindsight cosplay: a down swing starts after a local
high and completes only at the chosen fall; up swings are symmetric; a round
trip only completes after an opposite threshold crossing. Add configurable
minimum event separation and confirmation window. A data gap over three
expected polls splits the series—events cannot bridge that gap. Use decimal or
integer-safe normalized prices, not floating token units. The event ledger
shows timestamp, threshold, direction, start/end price, duration, amplitude,
and source snapshot IDs.

### Planned-size route checks

For a configurable planned budget and position count, calculate principal using
the target bot's documented allocation model. If a free quote adapter works:

- request exact-input native/WETH → token buy at planned size;
- request token quantity received → native/WETH sell;
- retain provider, time, inputs/outputs, price impact, available gas estimate,
  timeout/error, route state, and conservative round-trip recovery;
- compare providers independently, showing redundancy/disagreement/staleness;
- never approve, sign, or claim the quote is execution.

Route states are `not_attempted`, `not_configured`, `available`,
`no_route_or_liquidity`, `quote_failed`, `timed_out`, `stale`. An unavailable
quote endpoint is not evidence of a honeypot.

### Contract and token-risk analysis

Static analysis is warnings, never an audit. Save scan version, code hash/size,
evidence, source times, and uncertainty. Implement:

- contract existence; proxy/implementation detection where identifiable;
- common ownership/admin selectors and whether readable owner is non-zero;
- common tax/fee, pause/trading enable, blacklist, max-wallet/max-tx, mint,
  upgrade/delegatecall, `tx.origin`, self-destruct patterns;
- ERC-20 metadata, decimals, and supply reads if available;
- watched bytecode change detection;
- pool concentration warnings only where reliable data exists;
- `detected`, `not detected`, and `unknown` for every check.

Never call a token safe because a selector was absent, verification failed, or a
buy quote succeeded. Hard flags need clear evidence; heuristics need confidence
and source details.

### Scoring, confidence, and verdict

Use a versioned, configurable transparent 0–100 score. Every component needs
raw input, weight, cap/deduction, source, timestamp, explanation, and tests.

| Component | Default weight | Evidence |
| --- | ---: | --- |
| Liquidity/planned-size impact | 25 | USD liquidity, depth proxy, capital/liquidity ratio |
| Executable route quality | 20 | buy/sell availability, recovery, redundancy |
| Swing suitability | 20 | frequency, regularity, amplitude, coverage, drift |
| Volume/activity quality | 15 | volume/liquidity, buy/sell balance, persistence |
| Age/market stability | 10 | pair age, liquidity changes, continuity |
| Contract-risk posture | 10 | flags, ownership/proxy uncertainty, code stability |

Default verdicts: `PASS` (75+ with no hard fail), `CAUTION` (50–74 or material
unknown), `REJECT` (<50 or hard fail). Hard fails include attempted/no sell
route, severe confirmed round-trip loss, insufficient liquidity for planned
size, and defined high-confidence contract hazards. Confidence is separate:
missing history, stale data, and unavailable routes must lower it rather than
turning into a confident low-risk answer.

### Recommendation/export

Generate a review-only bot-compatible draft with compatible engine/allocation
mode, `GRIDLESS_BUY_THRESHOLD`, `GRIDLESS_SELL_THRESHOLD`, terminal drawdown,
spacing, capacity, minimum position size, execution margin, cooldown, polling
cadence/mode, tradeable balance/gas-reserve options, rationale, history minimum
and risks. It must say which facts cannot be known: wallet balance, future gas,
mutable tax, route condition at execution, etc.

Do not recommend a grid tighter than noise/execution friction, a ladder deeper
than sampled drawdown without a loss-cap warning, or the known unreliable
stop-loss as safety. JSON/.env exports include schema/scout versions,
chain/token/pair, generated and source times, `operator_review_required: true`.

## API and documentation

Provide REST plus live updates using SSE or WebSocket. Generate OpenAPI from
code. All write endpoints require auth when non-local.

```text
GET  /api/v1/health
GET  /api/v1/candidates
POST /api/v1/candidates/assess
GET  /api/v1/candidates/:chainId/:address
GET  /api/v1/candidates/:chainId/:address/history
GET  /api/v1/candidates/:chainId/:address/swings
POST /api/v1/watchlists
POST /api/v1/watchlists/:id/items
DELETE /api/v1/watchlists/:id/items/:chainId/:address
GET  /api/v1/recommendations/:chainId/:address
GET  /api/v1/export/:chainId/:address
GET  /api/v1/sources/status
```

Support CSV/JSON history exports and JSON/.env recommendation exports, always
with methodology/version metadata and no secrets. Maintain architecture, API,
data-source, scoring, swing-algorithm, threat-model, configuration, backup,
operations, development, and contribution documentation. Comment every
non-obvious domain/risk rule in code; tests should name the rule protected.

## Architecture

Use an end-to-end TypeScript monorepo:

```text
apps/
  web/                 React + Vite frontend
  api/                 Fastify REST/live-update server
  worker/              discovery, polling, scoring, retention jobs
packages/
  domain/              pure types and score/swing/recommendation algorithms
  adapters/            RPC, DexScreener, Blockscout, CoinGecko, quote sources
  database/            SQLite schema, migrations, repositories
  config/              validated typed configuration
docs/
docker-compose.yml
```

Use Node.js 22 LTS, strict TypeScript, React/Vite, TanStack Query/Table, an
accessible lightweight chart library, Fastify schema validation, and
Drizzle/Kysely with SQLite. A separate worker keeps upstream latency away from
the UI. Use idempotent SQLite-backed jobs initially; do not require Redis.
Use `bigint`/decimal libraries for token/native values. Retain bounded/redacted
raw provider evidence only; normalized snapshots are the analytics truth.

## Security, reliability, and operations

- Bind to `127.0.0.1` by default; document Caddy/Nginx TLS for public Hetzner
  deployment and warn about unauthenticated public bind.
- Require password/long-token or trusted reverse-proxy auth for mutations;
  public read mode is opt-in/rate-limited.
- Validate all addresses, imports, filters, URLs, IDs, and display text; escape
  source-derived UI content.
- Configurable adapter timeouts, concurrency, retries, caching, circuit
  breakers, stale-while-revalidate; never leak RPC URLs/secrets/stack traces.
- Atomic migrations/writes, backup and restore commands, retention cleanup,
  structured JSON logs, health/readiness, and counters for jobs/source errors,
  cache, score changes, and lag.
- Unit-test domain logic; fixture-test adapters; integration-test API/storage;
  E2E-test critical UI flows, malformed/rate-limited responses, and outages.

## Local and VPS deployment

The completed app must support:

```bash
# development
cp .env.example .env
pnpm install
pnpm dev

# production: Hetzner or any Docker VPS
cp .env.example .env
docker compose up -d --build
```

Compose runs web/API/worker (or a documented combined process), persists SQLite
in a named volume, includes health checks, and has Caddy/Nginx examples.
`.env.example` contains safe defaults only: no secrets/public bind, documented
sample public RPCs, poll/retention defaults, and optional adapter variables.
Document logs, upgrades, backups, restores, rollback, and teardown.

## Definition of done

- A fresh local/Docker setup works without paid credentials and provides the UI.
- A user can discover/import a Robinhood token, validate it, assess/watch it,
  view retained history/swing events, source evidence, flags, rankings, and
  configuration export.
- Rankings are filterable/sortable and every result is explainable from
  retained evidence.
- Route checks are visibly read-only/best effort; missing adapters never make
  false safety claims.
- The app has lint, typecheck, unit/integration/E2E tests, production build,
  Docker verification, docs, backups, and CI clean-install coverage.
- No code path can access a wallet secret or broadcast a transaction.

## Implementation order

1. Scaffold monorepo, config, SQLite migrations, Docker/dev tooling, health,
   foundational documentation.
2. Build adapters, discovery/normalization worker, source-status UI.
3. Build candidate list/detail/watchlists and retained snapshots.
4. Build pure swing engine, charts/event ledger, flags, transparent scoring,
   ranking, and tests.
5. Add quote adapters and recommendation/export.
6. Add alerts, ops/security/backup, E2E coverage, and deployment handoff.
