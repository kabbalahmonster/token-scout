import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import type { Address, Candidate, CandidateState, ContractScan, MarketSnapshot, RiskFlag, RouteAssessment, ScoreResult, SourceStatus, SwingStudy, Verdict } from '@doomscout/domain';
import type { DatabaseSchema } from './schema.js';

const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDatabase { db: Kysely<DatabaseSchema>; sqlite: Database.Database; repositories: Repositories; close: () => Promise<void> }

export function migrate(sqlite: Database.Database): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrations = readdirSync(migrationsPath).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) {
    const version = file.replace(/\.sql$/, '');
    const applied = sqlite.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
    if (applied) continue;
    const migration = readFileSync(resolve(migrationsPath, file), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(migration);
      sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  }
}

export function openDatabase(path: string): OpenDatabase {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  const db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
  const repositories = new Repositories(db);
  return { db, sqlite, repositories, close: async () => { await db.destroy(); } };
}

function candidateFromRow(row: DatabaseSchema['candidates'] & { latest_json?: string | null }): Candidate {
  return {
    chainId: row.chain_id, address: row.address as Address, symbol: row.symbol, name: row.name, decimals: row.decimals, totalSupply: row.total_supply,
    state: row.state as CandidateState, canonicalPair: row.canonical_pair as Address | null, discoveredAt: row.discovered_at, updatedAt: row.updated_at,
    watched: row.watched === 1, score: row.score, verdict: row.verdict as Verdict, confidence: row.confidence, scoreVersion: row.score_version,
    flags: JSON.parse(row.flags_json) as RiskFlag[], latestSnapshot: row.latest_json ? snapshotFromRow(JSON.parse(row.latest_json)) : null,
    assessmentError: row.last_error_code && row.last_error_message && row.last_error_at ? { code: row.last_error_code, message: row.last_error_message, at: row.last_error_at } : null
  };
}

function snapshotFromRow(row: any): MarketSnapshot {
  return { id: Number(row.id), chainId: row.chain_id, tokenAddress: row.token_address as Address, pairAddress: row.pair_address as Address | null, dex: row.dex,
    priceNative: row.price_native, priceUsd: row.price_usd, liquidityUsd: row.liquidity_usd, fdvUsd: row.fdv_usd, marketCapUsd: row.market_cap_usd,
    volume5mUsd: row.volume_5m_usd, volume1hUsd: row.volume_1h_usd, volume6hUsd: row.volume_6h_usd, volume24hUsd: row.volume_24h_usd,
    buys24h: row.buys_24h, sells24h: row.sells_24h, pairCreatedAt: row.pair_created_at, sourceTime: row.source_time,
    ingestedAt: row.ingested_at, source: row.source, fingerprint: row.fingerprint };
}

export interface CandidateFilters { state?: CandidateState; watched?: boolean; verdict?: Verdict; minScore?: number; minLiquidityUsd?: number; minVolumeUsd?: number; routeState?: string; riskFlag?: string; search?: string; limit?: number; offset?: number; sort?: 'score' | 'swing' | 'liquidity' | 'volume_liquidity' | 'age' | 'route_recovery' | 'updated'; direction?: 'asc' | 'desc' }

export class Repositories {
  constructor(readonly db: Kysely<DatabaseSchema>) {}

  async healthy(): Promise<boolean> { const result = await sql<{ ok: number }>`select 1 as ok`.execute(this.db); return result.rows[0]?.ok === 1; }

  async upsertCandidate(input: { chainId: number; address: Address; symbol?: string | null; name?: string | null; state?: CandidateState }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('candidates').values({ chain_id: input.chainId, address: input.address, symbol: input.symbol ?? null, name: input.name ?? null, decimals: null, total_supply: null, state: input.state ?? 'discovered', canonical_pair: null, canonical_pair_override: null, discovered_at: now, updated_at: now, watched: 0, score: null, verdict: 'UNASSESSED', confidence: 0, score_version: null, flags_json: '[]' })
      .onConflict((conflict) => conflict.columns(['chain_id', 'address']).doUpdateSet({ symbol: (eb) => eb.fn.coalesce('excluded.symbol', 'candidates.symbol'), name: (eb) => eb.fn.coalesce('excluded.name', 'candidates.name'), updated_at: now })).execute();
  }

