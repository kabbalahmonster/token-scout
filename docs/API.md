# API

Fastify generates the authoritative OpenAPI document from route schemas. With
the API running, use `/docs` or `/docs/json`. `POST`/`DELETE` routes accept
`Authorization: Bearer <AUTH_TOKEN>` on non-local deployments. Reads require
the same token unless public read mode was explicitly enabled.

SSE at `/api/v1/events` emits retained score changes and supports
`Last-Event-ID`. History exports support JSON and CSV. Recommendation exports
support JSON and `.env`, both carrying schema/methodology versions and an
operator-review marker. A manual assessment response includes its initial queue
position and estimated wait; `GET /api/v1/jobs/:jobId` provides live queued,
running, completed, or failed status for UI polling.

Queue observability is read-only:

- `GET /api/v1/jobs` lists active and retained jobs with filters for state,
  kind, origin, and contract/symbol/job search. Queue positions use the same
  weighted lane order as the worker, and estimates use recent median completion times with
  bounded fallbacks.
- `GET /api/v1/job-events` returns the retained exploration timeline globally
  or for one `jobId`: contract validation, market collection, pool selection,
  history import, swing analysis, route simulation, scoring, retries, and the
  terminal result.
- Completed assessment jobs snapshot their verdict, score, confidence, start,
  finish, and duration so later candidate refreshes do not rewrite history.

Error text is length-bounded and strips URL query strings and credential-like
values before persistence. The API never contains an execution endpoint.
