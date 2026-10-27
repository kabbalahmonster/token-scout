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
