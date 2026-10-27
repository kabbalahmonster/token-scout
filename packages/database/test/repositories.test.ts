import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenDatabase } from '../src/index.js';

let database: OpenDatabase | undefined;
afterEach(async () => { await database?.close(); database = undefined; });

describe('repositories', () => {
  it('deduplicates immutable snapshots by evidence fingerprint', async () => {
    database = openDatabase(':memory:');
    const address = '0x1111111111111111111111111111111111111111' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address });
    const snapshot = { chainId: 4663, tokenAddress: address, pairAddress: null, dex: null, priceNative: '1', priceUsd: null, liquidityUsd: null, fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: null, buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: null, ingestedAt: new Date().toISOString(), source: 'fixture', fingerprint: 'same' };
    expect(await database.repositories.insertSnapshot(snapshot)).toBeTypeOf('number');
    expect(await database.repositories.insertSnapshot(snapshot)).toBeNull();
    expect(await database.repositories.history(4663, address)).toHaveLength(1);
  });

  it('claims each idempotent job once', async () => {
    database = openDatabase(':memory:');
    await database.repositories.enqueue('assess', '4663:abc', { ok: true });
    await database.repositories.enqueue('assess', '4663:abc', { ok: true });
    expect(await database.repositories.claimJob('test')).not.toBeNull();
    expect(await database.repositories.claimJob('test')).toBeNull();
  });

  it('reports the current event tail for new live-stream subscribers', async () => {
    database = openDatabase(':memory:');
    expect(await database.repositories.latestEventId()).toBe(0);
    await database.repositories.emit('score.updated', { score: 42 });
    const tail = await database.repositories.latestEventId();
    expect(tail).toBeGreaterThan(0);
    expect(await database.repositories.eventsAfter(tail)).toEqual([]);
  });

  it('sorts candidates by table columns in either direction', async () => {
    database = openDatabase(':memory:');
    const alpha = '0x1111111111111111111111111111111111111111' as const;
    const zulu = '0x2222222222222222222222222222222222222222' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address: zulu, symbol: 'ZULU' });
    await database.repositories.upsertCandidate({ chainId: 4663, address: alpha, symbol: 'ALPHA' });
    expect((await database.repositories.listCandidates({ sort: 'token', direction: 'asc' })).map((candidate) => candidate.symbol)).toEqual(['ALPHA', 'ZULU']);
    expect((await database.repositories.listCandidates({ sort: 'token', direction: 'desc' })).map((candidate) => candidate.symbol)).toEqual(['ZULU', 'ALPHA']);
    expect((await database.repositories.listCandidates({ sort: 'token', direction: 'asc', limit: 1 })).map((candidate) => candidate.symbol)).toEqual(['ALPHA']);
  });

  it('filters and sorts additive asset classifications without migrating candidate rows', async () => {
    database = openDatabase(':memory:');
    const crypto = '0x1111111111111111111111111111111111111111' as const;
    const stock = '0x2222222222222222222222222222222222222222' as const;
    const stablecoin = '0x3333333333333333333333333333333333333333' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address: crypto, symbol: 'WETH', name: 'Wrapped Ether' });
    await database.repositories.upsertCandidate({ chainId: 4663, address: stock, symbol: 'GME', name: 'GameStop • Robinhood Token' });
    await database.repositories.upsertCandidate({ chainId: 4663, address: stablecoin, symbol: 'USDG', name: 'Global Dollar' });
    expect((await database.repositories.listCandidates({ assetType: 'crypto' })).map((candidate) => candidate.address)).toEqual([crypto]);
    expect((await database.repositories.listCandidates({ sort: 'asset_type', direction: 'asc' })).map((candidate) => candidate.assetType)).toEqual(['crypto', 'stablecoin', 'tokenized_stock']);
  });

  it('allows a recurring dedupe key after completion without colliding', async () => {
    database = openDatabase(':memory:');
    expect(await database.repositories.enqueue('discover', 'same-window', {})).toBeTypeOf('string');
    const first = await database.repositories.claimJob('test');
    expect(first).not.toBeNull();
    await database.repositories.finishJob(first!.id);
    expect(await database.repositories.enqueue('discover', 'same-window', {})).toBeTypeOf('string');
    const second = await database.repositories.claimJob('test');
    expect(second).not.toBeNull();
    await expect(database.repositories.finishJob(second!.id)).resolves.toBeUndefined();
    expect(await database.repositories.jobStats()).toEqual({ completed: 2 });
  });

  it('enqueues a scheduled time bucket only once even after completion', async () => {
    database = openDatabase(':memory:');
    expect(await database.repositories.enqueueScheduled('discover', 'bucket:1', {})).toBeTypeOf('string');
    const first = await database.repositories.claimJob('test');
    await database.repositories.finishJob(first!.id);
    expect(await database.repositories.enqueueScheduled('discover', 'bucket:1', {})).toBeNull();
    expect(await database.repositories.jobStats()).toEqual({ completed: 1 });
  });

  it('applies and clears a canonical-pair override deterministically', async () => {
    database = openDatabase(':memory:');
    const address = '0x1111111111111111111111111111111111111111' as const;
    const shallow = '0x2222222222222222222222222222222222222222' as const;
    const deep = '0x3333333333333333333333333333333333333333' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address });
    await database.repositories.upsertPair({ chainId: 4663, tokenAddress: address, pairAddress: shallow, dex: 'fixture', url: null, quoteTokenAddress: null, createdAt: null, liquidityUsd: '100' });
    await database.repositories.upsertPair({ chainId: 4663, tokenAddress: address, pairAddress: deep, dex: 'fixture', url: null, quoteTokenAddress: null, createdAt: null, liquidityUsd: '1000' });
    await database.repositories.setCanonicalPairOverride(4663, address, shallow);
    expect((await database.repositories.getCandidate(4663, address))?.canonicalPair).toBe(shallow);
    await database.repositories.setCanonicalPairOverride(4663, address, null);
    expect((await database.repositories.getCandidate(4663, address))?.canonicalPair).toBe(deep);
  });

  it('builds 5-minute and hourly aggregates while retaining decimal price strings', async () => {
    database = openDatabase(':memory:');
    const address = '0x1111111111111111111111111111111111111111' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address });
    const now = new Date().toISOString();
    await database.repositories.insertSnapshot({ chainId: 4663, tokenAddress: address, pairAddress: null, dex: null, priceNative: '0.000000000000000001', priceUsd: null, liquidityUsd: null, fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: null, buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: null, ingestedAt: now, source: 'fixture', fingerprint: 'aggregate-one' });
    await database.repositories.insertSnapshot({ chainId: 4663, tokenAddress: address, pairAddress: null, dex: null, priceNative: '0.0000000000000000011', priceUsd: null, liquidityUsd: null, fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: null, buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: null, ingestedAt: new Date(Date.parse(now) + 1000).toISOString(), source: 'fixture', fingerprint: 'aggregate-two' });
    const aggregate = await database.db.selectFrom('market_aggregates').selectAll().where('resolution_seconds', '=', 300).executeTakeFirstOrThrow();
    expect(aggregate.sample_count).toBe(2);
    expect(aggregate.high_price).toBe('1.1e-18');
    expect(aggregate.low_price).toBe('1e-18');
  });
});
