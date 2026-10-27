import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenDatabase } from '@doomscout/database';
import { loadConfig } from '@doomscout/config';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let database: OpenDatabase | undefined; let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); await database?.close(); app = undefined; database = undefined; });

describe('API integration', () => {
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
    expect((await database.repositories.listCandidates())[0]?.state).toBe('queued');
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
    expect((await app.inject({ method: 'GET', url: '/api/v1/candidates?sort=token&direction=asc' })).statusCode).toBe(200);
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
