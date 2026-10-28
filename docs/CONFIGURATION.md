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
