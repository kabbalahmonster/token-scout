import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenDatabase } from '@doomscout/database';
import { loadConfig } from '@doomscout/config';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let database: OpenDatabase | undefined; let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); await database?.close(); app = undefined; database = undefined; });

describe('API integration', () => {
  it('serves the candidates contained in a watchlist', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const address = '0x1111111111111111111111111111111111111111' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address, symbol: 'FOX' });
    const list = await database.repositories.createWatchlist({ name: 'Conviction' });
    await database.repositories.addWatchlistItem(list.id, 4663, address);
    const response = await app.inject({ method: 'GET', url: `/api/v1/watchlists/${list.id}/items` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({ candidate: { address, symbol: 'FOX' }, tags: [] });
  });

  it('validates malformed token addresses before queueing work', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const response = await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { address: 'definitely-not-an-address' } });
    expect(response.statusCode).toBe(400);
    expect(await database.repositories.jobStats()).toEqual({});
  });

  it('queues and returns a valid manual assessment', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const response = await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { chainId: 4663, address: '0x1111111111111111111111111111111111111111' } });
    expect(response.statusCode).toBe(202);
    expect(response.json().queue).toMatchObject({ state: 'queued', position: 1, queuedAhead: 0 });
    const status = await app.inject({ method: 'GET', url: `/api/v1/jobs/${response.json().jobId}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: 'queued', position: 1 });
    expect((await database.repositories.listCandidates())[0]?.state).toBe('queued');
  });

  it('lists live and recent assessment activity with retained progress events', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const address = '0x1111111111111111111111111111111111111111';
    const queued = await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { chainId: 4663, address } });
    const id = queued.json().jobId as string;
    await database.repositories.claimJob('api-test');
    await database.repositories.updateJobProgress(id, 'analyzing_swings', 68, 'Measuring retained movement.');

    const activity = await app.inject({ method: 'GET', url: '/api/v1/jobs?state=active&origin=manual&search=0x1111' });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().data[0]).toMatchObject({ id, address, state: 'running', progressStage: 'analyzing_swings', progressPercent: 68 });
    const events = await app.inject({ method: 'GET', url: `/api/v1/job-events?jobId=${id}` });
    expect(events.statusCode).toBe(200);
    const eventBody = events.json<{ data: Array<{ eventType: string }> }>();
    expect(eventBody.data.map((event) => event.eventType)).toEqual(['progress', 'started', 'queued']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs?state=bananas' })).statusCode).toBe(400);
  });

  it('requires bearer auth for non-local mutations', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', AUTH_TOKEN: 'x'.repeat(32), DATABASE_PATH: ':memory:' }), database);
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates' })).statusCode).toBe(401);
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { address: '0x1111111111111111111111111111111111111111' } });
    expect(unauthorized.statusCode).toBe(401);
    const authorized = await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', headers: { authorization: `Bearer ${'x'.repeat(32)}` }, payload: { address: '0x1111111111111111111111111111111111111111' } });
    expect(authorized.statusCode).toBe(202);
  });

  it('keeps health public while allowing public reads and protecting writes in Compose mode', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', AUTH_TOKEN: 'x'.repeat(32), PUBLIC_READ: 'true', DATABASE_PATH: ':memory:' }), database);
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { address: '0x1111111111111111111111111111111111111111' } })).statusCode).toBe(401);
  });

  it('protects mutations when production is published through a loopback reverse proxy', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1', AUTH_TOKEN: 'x'.repeat(32), PUBLIC_READ: 'true', DATABASE_PATH: ':memory:' }), database);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', payload: { address: '0x1111111111111111111111111111111111111111' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/candidates/assess', headers: { authorization: `Bearer ${'x'.repeat(32)}` }, payload: { address: '0x1111111111111111111111111111111111111111' } })).statusCode).toBe(202);
  });

  it('rejects unsupported-chain imports before creating candidates or jobs', async () => {
    database = openDatabase(':memory:');
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const response = await app.inject({ method: 'POST', url: '/api/v1/candidates/import', payload: { chainId: 8453, addresses: ['0x1111111111111111111111111111111111111111'] } });
    expect(response.statusCode).toBe(422);
    expect(await database.repositories.listCandidates()).toHaveLength(0);
    expect(await database.repositories.jobStats()).toEqual({});
  });

  it('publishes OpenAPI generated from route schemas', async () => {
    database = openDatabase(':memory:'); app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/api/v1/candidates']).toBeDefined();
  });

  it('accepts table sort columns and rejects unknown ones', async () => {
    database = openDatabase(':memory:'); app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }), database);
    await database.repositories.upsertCandidate({ chainId: 4663, address: '0x1111111111111111111111111111111111111111' });
    const page = await app.inject({ method: 'GET', url: '/api/v1/candidates?limit=2000' });
    expect(page.statusCode).toBe(200);
    expect(page.json().meta.total).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?limit=2001' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?minPairAgeDays=30&maxPairAgeDays=90' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?minPairAgeDays=-1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?sort=market_cap&direction=desc' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?sort=events_per_day&direction=desc' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?assetType=crypto&sort=asset_type&direction=asc' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?assetType=equity' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?sort=nope' })).statusCode).toBe(400);
  });

  it('rate limits repeated requests', async () => {
    database = openDatabase(':memory:'); app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent' }), database);
    let response;
    for (let index = 0; index < 121; index += 1) response = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '192.0.2.10' });
    expect(response?.statusCode).toBe(429);
  });

  it('uses forwarded client addresses only when the trusted proxy setting is enabled', async () => {
    database = openDatabase(':memory:'); app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', TRUST_PROXY: 'true' }), database);
    let response;
    for (let index = 0; index < 121; index += 1) response = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.10' } });
    expect(response?.statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.11' } })).statusCode).toBe(200);
  });
});
