# Configuration

`.env.example` is the exhaustive safe template. Defaults target Robinhood Chain
mainnet (4663), bind locally, use only credential-free providers, poll discovery
every 15 minutes, and poll watched candidates each minute. Watched cadence is
validated to 30–900 seconds.

Discovery defaults to ten GeckoTerminal top-pool pages, ten trending-pool pages,
and three new-pool pages. `DISCOVERY_MIN_LIQUIDITY_USD`,
`DISCOVERY_MIN_VOLUME_24H_USD`, and
`DISCOVERY_MIN_TRANSACTIONS_24H` define the transparent intake gate.
`HISTORY_BACKFILL_HOURS` controls the first-assessment hourly OHLCV bootstrap
(168 hours by default, bounded to 24–720). Keep the page counts and provider
budgets conservative on the key-free endpoint.

`GECKOTERMINAL_REQUESTS_PER_MINUTE` controls the worker's shared discovery and
OHLCV request queue. It defaults to 6 and is bounded to 1–30. Raising it does
not change scheduling priority; it only increases provider throughput. A daily
full-universe rotation at roughly 5,800 candidates needs about 10 requests per
minute after allowing capacity for 15-minute discovery and hourly priority
refreshes. Monitor source health and lower it if the shared IP receives 429s.

## Retained-candidate refresh

`CANDIDATE_REFRESH_ENABLED` defaults to `false`, preserving legacy discovery-
only behavior for existing deployments. When explicitly enabled, the worker
also reassesses unwatched `PASS`/`CAUTION` candidates whose current score is at
least `CANDIDATE_REFRESH_MIN_SCORE` (60 by default), plus every candidate that
has ever held a retained `PASS` verdict. This prevents an evidence gap from
excluding the very coin that needs its history renewed. The oldest assessment
is served first, no more than `CANDIDATE_REFRESH_BATCH_SIZE` (50) candidates
stay queued, and each candidate becomes due after
`CANDIDATE_REFRESH_SECONDS` (3600). Watched candidates keep their separate
faster cadence.

Refresh assessments update the latest market/contract/route evidence and
renew the attributed GeckoTerminal hourly OHLCV window when it is older than
the refresh cadence. Candle fingerprints are stable by pool and timestamp, so
overlapping backfills are deduplicated rather than inflating coverage. Eligible
candidates are considered stale only after three missed refresh intervals;
other unwatched candidates retain the discovery-based freshness rule.

This is intentionally a high-potential refresh lane, not a full-universe poll:
reassessing every rejected discovery lead would exhaust key-free provider
budgets and delay useful work. A rejected or low-score token can re-enter the
lane after ordinary discovery observes enough current evidence to raise it.

For deployments that need a continuously rotating wide view,
`UNIVERSE_REFRESH_ENABLED` adds a slower lane for every other active retained
candidate, including low-score and rejected coins. Its default cadence is
`UNIVERSE_REFRESH_SECONDS=259200` (72 hours), with at most
`UNIVERSE_REFRESH_BATCH_SIZE=5` queued at once. Priority candidates are
excluded from this lane because the hourly lane already covers them.

Queue service is deterministic and weighted. Manual assessments, discovery
cycles, and daily retention remain urgent. Ordinary assessment capacity then
follows a twelve-claim pattern: seven watched assessments, three
discovery/import assessments, one high-potential refresh, and one
full-universe refresh, with empty slots immediately borrowed by the next
available lane. Two exploration slots serve the freshest leads and one serves
the oldest queued lead, keeping intake responsive while steadily retiring debt.
A manual assessment is still the next job claimed after the
current non-preemptible job finishes. Scheduled assessments for the same
contract are coalesced while one is queued or running; a watchlist request
promotes the existing job instead of appending a duplicate. At the current 5,800-candidate scale, a 72-hour rotation averages
about 81 long-tail assessments per hour before rediscovery removes duplicate
need. Provider limiters remain authoritative if individual assessments need
extra calls.

For a daily rotation, set `UNIVERSE_REFRESH_SECONDS=86400` and
`GECKOTERMINAL_REQUESTS_PER_MINUTE=10`. The five-job universe intake cap,
urgent discovery cycles, and weighted assessment shares remain unchanged.

`JOB_LEASE_SECONDS` defaults to 900. A running job whose worker lease is older
than that is safely returned to the queue. DoomScout jobs perform discovery,
read-only assessment, or transactional retention, so retrying an abandoned
lease does not broadcast a transaction or invent evidence.

## Retention and housekeeping

Raw market snapshots, 5-minute aggregates, and hourly aggregates are always
bounded by `RAW_RETENTION_DAYS` (7), `CANDLE_RETENTION_DAYS` (90), and
`HOURLY_RETENTION_DAYS` (730). This is the legacy cleanup contract.

`COMPREHENSIVE_RETENTION_ENABLED` defaults to `false` for backward-compatible
upgrades. When explicitly enabled, the daily worker job also applies:

- `CANDIDATE_ARCHIVE_DAYS=30`: archive candidates no longer seen in discovery,
  snapshots, or pair updates. Watched/watchlisted candidates are never eligible.
- `ARCHIVED_CANDIDATE_RETENTION_DAYS=180`: purge candidates that have remained
  archived for this additional period, together with their dependent evidence.
- `DISCOVERY_RETENTION_DAYS=30`, `APP_EVENT_RETENTION_DAYS=7`, and
  `ALERT_RETENTION_DAYS=90`: expire operational logs. The newest alert for each
  token/kind is preserved beyond its normal horizon.
- `COMPLETED_JOB_RETENTION_DAYS=7` and `FAILED_JOB_RETENTION_DAYS=30`: expire
  terminal queue records. Queued and running jobs are never deleted.
- `ASSESSMENT_DETAIL_RETENTION_DAYS=30`: retain every score, swing study,
  contract scan, and route assessment during the detailed window.
- `ASSESSMENT_DAILY_RETENTION_DAYS=730`: compact older assessment history to
  one record per token/day, then expire it after the long horizon. The newest
  record in every assessment family remains preserved regardless of age.

The long candidate retention must not be shorter than its archive window, and
the daily assessment horizon must not be shorter than the detailed horizon;
invalid combinations fail configuration validation.

Amounts such as `PLANNED_BUDGET_WEI` are integer strings. Swing thresholds are
fractions (`0.05` means 5%). Endpoint URLs may contain credentials for a user's
optional provider but are redacted from startup logs; free public defaults are
always sufficient for core operation.

Production non-local API binding fails closed unless `AUTH_TOKEN` is at least
32 characters. Prefer a loopback bind or private Compose network even with TLS.
Compose publishes only the web proxy on loopback and defaults `PUBLIC_READ=false`.
Enter the bearer token in the persistent top-bar control (or Operations) to
unlock reads and mutations; direct API exposure is never required.
`/api/v1/health` and `/api/v1/ready` are always unauthenticated and contain no
research records.

`TRUST_PROXY` defaults to `false`. Set it to `true` only when the API is
reachable exclusively through a trusted reverse proxy; this makes client-IP
rate limits use the forwarded visitor address. The bundled Compose topology
enables it because the API port is private and all requests pass through its
web proxy.
