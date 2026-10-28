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

  it('hides retired explorer-verification evidence from repository results', async () => {
    database = openDatabase(':memory:');
    const address = '0x1111111111111111111111111111111111111111' as const;
    await database.repositories.upsertCandidate({ chainId: 4663, address });
    await database.repositories.saveContractScan({
      chainId: 4663,
      address,
      version: 'fixture',
      codeHash: null,
      scannedAt: new Date().toISOString(),
      metadata: { symbol: null, name: null, decimals: null, totalSupply: null },
      flags: [
        { code: 'source_verification', label: 'retired', state: 'unknown', severity: 'info', confidence: 0, explanation: 'retired', evidence: [] },
        { code: 'owner_status', label: 'Owner status', state: 'unknown', severity: 'info', confidence: 0, explanation: 'unknown', evidence: [] }
      ]
    });
    expect((await database.repositories.getCandidate(4663, address))?.flags.map((flag) => flag.code)).toEqual(['owner_status']);
    expect((await database.repositories.latestContractScan(4663, address))?.flags.map((flag) => flag.code)).toEqual(['owner_status']);
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

  it('filters candidate markets by observed pair age', async () => {
    database = openDatabase(':memory:');
    const established = '0x1111111111111111111111111111111111111111' as const;
    const newLaunch = '0x2222222222222222222222222222222222222222' as const;
    for (const [address, ageDays] of [[established, 60], [newLaunch, 2]] as const) {
      await database.repositories.upsertCandidate({ chainId: 4663, address });
      await database.repositories.insertSnapshot({ chainId: 4663, tokenAddress: address, pairAddress: null, dex: 'fixture', priceNative: null, priceUsd: '1', liquidityUsd: '100000', fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: '10000', buys24h: 10, sells24h: 10, pairCreatedAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(), sourceTime: null, ingestedAt: new Date().toISOString(), source: 'fixture', fingerprint: `age-${ageDays}` });
    }
    expect((await database.repositories.listCandidates({ minPairAgeDays: 30 })).map((candidate) => candidate.address)).toEqual([established]);
    expect((await database.repositories.listCandidates({ maxPairAgeDays: 7 })).map((candidate) => candidate.address)).toEqual([newLaunch]);
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

  it('bounds operational and assessment history while preserving watched candidates and latest evidence', async () => {
    database = openDatabase(':memory:');
    const now = new Date('2026-10-28T12:00:00.000Z');
    const watched = '0x1111111111111111111111111111111111111111' as const;
    const dormant = '0x2222222222222222222222222222222222222222' as const;
    const expiredArchive = '0x3333333333333333333333333333333333333333' as const;
    const active = '0x4444444444444444444444444444444444444444' as const;
    for (const address of [watched, dormant, expiredArchive, active]) await database.repositories.upsertCandidate({ chainId: 4663, address });
    await database.db.updateTable('candidates').set({ watched: 1, state: 'watched', discovered_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' }).where('address', '=', watched).execute();
    await database.db.updateTable('candidates').set({ discovered_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }).where('address', '=', dormant).execute();
    await database.db.updateTable('candidates').set({ state: 'archived', discovered_at: '2025-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }).where('address', '=', expiredArchive).execute();
    await database.db.updateTable('candidates').set({ discovered_at: '2025-01-01T00:00:00.000Z', updated_at: '2026-10-27T00:00:00.000Z' }).where('address', '=', active).execute();
    await database.db.insertInto('discovery_records').values({ chain_id: 4663, token_address: active, source: 'fixture', source_id: null, source_time: null, ingested_at: '2026-10-27T00:00:00.000Z', outcome: 'accepted', error_code: null, fingerprint: 'recent-active' }).execute();
    await database.db.insertInto('discovery_records').values({ chain_id: 4663, token_address: dormant, source: 'fixture', source_id: null, source_time: null, ingested_at: '2026-01-01T00:00:00.000Z', outcome: 'accepted', error_code: null, fingerprint: 'old-dormant' }).execute();

    const score = (address: string, at: string, value: number) => database!.db.insertInto('score_history').values({ chain_id: 4663, token_address: address, score_version: 'fixture', calculated_at: at, score: value, confidence: 50, verdict: 'CAUTION', result_json: '{}' }).execute();
    await score(watched, '2024-01-01T00:00:00.000Z', 1); // newest for this token survives every horizon
    await score(active, '2026-08-20T01:00:00.000Z', 10);
    await score(active, '2026-08-20T20:00:00.000Z', 20); // daily representative
    await score(active, '2026-10-27T00:00:00.000Z', 30); // recent detail
    await score(active, '2024-01-01T00:00:00.000Z', 5); // backdated insert must not displace the chronologically latest record
    await database.db.insertInto('swing_studies').values({ chain_id: 4663, token_address: active, algorithm_version: 'fixture', generated_at: '2026-08-20T01:00:00.000Z', parameters_json: '{}', result_json: '{}' }).execute();
    await database.db.insertInto('swing_studies').values({ chain_id: 4663, token_address: active, algorithm_version: 'fixture', generated_at: '2026-08-20T20:00:00.000Z', parameters_json: '{}', result_json: '{}' }).execute();

    for (const [id, state, updatedAt] of [
      ['completed-old', 'completed', '2026-01-01T00:00:00.000Z'],
      ['failed-old', 'failed', '2026-01-01T00:00:00.000Z'],
      ['queued-old', 'queued', '2026-01-01T00:00:00.000Z']
    ] as const) await database.db.insertInto('jobs').values({ id, kind: 'fixture', dedupe_key: id, payload_json: '{}', state, run_after: updatedAt, attempts: 0, locked_at: null, locked_by: null, last_error: null, created_at: updatedAt, updated_at: updatedAt }).execute();
    await database.db.insertInto('app_events').values({ event_type: 'old', payload_json: '{}', created_at: '2026-01-01T00:00:00.000Z' }).execute();
    await database.db.insertInto('app_events').values({ event_type: 'recent', payload_json: '{}', created_at: '2026-10-27T00:00:00.000Z' }).execute();
    await database.db.insertInto('alerts').values({ id: 'alert-oldest', chain_id: 4663, token_address: active, kind: 'fixture', severity: 'warning', message: 'old', evidence_json: '{}', created_at: '2026-01-01T00:00:00.000Z', read_at: null }).execute();
    await database.db.insertInto('alerts').values({ id: 'alert-latest', chain_id: 4663, token_address: active, kind: 'fixture', severity: 'warning', message: 'latest', evidence_json: '{}', created_at: '2026-02-01T00:00:00.000Z', read_at: null }).execute();

    const report = await database.repositories.housekeeping({ rawDays: 7, fiveMinuteDays: 90, hourlyDays: 730, candidateArchiveDays: 30, archivedCandidateDays: 180, discoveryDays: 30, completedJobDays: 7, failedJobDays: 30, alertDays: 90, appEventDays: 7, assessmentDetailDays: 30, assessmentDailyDays: 730 }, now);
    expect(report.candidatesArchived).toBe(1);
    expect(report.candidatesDeleted).toBe(1);
    expect((await database.repositories.getCandidate(4663, watched))?.state).toBe('watched');
    expect((await database.repositories.getCandidate(4663, dormant))?.state).toBe('archived');
    expect(await database.repositories.getCandidate(4663, expiredArchive)).toBeNull();
    expect((await database.repositories.getCandidate(4663, active))?.state).not.toBe('archived');
    expect((await database.db.selectFrom('score_history').selectAll().where('token_address', '=', watched).execute())).toHaveLength(1);
    expect((await database.db.selectFrom('score_history').selectAll().where('token_address', '=', active).execute()).map((row) => row.score)).toEqual([20, 30]);
    expect(await database.db.selectFrom('swing_studies').selectAll().where('token_address', '=', active).execute()).toHaveLength(1);
    expect((await database.db.selectFrom('jobs').select('id').execute()).map((row) => row.id)).toEqual(['queued-old']);
    expect((await database.db.selectFrom('app_events').select('event_type').execute()).map((row) => row.event_type)).toEqual(['recent']);
    expect((await database.db.selectFrom('alerts').select('id').execute()).map((row) => row.id)).toEqual(['alert-latest']);
  });
});