  async setCandidateMetadata(chainId: number, address: Address, values: { symbol: string | null; name: string | null; decimals: number | null; totalSupply: string | null }): Promise<void> {
    await this.db.updateTable('candidates').set({ symbol: values.symbol, name: values.name, decimals: values.decimals, total_supply: values.totalSupply, updated_at: new Date().toISOString() }).where('chain_id', '=', chainId).where('address', '=', address).execute();
  }

  async setCandidateState(chainId: number, address: Address, state: CandidateState, watched?: boolean): Promise<void> {
    await this.db.updateTable('candidates').set({ state, ...(watched === undefined ? {} : { watched: watched ? 1 : 0 }), updated_at: new Date().toISOString() }).where('chain_id', '=', chainId).where('address', '=', address).execute();
  }

  async recordAssessmentFailure(chainId: number, address: Address, code: string, message: string): Promise<void> {
    const at = new Date().toISOString();
    await this.db.updateTable('candidates').set({ state: 'stale', last_error_code: code.slice(0, 80), last_error_message: message.slice(0, 500), last_error_at: at, updated_at: at }).where('chain_id', '=', chainId).where('address', '=', address).execute();
    await this.emit('assessment.failed', { chainId, address, code: code.slice(0, 80), message: message.slice(0, 500), at });
  }

  async getCandidate(chainId: number, address: Address): Promise<Candidate | null> {
    const row = await this.db.selectFrom('candidates').selectAll().where('chain_id', '=', chainId).where('address', '=', address).executeTakeFirst();
    if (!row) return null;
    const latest = await this.latestSnapshot(chainId, address);
    return { ...candidateFromRow(row), latestSnapshot: latest };
  }

  async listCandidates(filters: CandidateFilters = {}): Promise<Candidate[]> {
    let query = this.db.selectFrom('candidates').selectAll();
    if (filters.state) query = query.where('state', '=', filters.state);
    if (filters.watched !== undefined) query = query.where('watched', '=', filters.watched ? 1 : 0);
    if (filters.verdict) query = query.where('verdict', '=', filters.verdict);
    if (filters.minScore !== undefined) query = query.where('score', '>=', filters.minScore);
    if (filters.search) query = query.where((eb) => eb.or([eb('address', 'like', `%${filters.search}%`), eb('symbol', 'like', `%${filters.search}%`), eb('name', 'like', `%${filters.search}%`)]));
    const rows = await query.orderBy('score', 'desc').limit(Math.min(filters.limit ?? 100, 500)).offset(filters.offset ?? 0).execute();
    let candidates = await Promise.all(rows.map(async (row) => {
      const address = row.address as Address;
      const [latestSnapshot, study, route] = await Promise.all([this.latestSnapshot(row.chain_id, address), this.latestSwingStudy(row.chain_id, address), this.latestRouteAssessment(row.chain_id, address)]);
      const preferred = study?.results.find((result) => result.threshold === 0.05 && result.horizon === '7d') ?? study?.results[0];
      return { ...candidateFromRow(row), latestSnapshot, swingScore: preferred?.suitability ?? null, routeState: route?.state ?? 'not_attempted' as const, routeRecoveryPct: route?.recoveryPct ?? null };
    }));
    if (filters.minLiquidityUsd !== undefined) candidates = candidates.filter((candidate) => Number(candidate.latestSnapshot?.liquidityUsd ?? -1) >= filters.minLiquidityUsd!);
    if (filters.minVolumeUsd !== undefined) candidates = candidates.filter((candidate) => Number(candidate.latestSnapshot?.volume24hUsd ?? -1) >= filters.minVolumeUsd!);
    if (filters.routeState) candidates = candidates.filter((candidate) => candidate.routeState === filters.routeState);
    if (filters.riskFlag) candidates = candidates.filter((candidate) => candidate.flags.some((flag) => flag.code === filters.riskFlag && flag.state === 'detected'));
    const value = (candidate: Candidate): number => {
      if (filters.sort === 'swing') return candidate.swingScore ?? -Infinity;
      if (filters.sort === 'liquidity') return Number(candidate.latestSnapshot?.liquidityUsd ?? -Infinity);
      if (filters.sort === 'volume_liquidity') return Number(candidate.latestSnapshot?.volume24hUsd ?? 0) / Math.max(Number(candidate.latestSnapshot?.liquidityUsd ?? 0), 1);
      if (filters.sort === 'age') return candidate.latestSnapshot?.pairCreatedAt ? Date.now() - Date.parse(candidate.latestSnapshot.pairCreatedAt) : -Infinity;
      if (filters.sort === 'route_recovery') return candidate.routeRecoveryPct ?? -Infinity;
      if (filters.sort === 'updated') return Date.parse(candidate.updatedAt);
      return candidate.score ?? -Infinity;
    };
    const direction = filters.direction === 'asc' ? 1 : -1;
    return candidates.sort((a, b) => (value(a) - value(b)) * direction);
  }

