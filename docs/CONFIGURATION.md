# Configuration

`.env.example` is the exhaustive safe template. Defaults target Robinhood Chain
mainnet (4663), bind locally, use only credential-free providers, poll discovery
every 15 minutes, and poll watched candidates each minute. Watched cadence is
validated to 30–900 seconds.

Discovery defaults to ten GeckoTerminal top-pool pages plus five new-pool
pages. `DISCOVERY_MIN_LIQUIDITY_USD`, `DISCOVERY_MIN_VOLUME_24H_USD`, and
`DISCOVERY_MIN_TRANSACTIONS_24H` define the transparent intake gate.
`HISTORY_BACKFILL_HOURS` controls the first-assessment hourly OHLCV bootstrap
(168 hours by default, bounded to 24–720). Keep the page counts and provider
budgets conservative on the key-free endpoint.

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
