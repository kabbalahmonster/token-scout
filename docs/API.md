# API

Fastify generates the authoritative OpenAPI document from route schemas. With
the API running, use `/docs` or `/docs/json`. `POST`/`DELETE` routes accept
`Authorization: Bearer <AUTH_TOKEN>` on non-local deployments. Reads require
the same token unless public read mode was explicitly enabled.

SSE at `/api/v1/events` emits retained score changes and supports
`Last-Event-ID`. History exports support JSON and CSV. Recommendation exports
support JSON and `.env`, both carrying schema/methodology versions and an
operator-review marker. The API never contains an execution endpoint.
