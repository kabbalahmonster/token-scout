# Architecture

DoomScout is deliberately split into a latency-free web/API path and an
upstream-facing worker. The API only reads retained evidence or enqueues an
idempotent job. The worker owns discovery, polling, RPC/static analysis,
read-only quote requests, swing studies, and scoring.

```text
React/Vite ──REST/SSE──> Fastify ──Kysely──> SQLite (WAL)
                            │                    ▲
                            └── jobs ────────────┤
                                                 │
                       Worker ── free adapters ──┘
```

`packages/domain` contains deterministic, versioned calculations and no I/O.
`packages/adapters` converts untrusted provider responses into normalized
values while enforcing timeouts, retries, caches, budgets, and circuit breaks.
`packages/database` owns migrations and repositories. Every entity retains a
chain ID so Base/Ethereum can be introduced without reshaping core tables.

No component accepts keys, constructs transactions, signs, approves, or calls
`eth_sendRawTransaction`. Recommendation exports are data for operator review.
