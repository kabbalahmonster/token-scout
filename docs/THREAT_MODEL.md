# Threat model

Protected assets are the host, SQLite evidence, configuration endpoint URLs,
auth token, and operator attention. Upstream APIs and token metadata are
untrusted; display text is rendered by React, inputs have length/schema bounds,
and raw evidence is size-bounded. Logs redact authorization and never print
configured endpoint query strings.

Mutation routes require a constant-time bearer-token comparison whenever the
API binds non-locally. Read routes also require it unless `PUBLIC_READ=true`;
health/readiness are the narrow exception for orchestrators. Compose keeps
records private by default and publishes only the web proxy on loopback. The
shell renders a token-entry control even when API reads return 401. Put
Caddy/Nginx TLS in front and firewall direct API/database access.

Adapters use AbortController deadlines, bounded retries/backoff, source budgets,
cache, and circuit breakers. Errors shown to clients omit stack traces.

The application has no dependency or environment variable for private keys,
seed phrases, wallets, approvals, or transaction broadcast. Sushi interaction
is HTTP quote-only. A malicious token may still manipulate price/liquidity,
metadata, transfer behavior, proxy code, or quotes; therefore static findings
are warnings and every export requires human review.
