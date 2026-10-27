import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from '@doomscout/config';
import type { OpenDatabase } from '@doomscout/database';
import { generateRecommendation, isEvmAddress, normalizeAddress, recommendationToEnv, type AssetType, type CandidateState, type Verdict } from '@doomscout/domain';

const addressParamSchema = { type: 'object', required: ['chainId', 'address'], properties: { chainId: { type: 'integer', minimum: 1 }, address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' } } } as const;

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ') || token.length === 0) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function csvEscape(value: unknown): string {
  let string: string;
  if (value === null || value === undefined) string = '';
  else if (typeof value === 'string') string = value;
  else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') string = value.toString();
  else string = JSON.stringify(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export async function buildApp(config: AppConfig, database: OpenDatabase): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] }, trustProxy: config.TRUST_PROXY, bodyLimit: 1_000_000 });
  const liveStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of liveStreams) stream.end(); liveStreams.clear(); });
  await app.register(cors, { origin: config.NODE_ENV === 'development' ? [/^http:\/\/(127\.0\.0\.1|localhost):\d+$/] : false });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', keyGenerator: (request) => request.ip });
  await app.register(swagger, { openapi: { info: { title: 'DoomScout API', version: '0.1.0', description: 'Read-only token research API. Mutation endpoints enqueue research work; no route signs or broadcasts transactions.' }, servers: [{ url: '/'}], tags: [{ name: 'health' }, { name: 'candidates' }, { name: 'watchlists' }, { name: 'operations' }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (request, reply) => {
    // Liveness/readiness must remain callable by container orchestrators even
    // when every other read is private. They expose no candidate evidence.
    if (request.url === '/api/v1/health' || request.url === '/api/v1/ready') return;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    // A loopback bind is not an authentication boundary: a reverse proxy can
    // still make it internet-facing. Production always supplies a token, and
    // every mutation requires it regardless of the socket bind address.
    const needsAuth = Boolean(config.AUTH_TOKEN) && (isWrite || !config.PUBLIC_READ);
    if (needsAuth && !authorized(request.headers.authorization, config.AUTH_TOKEN)) return reply.code(401).send({ error: 'unauthorized', message: 'A valid bearer token is required.' });
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = error instanceof Error ? error : new Error('Unknown request failure');
    const statusCode = (normalized as Error & { statusCode?: number }).statusCode;
    request.log.error({ err: { name: normalized.name, message: normalized.message }, requestId: request.id }, 'request failed');
    const status = typeof statusCode === 'number' && statusCode < 500 ? statusCode : 500;
    void reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'request_error', message: status >= 500 ? 'The request could not be completed.' : normalized.message, requestId: request.id });
  });

  app.get('/api/v1/health', { schema: { tags: ['health'], response: { 200: { type: 'object', properties: { status: { type: 'string' }, database: { type: 'boolean' }, time: { type: 'string' } } } } } }, async () => ({ status: 'ok', database: await database.repositories.healthy(), time: new Date().toISOString() }));
  app.get('/api/v1/ready', { schema: { tags: ['health'] } }, async (_request, reply) => (await database.repositories.healthy()) ? { status: 'ready' } : reply.code(503).send({ status: 'not_ready' }));

  app.get('/api/v1/candidates', { schema: { tags: ['candidates'], querystring: { type: 'object', properties: { state: { type: 'string' }, watched: { type: 'boolean' }, verdict: { type: 'string' }, assetType: { enum: ['crypto', 'tokenized_stock', 'stablecoin'] }, minScore: { type: 'number' }, minLiquidityUsd: { type: 'number' }, minVolumeUsd: { type: 'number' }, routeState: { type: 'string' }, riskFlag: { type: 'string', maxLength: 80 }, search: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 }, sort: { enum: ['token', 'asset_type', 'score', 'verdict', 'state', 'swing', 'liquidity', 'market_cap', 'volume', 'volume_liquidity', 'age', 'route', 'route_recovery', 'flags', 'updated'] }, direction: { enum: ['asc', 'desc'] } } } } }, async (request) => {
    const query = request.query as any;
    return { data: await database.repositories.listCandidates({
      ...(query.state ? { state: query.state as CandidateState } : {}),
      ...(query.watched === undefined ? {} : { watched: Boolean(query.watched) }),
      ...(query.verdict ? { verdict: query.verdict as Verdict } : {}),
      ...(query.assetType ? { assetType: query.assetType as AssetType } : {}),
      ...(query.minScore === undefined ? {} : { minScore: Number(query.minScore) }),
      ...(query.minLiquidityUsd === undefined ? {} : { minLiquidityUsd: Number(query.minLiquidityUsd) }),
      ...(query.minVolumeUsd === undefined ? {} : { minVolumeUsd: Number(query.minVolumeUsd) }),
      ...(query.routeState ? { routeState: String(query.routeState) } : {}),
      ...(query.riskFlag ? { riskFlag: String(query.riskFlag) } : {}),
      ...(query.search ? { search: String(query.search) } : {}),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.direction ? { direction: query.direction } : {})
    }), meta: { generatedAt: new Date().toISOString() } };
  });

  app.post('/api/v1/candidates/assess', { schema: { tags: ['candidates'], body: { type: 'object', additionalProperties: false, required: ['address'], properties: { chainId: { type: 'integer', minimum: 1, default: 4663 }, address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' } } } } }, async (request, reply) => {
    const body = request.body as { chainId?: number; address: string };
    const chainId = body.chainId ?? config.CHAIN_ID;
    if (chainId !== config.CHAIN_ID) return reply.code(422).send({ error: 'unsupported_chain' });
    const address = normalizeAddress(body.address);
    await database.repositories.upsertCandidate({ chainId, address, state: 'queued' });
    const jobId = await database.repositories.enqueue('assess', `manual:${chainId}:${address}:${Date.now()}`, { chainId, address });
    return reply.code(202).send({ jobId, chainId, address, state: 'queued' });
  });

  app.post('/api/v1/candidates/import', { schema: { tags: ['candidates'], body: { type: 'object', additionalProperties: false, properties: { chainId: { type: 'integer', minimum: 1 }, addresses: { type: 'array', maxItems: 500, items: { type: 'string' } }, csv: { type: 'string', maxLength: 100000 } }, anyOf: [{ required: ['addresses'] }, { required: ['csv'] }] } } }, async (request, reply) => {
    const body = request.body as { chainId?: number; addresses?: string[]; csv?: string };
    const chainId = body.chainId ?? config.CHAIN_ID;
    if (chainId !== config.CHAIN_ID) return reply.code(422).send({ error: 'unsupported_chain' });
    const values = [...(body.addresses ?? []), ...(body.csv?.split(/[\r\n,;]+/) ?? [])].map((value) => value.trim()).filter(Boolean);
    const unique = [...new Set(values)];
    const invalid = unique.filter((value) => !isEvmAddress(value));
    if (invalid.length) return reply.code(422).send({ error: 'invalid_addresses', invalid: invalid.slice(0, 20) });
    for (const value of unique) { const address = normalizeAddress(value); await database.repositories.upsertCandidate({ chainId, address, state: 'queued' }); await database.repositories.enqueue('assess', `import:${chainId}:${address}:${Date.now()}`, { chainId, address }); }
    return reply.code(202).send({ accepted: unique.length, estimatedRequests: unique.length * 6, message: 'Bulk imports are rate-budgeted by the worker and may take time.' });
  });

  app.get('/api/v1/candidates/:chainId/:address', { schema: { tags: ['candidates'], params: addressParamSchema } }, async (request, reply) => {
    const params = request.params as { chainId: string; address: string }; const chainId = Number(params.chainId); const address = normalizeAddress(params.address);
    const candidate = await database.repositories.getCandidate(chainId, address); if (!candidate) return reply.code(404).send({ error: 'not_found' });
    const [swings, route, contract, score, pairs] = await Promise.all([database.repositories.latestSwingStudy(chainId, address), database.repositories.latestRouteAssessment(chainId, address), database.repositories.latestContractScan(chainId, address), database.repositories.latestScore(chainId, address), database.repositories.listPairs(chainId, address)]);
    return { candidate, swings, route, contract, score, pairs };
  });
  app.patch('/api/v1/candidates/:chainId/:address/canonical-pair', { schema: { tags: ['candidates'], params: addressParamSchema, body: { type: 'object', additionalProperties: false, required: ['pairAddress'], properties: { pairAddress: { anyOf: [{ type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, { type: 'null' }] } } } } }, async (request, reply) => { const params = request.params as { chainId: string; address: string }; const body = request.body as { pairAddress: string | null }; await database.repositories.setCanonicalPairOverride(Number(params.chainId), normalizeAddress(params.address), body.pairAddress ? normalizeAddress(body.pairAddress) : null); return reply.code(204).send(); });

  app.get('/api/v1/candidates/:chainId/:address/history', { schema: { tags: ['candidates'], params: addressParamSchema, querystring: { type: 'object', properties: { since: { type: 'string', format: 'date-time' }, limit: { type: 'integer', minimum: 1, maximum: 100000 }, format: { enum: ['json', 'csv'] } } } } }, async (request, reply) => {
    const params = request.params as { chainId: string; address: string }; const query = request.query as any;
    const fullHistory = await database.repositories.analyticsHistory(Number(params.chainId), normalizeAddress(params.address), config.RAW_RETENTION_DAYS, config.CANDLE_RETENTION_DAYS, config.HOURLY_RETENTION_DAYS, query.limit ? Number(query.limit) : 20_000);
    const history = query.since ? fullHistory.filter((snapshot) => snapshot.ingestedAt >= String(query.since)) : fullHistory;
    if (query.format === 'csv') { const keys = ['id', 'chainId', 'tokenAddress', 'pairAddress', 'priceNative', 'priceUsd', 'liquidityUsd', 'volume24hUsd', 'sourceTime', 'ingestedAt', 'source', 'fingerprint']; const lines = [keys.join(','), ...history.map((row) => keys.map((key) => csvEscape((row as any)[key])).join(','))]; return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="doomscout-history.csv"').send(`# schema=1.0.0 swing_algorithm=1.0.0\n${lines.join('\n')}\n`); }
    return { data: history, methodology: { schemaVersion: '1.0.0', immutableSnapshots: true, unavailableIsNull: true } };
  });

  app.get('/api/v1/candidates/:chainId/:address/swings', { schema: { tags: ['candidates'], params: addressParamSchema } }, async (request, reply) => { const params = request.params as { chainId: string; address: string }; const study = await database.repositories.latestSwingStudy(Number(params.chainId), normalizeAddress(params.address)); return study ?? reply.code(404).send({ error: 'not_assessed' }); });

  app.get('/api/v1/watchlists', { schema: { tags: ['watchlists'] } }, async () => ({ data: await database.repositories.listWatchlists() }));
  app.post('/api/v1/watchlists', { schema: { tags: ['watchlists'], body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, labels: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } }, assessmentBudgetWei: { type: 'string', pattern: '^\\d+$' }, intendedPositionCount: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async (request, reply) => reply.code(201).send(await database.repositories.createWatchlist(request.body as any)));
  app.post('/api/v1/watchlists/:id/items', { schema: { tags: ['watchlists'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: false, required: ['chainId', 'address'], properties: { chainId: { type: 'integer' }, address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } } } } } }, async (request, reply) => { const params = request.params as { id: string }; const body = request.body as { chainId: number; address: string; tags?: string[] }; await database.repositories.addWatchlistItem(params.id, body.chainId, normalizeAddress(body.address), body.tags); return reply.code(204).send(); });
  app.delete('/api/v1/watchlists/:id/items/:chainId/:address', { schema: { tags: ['watchlists'], params: { type: 'object', required: ['id', 'chainId', 'address'], properties: { id: { type: 'string', format: 'uuid' }, chainId: { type: 'integer' }, address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' } } } } }, async (request, reply) => { const params = request.params as { id: string; chainId: string; address: string }; await database.repositories.removeWatchlistItem(params.id, Number(params.chainId), normalizeAddress(params.address)); return reply.code(204).send(); });

  async function recommendation(chainId: number, address: ReturnType<typeof normalizeAddress>) {
    const [candidate, latest, swings, score] = await Promise.all([database.repositories.getCandidate(chainId, address), database.repositories.latestSnapshot(chainId, address), database.repositories.latestSwingStudy(chainId, address), database.repositories.latestScore(chainId, address)]);
    if (!candidate || !score) return null;
    return generateRecommendation({ chainId, tokenAddress: address, pairAddress: candidate.canonicalPair, latest, swings, score, plannedBudgetWei: config.PLANNED_BUDGET_WEI, positionCount: config.POSITION_COUNT });
  }
  app.get('/api/v1/recommendations/:chainId/:address', { schema: { tags: ['candidates'], params: addressParamSchema } }, async (request, reply) => { const params = request.params as { chainId: string; address: string }; const draft = await recommendation(Number(params.chainId), normalizeAddress(params.address)); return draft ?? reply.code(404).send({ error: 'not_assessed' }); });
  app.get('/api/v1/export/:chainId/:address', { schema: { tags: ['candidates'], params: addressParamSchema, querystring: { type: 'object', properties: { format: { enum: ['json', 'env'] } } } } }, async (request, reply) => { const params = request.params as { chainId: string; address: string }; const query = request.query as { format?: string }; const draft = await recommendation(Number(params.chainId), normalizeAddress(params.address)); if (!draft) return reply.code(404).send({ error: 'not_assessed' }); if (query.format === 'env') return reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', 'attachment; filename="doomscout-review.env"').send(recommendationToEnv(draft)); return reply.header('content-disposition', 'attachment; filename="doomscout-review.json"').send(draft); });

  app.get('/api/v1/sources/status', { schema: { tags: ['operations'] } }, async () => ({ data: await database.repositories.sourceStatuses(), generatedAt: new Date().toISOString() }));
  app.get('/api/v1/operations', { schema: { tags: ['operations'] } }, async () => ({ database: await database.repositories.healthy(), jobs: await database.repositories.jobStats(), sources: await database.repositories.sourceStatuses(), process: { uptimeSeconds: process.uptime(), node: process.version, memory: process.memoryUsage() } }));
  app.get('/api/v1/alerts', { schema: { tags: ['operations'], querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } } } }, async (request) => ({ data: await database.repositories.listAlerts(Number((request.query as { limit?: number }).limit ?? 100)) }));
  app.post('/api/v1/alerts/:id/read', { schema: { tags: ['operations'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => { await database.repositories.markAlertRead((request.params as { id: string }).id); return reply.code(204).send(); });

  app.get('/api/v1/events', { schema: { tags: ['operations'], querystring: { type: 'object', properties: { lastEventId: { type: 'integer', minimum: 0 } } } } }, async (request, reply) => {
    const query = request.query as { lastEventId?: number };
    const suppliedCursor = request.headers['last-event-id'] ?? query.lastEventId;
    // A new browser session wants live updates, not a replay of every event
    // retained since installation. Replaying the backlog caused one cache
    // invalidation (and HTTP request) per historical score event. Browser
    // reconnects still supply Last-Event-ID and therefore resume losslessly.
    let lastId = suppliedCursor === undefined ? await database.repositories.latestEventId() : Number(suppliedCursor);
    reply.hijack();
    liveStreams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = async () => { const events = await database.repositories.eventsAfter(lastId); for (const event of events) { lastId = event.id; reply.raw.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`); } reply.raw.write(`: keepalive ${Date.now()}\n\n`); };
    await send();
    const timer = setInterval(() => { void send().catch(() => reply.raw.end()); }, 5000);
    request.raw.on('close', () => { clearInterval(timer); liveStreams.delete(reply.raw); });
  });

  return app;
}
