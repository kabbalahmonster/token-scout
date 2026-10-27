# Development and contribution

Node 22 and the pinned pnpm package manager are required. Run `pnpm lint`,
`pnpm typecheck`, `pnpm test`, and `pnpm build` before proposing a change.
Domain-rule tests must name the protected rule. Adapter tests use fixtures or a
fake fetch function and never depend on a public service.

Add migrations; do not edit an applied migration. Keep calculations pure and
version their methodology. New providers implement the same timeout, budget,
cache, retry, circuit, status, and null-semantics contract. No paid/keyed source
may become required for core operation.

Do not add wallet libraries, transaction signing, approvals, automated bot
control, or secret-bearing exports. A recommendation field that the target bot
does not support must be labelled “needs bot code,” not silently emitted.