  async upsertPair(input: { chainId: number; tokenAddress: Address; pairAddress: Address; dex: string; url: string | null; quoteTokenAddress: Address | null; createdAt: string | null; liquidityUsd: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('pairs').values({ chain_id: input.chainId, token_address: input.tokenAddress, pair_address: input.pairAddress, dex: input.dex, url: input.url, quote_token_address: input.quoteTokenAddress, created_at: input.createdAt, liquidity_usd: input.liquidityUsd, last_seen_at: now })
      .onConflict((conflict) => conflict.columns(['chain_id', 'pair_address']).doUpdateSet({ liquidity_usd: input.liquidityUsd, last_seen_at: now, url: input.url })).execute();
    // Canonical pair defaults to greatest known USD liquidity. Unknown is never coerced to zero.
    const best = await this.db.selectFrom('pairs').select(['pair_address']).where('chain_id', '=', input.chainId).where('token_address', '=', input.tokenAddress).where('liquidity_usd', 'is not', null).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').executeTakeFirst();
    if (best) await this.db.updateTable('candidates').set({ canonical_pair: best.pair_address, updated_at: now }).where('chain_id', '=', input.chainId).where('address', '=', input.tokenAddress).where('canonical_pair_override', 'is', null).execute();
  }
  async listPairs(chainId: number, address: Address): Promise<Array<{ pairAddress: Address; dex: string; url: string | null; liquidityUsd: string | null; createdAt: string | null }>> { const rows = await this.db.selectFrom('pairs').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').execute(); return rows.map((row) => ({ pairAddress: row.pair_address as Address, dex: row.dex, url: row.url, liquidityUsd: row.liquidity_usd, createdAt: row.created_at })); }
  async setCanonicalPairOverride(chainId: number, address: Address, pairAddress: Address | null): Promise<void> {
    let canonicalPair = pairAddress;
    if (pairAddress !== null) {
      const pair = await this.db.selectFrom('pairs').select('pair_address').where('chain_id', '=', chainId).where('token_address', '=', address).where('pair_address', '=', pairAddress).executeTakeFirst();
      if (!pair) throw new Error('Canonical pair override must belong to this candidate');
    } else {
      const best = await this.db.selectFrom('pairs').select('pair_address').where('chain_id', '=', chainId).where('token_address', '=', address).where('liquidity_usd', 'is not', null).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').executeTakeFirst();
      canonicalPair = best?.pair_address as Address | undefined ?? null;
    }
    await this.db.updateTable('candidates').set({ canonical_pair_override: pairAddress, canonical_pair: canonicalPair, updated_at: new Date().toISOString() }).where('chain_id', '=', chainId).where('address', '=', address).execute();
  }

  async insertSnapshot(snapshot: Omit<MarketSnapshot, 'id'>, rawEvidence?: unknown): Promise<number | null> {
    const result = await this.db.insertInto('market_snapshots').values({ chain_id: snapshot.chainId, token_address: snapshot.tokenAddress, pair_address: snapshot.pairAddress, dex: snapshot.dex, price_native: snapshot.priceNative, price_usd: snapshot.priceUsd, liquidity_usd: snapshot.liquidityUsd, fdv_usd: snapshot.fdvUsd, market_cap_usd: snapshot.marketCapUsd, volume_5m_usd: snapshot.volume5mUsd, volume_1h_usd: snapshot.volume1hUsd, volume_6h_usd: snapshot.volume6hUsd, volume_24h_usd: snapshot.volume24hUsd, buys_24h: snapshot.buys24h, sells_24h: snapshot.sells24h, pair_created_at: snapshot.pairCreatedAt, source_time: snapshot.sourceTime, ingested_at: snapshot.ingestedAt, source: snapshot.source, fingerprint: snapshot.fingerprint, raw_evidence_json: rawEvidence === undefined ? null : JSON.stringify(rawEvidence).slice(0, 64_000) }).onConflict((conflict) => conflict.columns(['chain_id', 'token_address', 'fingerprint']).doNothing()).returning('id').executeTakeFirst();
    if (result?.id !== undefined) await Promise.all([this.updateAggregate(snapshot, 300), this.updateAggregate(snapshot, 3600)]);
    return result?.id ?? null;
  }

  private async updateAggregate(snapshot: Omit<MarketSnapshot, 'id'>, resolutionSeconds: number): Promise<void> {
    const epoch = Math.floor(Date.parse(snapshot.ingestedAt) / 1000 / resolutionSeconds) * resolutionSeconds;
    const bucketAt = new Date(epoch * 1000).toISOString();
    const price = snapshot.priceUsd ?? snapshot.priceNative;
    const existing = await this.db.selectFrom('market_aggregates').selectAll().where('chain_id', '=', snapshot.chainId).where('token_address', '=', snapshot.tokenAddress).where('resolution_seconds', '=', resolutionSeconds).where('bucket_at', '=', bucketAt).executeTakeFirst();
    const high = price && existing?.high_price ? Decimal.max(price, existing.high_price).toString() : price ?? existing?.high_price ?? null;
    const low = price && existing?.low_price ? Decimal.min(price, existing.low_price).toString() : price ?? existing?.low_price ?? null;
    const serialized = JSON.stringify(snapshot);
    await this.db.insertInto('market_aggregates').values({ chain_id: snapshot.chainId, token_address: snapshot.tokenAddress, resolution_seconds: resolutionSeconds, bucket_at: bucketAt, open_price: existing?.open_price ?? price, high_price: high, low_price: low, close_price: price, sample_count: (existing?.sample_count ?? 0) + 1, latest_snapshot_json: serialized }).onConflict((conflict) => conflict.columns(['chain_id', 'token_address', 'resolution_seconds', 'bucket_at']).doUpdateSet({ high_price: high, low_price: low, close_price: price, sample_count: (existing?.sample_count ?? 0) + 1, latest_snapshot_json: serialized })).execute();
  }

  async latestSnapshot(chainId: number, address: Address): Promise<MarketSnapshot | null> {
    const row = await this.db.selectFrom('market_snapshots').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('ingested_at', 'desc').executeTakeFirst();
    return row ? snapshotFromRow(row) : null;
  }

  async history(chainId: number, address: Address, since?: string, limit = 20_000): Promise<MarketSnapshot[]> {
    let query = this.db.selectFrom('market_snapshots').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address);
    if (since) query = query.where('ingested_at', '>=', since);
    const rows = await query.orderBy('ingested_at', 'asc').limit(Math.min(limit, 100_000)).execute();
    return rows.map(snapshotFromRow);
  }

  async analyticsHistory(chainId: number, address: Address, rawDays: number, fiveMinuteDays: number, hourlyDays: number, limit = 100_000): Promise<MarketSnapshot[]> {
    const now = Date.now();
    const rawCutoff = new Date(now - rawDays * 86_400_000).toISOString();
    const fiveMinuteCutoff = new Date(now - fiveMinuteDays * 86_400_000).toISOString();
    const hourlyCutoff = new Date(now - hourlyDays * 86_400_000).toISOString();
    const [raw, fiveMinute, hourly] = await Promise.all([
      this.history(chainId, address, rawCutoff, limit),
      this.db.selectFrom('market_aggregates').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address).where('resolution_seconds', '=', 300).where('bucket_at', '>=', fiveMinuteCutoff).where('bucket_at', '<', rawCutoff).orderBy('bucket_at').limit(limit).execute(),
      this.db.selectFrom('market_aggregates').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address).where('resolution_seconds', '=', 3600).where('bucket_at', '>=', hourlyCutoff).where('bucket_at', '<', fiveMinuteCutoff).orderBy('bucket_at').limit(limit).execute()
    ]);
    const aggregates = [...hourly, ...fiveMinute].map((row, index) => {
      const latest = JSON.parse(row.latest_snapshot_json) as Omit<MarketSnapshot, 'id'>;
      return { ...latest, id: -(index + 1), priceUsd: latest.priceUsd === null ? null : row.close_price, priceNative: latest.priceUsd === null ? row.close_price : latest.priceNative, ingestedAt: row.bucket_at, sourceTime: row.bucket_at, source: `doomscout_${row.resolution_seconds === 300 ? '5m' : '1h'}_aggregate`, fingerprint: `aggregate:${row.resolution_seconds}:${row.bucket_at}` };
    });
    return [...aggregates, ...raw].sort((a, b) => Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt));
  }

  async saveSwingStudy(chainId: number, address: Address, study: SwingStudy): Promise<void> {
    await this.db.insertInto('swing_studies').values({ chain_id: chainId, token_address: address, algorithm_version: study.algorithmVersion, generated_at: study.generatedAt, parameters_json: JSON.stringify(study.parameters), result_json: JSON.stringify(study) }).onConflict((conflict) => conflict.columns(['chain_id', 'token_address', 'algorithm_version', 'generated_at']).doNothing()).execute();
  }
  async latestSwingStudy(chainId: number, address: Address): Promise<SwingStudy | null> { const row = await this.db.selectFrom('swing_studies').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('generated_at', 'desc').executeTakeFirst(); return row ? JSON.parse(row.result_json) as SwingStudy : null; }

  async saveContractScan(scan: ContractScan): Promise<void> { await this.db.insertInto('contract_scans').values({ chain_id: scan.chainId, token_address: scan.address, scan_version: scan.version, code_hash: scan.codeHash, scanned_at: scan.scannedAt, result_json: JSON.stringify(scan) }).execute(); await this.db.updateTable('candidates').set({ flags_json: JSON.stringify(scan.flags), updated_at: scan.scannedAt }).where('chain_id', '=', scan.chainId).where('address', '=', scan.address).execute(); }
  async latestContractScan(chainId: number, address: Address): Promise<ContractScan | null> { const row = await this.db.selectFrom('contract_scans').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('scanned_at', 'desc').executeTakeFirst(); return row ? JSON.parse(row.result_json) as ContractScan : null; }
  async saveRouteAssessment(chainId: number, address: Address, assessment: RouteAssessment): Promise<void> { await this.db.insertInto('route_assessments').values({ chain_id: chainId, token_address: address, assessed_at: new Date().toISOString(), provider: assessment.buy?.provider ?? null, state: assessment.state, result_json: JSON.stringify(assessment) }).execute(); }
  async latestRouteAssessment(chainId: number, address: Address): Promise<RouteAssessment | null> { const row = await this.db.selectFrom('route_assessments').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('assessed_at', 'desc').executeTakeFirst(); return row ? JSON.parse(row.result_json) as RouteAssessment : null; }
  async saveScore(chainId: number, address: Address, score: ScoreResult): Promise<void> { await this.db.transaction().execute(async (trx) => { const candidate = await trx.selectFrom('candidates').select('watched').where('chain_id', '=', chainId).where('address', '=', address).executeTakeFirst(); await trx.insertInto('score_history').values({ chain_id: chainId, token_address: address, score_version: score.version, calculated_at: score.calculatedAt, score: score.score, confidence: score.confidence, verdict: score.verdict, result_json: JSON.stringify(score) }).execute(); await trx.updateTable('candidates').set({ score: score.score, confidence: score.confidence, verdict: score.verdict, score_version: score.version, state: candidate?.watched === 1 ? 'watched' : 'assessed', last_error_code: null, last_error_message: null, last_error_at: null, updated_at: score.calculatedAt }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }); await this.emit('score.updated', { chainId, address, score }); }
  async latestScore(chainId: number, address: Address): Promise<ScoreResult | null> { const row = await this.db.selectFrom('score_history').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('calculated_at', 'desc').executeTakeFirst(); return row ? JSON.parse(row.result_json) as ScoreResult : null; }

  async createWatchlist(input: { name: string; labels?: string[]; assessmentBudgetWei?: string; intendedPositionCount?: number }): Promise<{ id: string }> { const id = randomUUID(); const now = new Date().toISOString(); await this.db.insertInto('watchlists').values({ id, name: input.name, labels_json: JSON.stringify(input.labels ?? []), assessment_budget_wei: input.assessmentBudgetWei ?? null, intended_position_count: input.intendedPositionCount ?? null, created_at: now, updated_at: now }).execute(); return { id }; }
  async listWatchlists(): Promise<Array<{ id: string; name: string; labels: string[]; assessmentBudgetWei: string | null; intendedPositionCount: number | null }>> { const rows = await this.db.selectFrom('watchlists').selectAll().orderBy('name').execute(); return rows.map((row) => ({ id: row.id, name: row.name, labels: JSON.parse(row.labels_json) as string[], assessmentBudgetWei: row.assessment_budget_wei, intendedPositionCount: row.intended_position_count })); }
  async addWatchlistItem(id: string, chainId: number, address: Address, tags: string[] = []): Promise<void> { const now = new Date().toISOString(); await this.db.transaction().execute(async (trx) => { await trx.insertInto('watchlist_items').values({ watchlist_id: id, chain_id: chainId, token_address: address, tags_json: JSON.stringify(tags), note: null, created_at: now }).onConflict((conflict) => conflict.columns(['watchlist_id', 'chain_id', 'token_address']).doUpdateSet({ tags_json: JSON.stringify(tags) })).execute(); await trx.updateTable('candidates').set({ watched: 1, state: 'watched', updated_at: now }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }); }
  async removeWatchlistItem(id: string, chainId: number, address: Address): Promise<void> { await this.db.deleteFrom('watchlist_items').where('watchlist_id', '=', id).where('chain_id', '=', chainId).where('token_address', '=', address).execute(); const other = await this.db.selectFrom('watchlist_items').select(({ fn }) => fn.countAll<number>().as('count')).where('chain_id', '=', chainId).where('token_address', '=', address).executeTakeFirst(); if (Number(other?.count ?? 0) === 0) await this.db.updateTable('candidates').set({ watched: 0, state: 'assessed', updated_at: new Date().toISOString() }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }

  async setSourceStatus(status: SourceStatus): Promise<void> { await this.db.insertInto('source_status').values({ source: status.source, state: status.state, checked_at: status.checkedAt, last_success_at: status.lastSuccessAt, latency_ms: status.latencyMs, failures: status.failures, circuit_open_until: status.circuitOpenUntil, message: status.message }).onConflict((conflict) => conflict.column('source').doUpdateSet({ state: status.state, checked_at: status.checkedAt, last_success_at: status.lastSuccessAt, latency_ms: status.latencyMs, failures: status.failures, circuit_open_until: status.circuitOpenUntil, message: status.message })).execute(); }
  async sourceStatuses(): Promise<SourceStatus[]> { const rows = await this.db.selectFrom('source_status').selectAll().orderBy('source').execute(); return rows.map((row) => ({ source: row.source, state: row.state as SourceStatus['state'], checkedAt: row.checked_at, lastSuccessAt: row.last_success_at, latencyMs: row.latency_ms, failures: row.failures, circuitOpenUntil: row.circuit_open_until, message: row.message })); }

  async recordDiscovery(input: { chainId: number; tokenAddress: Address | null; source: string; sourceId: string | null; sourceTime: string | null; outcome: string; errorCode?: string }): Promise<void> { const ingestedAt = new Date().toISOString(); const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, bucket: ingestedAt.slice(0, 16) })).digest('hex'); await this.db.insertInto('discovery_records').values({ chain_id: input.chainId, token_address: input.tokenAddress, source: input.source, source_id: input.sourceId, source_time: input.sourceTime, ingested_at: ingestedAt, outcome: input.outcome, error_code: input.errorCode ?? null, fingerprint }).onConflict((conflict) => conflict.column('fingerprint').doNothing()).execute(); }

  async enqueue(kind: string, dedupeKey: string, payload: unknown, runAfter = new Date().toISOString()): Promise<string | null> { const id = randomUUID(); const now = new Date().toISOString(); const result = await this.db.insertInto('jobs').values({ id, kind, dedupe_key: dedupeKey, payload_json: JSON.stringify(payload), state: 'queued', run_after: runAfter, attempts: 0, locked_at: null, locked_by: null, last_error: null, created_at: now, updated_at: now }).onConflict((conflict) => conflict.doNothing()).returning('id').executeTakeFirst(); return result?.id ?? null; }
  async claimJob(workerId: string): Promise<{ id: string; kind: string; payload: any; attempts: number } | null> { return this.db.transaction().execute(async (trx) => { const row = await trx.selectFrom('jobs').selectAll().where('state', '=', 'queued').where('run_after', '<=', new Date().toISOString()).orderBy('run_after').executeTakeFirst(); if (!row) return null; const updated = await trx.updateTable('jobs').set({ state: 'running', locked_at: new Date().toISOString(), locked_by: workerId, attempts: row.attempts + 1, updated_at: new Date().toISOString() }).where('id', '=', row.id).where('state', '=', 'queued').returningAll().executeTakeFirst(); return updated ? { id: updated.id, kind: updated.kind, payload: JSON.parse(updated.payload_json), attempts: updated.attempts } : null; }); }
  async finishJob(id: string): Promise<void> { await this.db.updateTable('jobs').set({ state: 'completed', locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).where('id', '=', id).execute(); }
  async failJob(id: string, error: string, retryAt?: string): Promise<void> { await this.db.updateTable('jobs').set({ state: retryAt ? 'queued' : 'failed', run_after: retryAt ?? new Date().toISOString(), last_error: error.slice(0, 500), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).where('id', '=', id).execute(); }
  async jobStats(): Promise<Record<string, number>> { const rows = await this.db.selectFrom('jobs').select(['state', ({ fn }) => fn.countAll<number>().as('count')]).groupBy('state').execute(); return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)])); }

  async emit(eventType: string, payload: unknown): Promise<void> { await this.db.insertInto('app_events').values({ event_type: eventType, payload_json: JSON.stringify(payload), created_at: new Date().toISOString() }).execute(); }
  async eventsAfter(id: number): Promise<Array<{ id: number; eventType: string; payload: unknown; createdAt: string }>> { const rows = await this.db.selectFrom('app_events').selectAll().where('id', '>', id).orderBy('id').limit(100).execute(); return rows.map((row) => ({ id: row.id, eventType: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at })); }

  async createAlert(input: { chainId: number; address: Address; kind: string; severity: 'info' | 'warning' | 'critical'; message: string; evidence: unknown }): Promise<void> { const id = randomUUID(); const createdAt = new Date().toISOString(); await this.db.insertInto('alerts').values({ id, chain_id: input.chainId, token_address: input.address, kind: input.kind, severity: input.severity, message: input.message.slice(0, 500), evidence_json: JSON.stringify(input.evidence), created_at: createdAt, read_at: null }).execute(); await this.emit('alert.created', { id, chainId: input.chainId, address: input.address, kind: input.kind, severity: input.severity, message: input.message, createdAt }); }
  async listAlerts(limit = 100): Promise<Array<{ id: string; chainId: number; address: Address; kind: string; severity: string; message: string; evidence: unknown; createdAt: string; readAt: string | null }>> { const rows = await this.db.selectFrom('alerts').selectAll().orderBy('created_at', 'desc').limit(Math.min(limit, 500)).execute(); return rows.map((row) => ({ id: row.id, chainId: row.chain_id, address: row.token_address as Address, kind: row.kind, severity: row.severity, message: row.message, evidence: JSON.parse(row.evidence_json), createdAt: row.created_at, readAt: row.read_at })); }
  async markAlertRead(id: string): Promise<void> { await this.db.updateTable('alerts').set({ read_at: new Date().toISOString() }).where('id', '=', id).execute(); }

  async retention(rawDays: number, fiveMinuteDays = 90, hourlyDays = 730): Promise<number> {
    const rawCutoff = new Date(Date.now() - rawDays * 86_400_000).toISOString();
    const fiveMinuteCutoff = new Date(Date.now() - fiveMinuteDays * 86_400_000).toISOString();
    const hourlyCutoff = new Date(Date.now() - hourlyDays * 86_400_000).toISOString();
    const [raw, fiveMinute, hourly] = await this.db.transaction().execute(async (trx) => Promise.all([
      trx.deleteFrom('market_snapshots').where('ingested_at', '<', rawCutoff).executeTakeFirst(),
      trx.deleteFrom('market_aggregates').where('resolution_seconds', '=', 300).where('bucket_at', '<', fiveMinuteCutoff).executeTakeFirst(),
      trx.deleteFrom('market_aggregates').where('resolution_seconds', '=', 3600).where('bucket_at', '<', hourlyCutoff).executeTakeFirst()
    ]));
    return Number(raw.numDeletedRows + fiveMinute.numDeletedRows + hourly.numDeletedRows);
  }
}

export { type DatabaseSchema } from './schema.js';
