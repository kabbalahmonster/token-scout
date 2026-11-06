import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import { classifyAssetType, type Address, type AssetType, type Candidate, type CandidateState, type ContractScan, type MarketSnapshot, type RiskFlag, type RouteAssessment, type ScoreResult, type SourceStatus, type SwingStudy, type Verdict } from '@doomscout/domain';
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
    chainId: row.chain_id, address: row.address as Address, symbol: row.symbol, name: row.name, decimals: row.decimals, totalSupply: row.total_supply, assetType: classifyAssetType(row.symbol, row.name),
    state: row.state as CandidateState, canonicalPair: row.canonical_pair as Address | null, discoveredAt: row.discovered_at, updatedAt: row.updated_at,
    watched: row.watched === 1, score: row.score, verdict: row.verdict as Verdict, confidence: row.confidence, scoreVersion: row.score_version,
    flags: visibleRiskFlags(JSON.parse(row.flags_json) as RiskFlag[]), latestSnapshot: row.latest_json ? JSON.parse(row.latest_json) as MarketSnapshot : row.latest_snapshot_json ? JSON.parse(row.latest_snapshot_json) as MarketSnapshot : null,
    swingScore: row.swing_score, swingEventsPerDay: row.swing_events_per_day,
    routeState: row.route_state as RouteAssessment['state'], routeRecoveryPct: row.route_recovery_pct,
    assessmentError: row.last_error_code && row.last_error_message && row.last_error_at ? { code: row.last_error_code, message: row.last_error_message, at: row.last_error_at } : null
  };
}

function visibleRiskFlags(flags: RiskFlag[]): RiskFlag[] {
  return flags.filter((flag) => flag.code !== 'source_verification');
}

function riskFlagSummaries(flags: RiskFlag[]): RiskFlag[] {
  return visibleRiskFlags(flags).filter((flag) => flag.state === 'detected').map((flag) => ({ ...flag, explanation: '', evidence: [] }));
}

function snapshotFromRow(row: any): MarketSnapshot {
  return { id: Number(row.id), chainId: row.chain_id, tokenAddress: row.token_address as Address, pairAddress: row.pair_address as Address | null, dex: row.dex,
    priceNative: row.price_native, priceUsd: row.price_usd, liquidityUsd: row.liquidity_usd, fdvUsd: row.fdv_usd, marketCapUsd: row.market_cap_usd,
    volume5mUsd: row.volume_5m_usd, volume1hUsd: row.volume_1h_usd, volume6hUsd: row.volume_6h_usd, volume24hUsd: row.volume_24h_usd,
    buys24h: row.buys_24h, sells24h: row.sells_24h, pairCreatedAt: row.pair_created_at, sourceTime: row.source_time,
    ingestedAt: row.ingested_at, source: row.source, fingerprint: row.fingerprint };
}

export type CandidateSort = 'token' | 'asset_type' | 'score' | 'verdict' | 'state' | 'swing' | 'events_per_day' | 'liquidity' | 'market_cap' | 'volume' | 'volume_liquidity' | 'age' | 'route' | 'route_recovery' | 'flags' | 'updated';
export interface CandidateFilters { state?: CandidateState; watched?: boolean; verdict?: Verdict; assetType?: AssetType; minScore?: number; minLiquidityUsd?: number; minVolumeUsd?: number; minPairAgeDays?: number; maxPairAgeDays?: number; routeState?: string; riskFlag?: string; search?: string; limit?: number; offset?: number; sort?: CandidateSort; direction?: 'asc' | 'desc' }
export interface RefreshCandidate { chainId: number; address: Address; verdict: Verdict; score: number; lastAssessedAt: string }
export interface HousekeepingPolicy {
  rawDays: number; fiveMinuteDays: number; hourlyDays: number;
  candidateArchiveDays: number; archivedCandidateDays: number;
  discoveryDays: number; completedJobDays: number; failedJobDays: number;
  alertDays: number; appEventDays: number;
  assessmentDetailDays: number; assessmentDailyDays: number;
}
export interface HousekeepingReport {
  marketHistoryDeleted: number;
  candidatesArchived: number;
  candidatesDeleted: number;
  discoveryDeleted: number;
  jobsDeleted: number;
  alertsDeleted: number;
  appEventsDeleted: number;
  assessmentHistoryDeleted: number;
}

export class Repositories {
  constructor(readonly db: Kysely<DatabaseSchema>) {}

  async healthy(): Promise<boolean> { const result = await sql<{ ok: number }>`select 1 as ok`.execute(this.db); return result.rows[0]?.ok === 1; }

  async upsertCandidate(input: { chainId: number; address: Address; symbol?: string | null; name?: string | null; state?: CandidateState }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('candidates').values({ chain_id: input.chainId, address: input.address, symbol: input.symbol ?? null, name: input.name ?? null, decimals: null, total_supply: null, state: input.state ?? 'discovered', canonical_pair: null, canonical_pair_override: null, discovered_at: now, updated_at: now, watched: 0, score: null, verdict: 'UNASSESSED', confidence: 0, score_version: null, flags_json: '[]', detected_flags_json: '[]', latest_snapshot_json: null, latest_snapshot_at: null, swing_score: null, swing_events_per_day: null, route_state: 'not_attempted', route_recovery_pct: null })
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
    let query = this.db.selectFrom('candidates').select([
      'chain_id', 'address', 'symbol', 'name', 'decimals', 'total_supply', 'state', 'canonical_pair', 'canonical_pair_override',
      'discovered_at', 'updated_at', 'watched', 'score', 'verdict', 'confidence', 'score_version',
      'detected_flags_json as flags_json', 'detected_flags_json', 'latest_snapshot_json', 'latest_snapshot_at',
      'swing_score', 'swing_events_per_day', 'route_state', 'route_recovery_pct',
      'last_error_code', 'last_error_message', 'last_error_at'
    ]);
    if (filters.state) query = query.where('state', '=', filters.state);
    if (filters.watched !== undefined) query = query.where('watched', '=', filters.watched ? 1 : 0);
    if (filters.verdict) query = query.where('verdict', '=', filters.verdict);
    if (filters.minScore !== undefined) query = query.where('score', '>=', filters.minScore);
    if (filters.search) query = query.where((eb) => eb.or([eb('address', 'like', `%${filters.search}%`), eb('symbol', 'like', `%${filters.search}%`), eb('name', 'like', `%${filters.search}%`)]));
    // Summary-backed sorts are computed below, so pagination must happen after
    // filtering and sorting without touching the large evidence tables.
    const rows = await query.orderBy('score', 'desc').execute();
    let candidates = rows.map(candidateFromRow);
    if (filters.assetType) candidates = candidates.filter((candidate) => candidate.assetType === filters.assetType);
    if (filters.minLiquidityUsd !== undefined) candidates = candidates.filter((candidate) => Number(candidate.latestSnapshot?.liquidityUsd ?? -1) >= filters.minLiquidityUsd!);
    if (filters.minVolumeUsd !== undefined) candidates = candidates.filter((candidate) => Number(candidate.latestSnapshot?.volume24hUsd ?? -1) >= filters.minVolumeUsd!);
    if (filters.minPairAgeDays !== undefined) candidates = candidates.filter((candidate) => {
      const createdAt = candidate.latestSnapshot?.pairCreatedAt;
      return createdAt ? Date.now() - Date.parse(createdAt) >= filters.minPairAgeDays! * 86_400_000 : false;
    });
    if (filters.maxPairAgeDays !== undefined) candidates = candidates.filter((candidate) => {
      const createdAt = candidate.latestSnapshot?.pairCreatedAt;
      return createdAt ? Date.now() - Date.parse(createdAt) < filters.maxPairAgeDays! * 86_400_000 : false;
    });
    if (filters.routeState) candidates = candidates.filter((candidate) => candidate.routeState === filters.routeState);
    if (filters.riskFlag) candidates = candidates.filter((candidate) => candidate.flags.some((flag) => flag.code === filters.riskFlag && flag.state === 'detected'));
    const value = (candidate: Candidate): number | string | null => {
      if (filters.sort === 'token') return (candidate.symbol ?? candidate.name ?? candidate.address).toLocaleLowerCase();
      if (filters.sort === 'asset_type') return candidate.assetType;
      if (filters.sort === 'verdict') return candidate.verdict;
      if (filters.sort === 'state') return candidate.state;
      if (filters.sort === 'swing') return candidate.swingScore ?? null;
      if (filters.sort === 'events_per_day') return candidate.swingEventsPerDay ?? null;
      if (filters.sort === 'liquidity') return candidate.latestSnapshot?.liquidityUsd === null || candidate.latestSnapshot?.liquidityUsd === undefined ? null : Number(candidate.latestSnapshot.liquidityUsd);
      if (filters.sort === 'market_cap') return candidate.latestSnapshot?.marketCapUsd === null || candidate.latestSnapshot?.marketCapUsd === undefined ? null : Number(candidate.latestSnapshot.marketCapUsd);
      if (filters.sort === 'volume') return candidate.latestSnapshot?.volume24hUsd === null || candidate.latestSnapshot?.volume24hUsd === undefined ? null : Number(candidate.latestSnapshot.volume24hUsd);
      if (filters.sort === 'volume_liquidity') return candidate.latestSnapshot?.volume24hUsd === null || candidate.latestSnapshot?.volume24hUsd === undefined || candidate.latestSnapshot.liquidityUsd === null || candidate.latestSnapshot.liquidityUsd === undefined ? null : Number(candidate.latestSnapshot.volume24hUsd) / Math.max(Number(candidate.latestSnapshot.liquidityUsd), 1);
      if (filters.sort === 'age') return candidate.latestSnapshot?.pairCreatedAt ? Date.now() - Date.parse(candidate.latestSnapshot.pairCreatedAt) : null;
      if (filters.sort === 'route') return candidate.routeState ?? 'not_attempted';
      if (filters.sort === 'route_recovery') return candidate.routeRecoveryPct ?? null;
      if (filters.sort === 'flags') return candidate.flags.filter((flag) => flag.state === 'detected').length;
      if (filters.sort === 'updated') return Date.parse(candidate.updatedAt);
      return candidate.score ?? null;
    };
    const direction = filters.direction === 'asc' ? 1 : -1;
    const sorted = candidates.sort((a, b) => {
      const left = value(a); const right = value(b);
      if (left === right) return a.address.localeCompare(b.address);
      if (left === null) return 1;
      if (right === null) return -1;
      return (typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right) : Number(left) - Number(right)) * direction;
    });
    const offset = filters.offset ?? 0;
    return sorted.slice(offset, offset + Math.min(filters.limit ?? 100, 2000));
  }

  async listRefreshCandidates(input: { assessedBefore: string; minScore: number; limit: number }): Promise<RefreshCandidate[]> {
    const rows = await this.db.selectFrom('candidates as candidate')
      .innerJoin('score_history as score', (join) => join
        .onRef('score.chain_id', '=', 'candidate.chain_id')
        .onRef('score.token_address', '=', 'candidate.address')
        .on('score.calculated_at', '=', (eb) => eb.selectFrom('score_history as latest')
          .select(({ fn }) => fn.max('latest.calculated_at').as('calculated_at'))
          .whereRef('latest.chain_id', '=', 'candidate.chain_id')
          .whereRef('latest.token_address', '=', 'candidate.address')))
      .select(['candidate.chain_id', 'candidate.address', 'candidate.verdict', 'candidate.score', 'score.calculated_at'])
      .where('candidate.watched', '=', 0)
      .where('candidate.state', '!=', 'archived')
      .where('candidate.verdict', 'in', ['PASS', 'CAUTION'])
      .where((eb) => eb.or([
        eb('candidate.score', '>=', input.minScore),
        eb.exists(eb.selectFrom('score_history as prior_pass').select('prior_pass.id')
          .whereRef('prior_pass.chain_id', '=', 'candidate.chain_id')
          .whereRef('prior_pass.token_address', '=', 'candidate.address')
          .where('prior_pass.verdict', '=', 'PASS'))
      ]))
      .where('score.calculated_at', '<=', input.assessedBefore)
      .orderBy('score.calculated_at', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      chainId: row.chain_id,
      address: row.address as Address,
      verdict: row.verdict as Verdict,
      score: Number(row.score),
      lastAssessedAt: row.calculated_at
    }));
  }

  async listUniverseRefreshCandidates(input: { assessedBefore: string; priorityMinScore: number; limit: number }): Promise<RefreshCandidate[]> {
    const rows = await this.db.selectFrom('candidates as candidate')
      .innerJoin('score_history as score', (join) => join
        .onRef('score.chain_id', '=', 'candidate.chain_id')
        .onRef('score.token_address', '=', 'candidate.address')
        .on('score.calculated_at', '=', (eb) => eb.selectFrom('score_history as latest')
          .select(({ fn }) => fn.max('latest.calculated_at').as('calculated_at'))
          .whereRef('latest.chain_id', '=', 'candidate.chain_id')
          .whereRef('latest.token_address', '=', 'candidate.address')))
      .select(['candidate.chain_id', 'candidate.address', 'candidate.verdict', 'candidate.score', 'score.calculated_at'])
      .where('candidate.watched', '=', 0)
      .where('candidate.state', '!=', 'archived')
      .where('score.calculated_at', '<=', input.assessedBefore)
      .where((eb) => eb.not(eb.or([
        eb.and([eb('candidate.verdict', 'in', ['PASS', 'CAUTION']), eb('candidate.score', '>=', input.priorityMinScore)]),
        eb.exists(eb.selectFrom('score_history as prior_pass').select('prior_pass.id')
          .whereRef('prior_pass.chain_id', '=', 'candidate.chain_id')
          .whereRef('prior_pass.token_address', '=', 'candidate.address')
          .where('prior_pass.verdict', '=', 'PASS'))
      ])))
      .orderBy('score.calculated_at', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      chainId: row.chain_id,
      address: row.address as Address,
      verdict: row.verdict as Verdict,
      score: Number(row.score),
      lastAssessedAt: row.calculated_at
    }));
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
    if (result?.id !== undefined) await Promise.all([
      this.updateAggregate(snapshot, 300),
      this.updateAggregate(snapshot, 3600),
      this.db.updateTable('candidates').set({ latest_snapshot_json: JSON.stringify({ ...snapshot, id: Number(result.id) }), latest_snapshot_at: snapshot.ingestedAt })
        .where('chain_id', '=', snapshot.chainId).where('address', '=', snapshot.tokenAddress)
        .where((eb) => eb.or([eb('latest_snapshot_at', 'is', null), eb('latest_snapshot_at', '<=', snapshot.ingestedAt)])).execute()
    ]);
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

  async hasSnapshotSource(chainId: number, address: Address, source: string): Promise<boolean> {
    const row = await this.db.selectFrom('market_snapshots').select('id').where('chain_id', '=', chainId).where('token_address', '=', address).where('source', '=', source).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async latestSnapshotAtForSource(chainId: number, address: Address, source: string): Promise<string | null> {
    const row = await this.db.selectFrom('market_snapshots').select('ingested_at')
      .where('chain_id', '=', chainId).where('token_address', '=', address).where('source', '=', source)
      .orderBy('ingested_at', 'desc').limit(1).executeTakeFirst();
    return row?.ingested_at ?? null;
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
    const preferred = study.results.find((result) => result.threshold === 0.05 && result.horizon === '7d') ?? study.results[0];
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('swing_studies').values({ chain_id: chainId, token_address: address, algorithm_version: study.algorithmVersion, generated_at: study.generatedAt, parameters_json: JSON.stringify(study.parameters), result_json: JSON.stringify(study) }).onConflict((conflict) => conflict.columns(['chain_id', 'token_address', 'algorithm_version', 'generated_at']).doNothing()).execute();
      await trx.updateTable('candidates').set({ swing_score: preferred?.suitability ?? null, swing_events_per_day: preferred?.eventsPerDay ?? null }).where('chain_id', '=', chainId).where('address', '=', address).execute();
    });
  }
  async latestSwingStudy(chainId: number, address: Address): Promise<SwingStudy | null> { const row = await this.db.selectFrom('swing_studies').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('generated_at', 'desc').executeTakeFirst(); return row ? JSON.parse(row.result_json) as SwingStudy : null; }

  async saveContractScan(scan: ContractScan): Promise<void> { await this.db.insertInto('contract_scans').values({ chain_id: scan.chainId, token_address: scan.address, scan_version: scan.version, code_hash: scan.codeHash, scanned_at: scan.scannedAt, result_json: JSON.stringify(scan) }).execute(); await this.db.updateTable('candidates').set({ flags_json: JSON.stringify(scan.flags), detected_flags_json: JSON.stringify(riskFlagSummaries(scan.flags)), updated_at: scan.scannedAt }).where('chain_id', '=', scan.chainId).where('address', '=', scan.address).execute(); }
  async latestContractScan(chainId: number, address: Address): Promise<ContractScan | null> { const row = await this.db.selectFrom('contract_scans').select('result_json').where('chain_id', '=', chainId).where('token_address', '=', address).orderBy('scanned_at', 'desc').executeTakeFirst(); if (!row) return null; const scan = JSON.parse(row.result_json) as ContractScan; return { ...scan, flags: visibleRiskFlags(scan.flags) }; }
  async saveRouteAssessment(chainId: number, address: Address, assessment: RouteAssessment): Promise<void> { await this.db.transaction().execute(async (trx) => { await trx.insertInto('route_assessments').values({ chain_id: chainId, token_address: address, assessed_at: new Date().toISOString(), provider: assessment.buy?.provider ?? null, state: assessment.state, result_json: JSON.stringify(assessment) }).execute(); await trx.updateTable('candidates').set({ route_state: assessment.state, route_recovery_pct: assessment.recoveryPct }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }); }
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
  async enqueueScheduled(kind: string, dedupeKey: string, payload: unknown, runAfter = new Date().toISOString()): Promise<string | null> {
    // Scheduled bucket keys are permanent idempotency keys. The active-job
    // unique index prevents concurrent duplicates, while this historical check
    // prevents the ten-second scheduler from recreating a completed bucket.
    const existing = await this.db.selectFrom('jobs').select('id').where('kind', '=', kind).where('dedupe_key', '=', dedupeKey).executeTakeFirst();
    return existing ? null : this.enqueue(kind, dedupeKey, payload, runAfter);
  }
  private jobPriority(kind: string, dedupeKey: string): number {
    if (dedupeKey.startsWith('manual:')) return 0;
    if (kind === 'discover') return 1;
    if (kind === 'retention') return 2;
    if (dedupeKey.startsWith('watch:')) return 3;
    if (dedupeKey.startsWith('refresh:')) return 5;
    if (dedupeKey.startsWith('universe:')) return 6;
    return 4;
  }

  async jobQueueStatus(id: string): Promise<{ state: string; position: number | null; queuedAhead: number; estimatedWaitSeconds: number; createdAt: string; updatedAt: string } | null> {
    const job = await this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!job) return null;
    if (job.state !== 'queued') return { state: job.state, position: job.state === 'running' ? 0 : null, queuedAhead: 0, estimatedWaitSeconds: 0, createdAt: job.created_at, updatedAt: job.updated_at };

    const due = await this.db.selectFrom('jobs').select(['id', 'kind', 'dedupe_key', 'run_after', 'created_at']).where('state', '=', 'queued').where('run_after', '<=', new Date().toISOString()).execute();
    due.sort((left, right) => this.jobPriority(left.kind, left.dedupe_key) - this.jobPriority(right.kind, right.dedupe_key)
      || left.run_after.localeCompare(right.run_after)
      || left.created_at.localeCompare(right.created_at)
      || left.id.localeCompare(right.id));
    const index = due.findIndex((candidate) => candidate.id === id);
    const queuedAhead = Math.max(0, index);
    const running = await this.db.selectFrom('jobs').select(['kind', 'dedupe_key', 'locked_at']).where('state', '=', 'running').orderBy('locked_at').executeTakeFirst();
    const runningEstimate = running
      ? running.kind === 'discover' ? 180 : running.kind === 'retention' ? 60 : 15
      : 0;
    const runningElapsed = running?.locked_at ? Math.max(0, (Date.now() - Date.parse(running.locked_at)) / 1000) : 0;
    const queuedEstimate = due.slice(0, queuedAhead).reduce((seconds, candidate) => seconds + (candidate.kind === 'discover' ? 180 : candidate.kind === 'retention' ? 60 : 15), 0);
    return {
      state: job.state,
      position: index >= 0 ? index + 1 : null,
      queuedAhead,
      estimatedWaitSeconds: Math.max(0, Math.ceil(runningEstimate - runningElapsed + queuedEstimate)),
      createdAt: job.created_at,
      updatedAt: job.updated_at
    };
  }

  async claimJob(workerId: string): Promise<{ id: string; kind: string; payload: any; attempts: number } | null> { return this.db.transaction().execute(async (trx) => { const row = await trx.selectFrom('jobs').selectAll().where('state', '=', 'queued').where('run_after', '<=', new Date().toISOString()).orderBy(sql`CASE WHEN dedupe_key LIKE 'manual:%' THEN 0 WHEN kind = 'discover' THEN 1 WHEN kind = 'retention' THEN 2 WHEN dedupe_key LIKE 'watch:%' THEN 3 WHEN dedupe_key LIKE 'refresh:%' THEN 5 WHEN dedupe_key LIKE 'universe:%' THEN 6 ELSE 4 END`).orderBy('run_after').orderBy('created_at').orderBy('id').executeTakeFirst(); if (!row) return null; const updated = await trx.updateTable('jobs').set({ state: 'running', locked_at: new Date().toISOString(), locked_by: workerId, attempts: row.attempts + 1, updated_at: new Date().toISOString() }).where('id', '=', row.id).where('state', '=', 'queued').returningAll().executeTakeFirst(); return updated ? { id: updated.id, kind: updated.kind, payload: JSON.parse(updated.payload_json), attempts: updated.attempts } : null; }); }
  async recoverExpiredJobLeases(lockedBefore: string): Promise<number> {
    const result = await this.db.updateTable('jobs').set({ state: 'queued', locked_at: null, locked_by: null, updated_at: new Date().toISOString() })
      .where('state', '=', 'running').where('locked_at', '<=', lockedBefore).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }
  async finishJob(id: string): Promise<void> { await this.db.updateTable('jobs').set({ state: 'completed', locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).where('id', '=', id).execute(); }
  async failJob(id: string, error: string, retryAt?: string): Promise<void> { await this.db.updateTable('jobs').set({ state: retryAt ? 'queued' : 'failed', run_after: retryAt ?? new Date().toISOString(), last_error: error.slice(0, 500), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).where('id', '=', id).execute(); }
  async jobStats(): Promise<Record<string, number>> { const rows = await this.db.selectFrom('jobs').select(['state', ({ fn }) => fn.countAll<number>().as('count')]).groupBy('state').execute(); return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)])); }

  async emit(eventType: string, payload: unknown): Promise<void> { await this.db.insertInto('app_events').values({ event_type: eventType, payload_json: JSON.stringify(payload), created_at: new Date().toISOString() }).execute(); }
  async latestEventId(): Promise<number> { const row = await this.db.selectFrom('app_events').select('id').orderBy('id', 'desc').executeTakeFirst(); return row?.id ?? 0; }
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

  /**
   * Apply bounded storage policies without sacrificing live research state.
   * Watched candidates and active jobs are never eligible. Versioned
   * assessment families retain full recent detail, one daily record through
   * the long horizon, and the newest record per candidate forever.
   */
  async housekeeping(policy: HousekeepingPolicy, now = new Date()): Promise<HousekeepingReport> {
    const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const archiveCutoff = cutoff(policy.candidateArchiveDays);
    const archivedCandidateCutoff = cutoff(policy.archivedCandidateDays);
    const discoveryCutoff = cutoff(policy.discoveryDays);
    const completedJobCutoff = cutoff(policy.completedJobDays);
    const failedJobCutoff = cutoff(policy.failedJobDays);
    const alertCutoff = cutoff(policy.alertDays);
    const appEventCutoff = cutoff(policy.appEventDays);
    const assessmentDetailCutoff = cutoff(policy.assessmentDetailDays);
    const assessmentDailyCutoff = cutoff(policy.assessmentDailyDays);
    const marketHistoryDeleted = await this.retention(policy.rawDays, policy.fiveMinuteDays, policy.hourlyDays);

    return this.db.transaction().execute(async (trx) => {
      const archived = await sql`
        UPDATE candidates AS candidate
        SET state = 'archived', updated_at = ${now.toISOString()}
        WHERE candidate.watched = 0
          AND candidate.state <> 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM watchlist_items AS item
            WHERE item.chain_id = candidate.chain_id AND item.token_address = candidate.address
          )
          AND COALESCE((
            SELECT MAX(record.ingested_at) FROM discovery_records AS record
            WHERE record.chain_id = candidate.chain_id AND record.token_address = candidate.address
          ), candidate.discovered_at) < ${archiveCutoff}
          AND COALESCE((
            SELECT MAX(snapshot.ingested_at) FROM market_snapshots AS snapshot
            WHERE snapshot.chain_id = candidate.chain_id AND snapshot.token_address = candidate.address
          ), candidate.discovered_at) < ${archiveCutoff}
          AND COALESCE((
            SELECT MAX(pair.last_seen_at) FROM pairs AS pair
            WHERE pair.chain_id = candidate.chain_id AND pair.token_address = candidate.address
          ), candidate.discovered_at) < ${archiveCutoff}
      `.execute(trx);

      // Purging is a second, much longer phase after archival. Every dependent
      // evidence table without a foreign-key cascade is cleared explicitly.
      const purgePredicate = sql`EXISTS (
        SELECT 1 FROM candidates AS candidate
        WHERE candidate.chain_id = target.chain_id
          AND candidate.address = target.token_address
          AND candidate.state = 'archived'
          AND candidate.watched = 0
          AND candidate.updated_at < ${archivedCandidateCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM watchlist_items AS item
            WHERE item.chain_id = candidate.chain_id AND item.token_address = candidate.address
          )
      )`;
      await sql`DELETE FROM swing_studies AS target WHERE ${purgePredicate}`.execute(trx);
      await sql`DELETE FROM contract_scans AS target WHERE ${purgePredicate}`.execute(trx);
      await sql`DELETE FROM route_assessments AS target WHERE ${purgePredicate}`.execute(trx);
      await sql`DELETE FROM score_history AS target WHERE ${purgePredicate}`.execute(trx);
      await sql`DELETE FROM alerts AS target WHERE ${purgePredicate}`.execute(trx);
      await sql`DELETE FROM discovery_records AS target WHERE EXISTS (
        SELECT 1 FROM candidates AS candidate
        WHERE candidate.chain_id = target.chain_id
          AND candidate.address = target.token_address
          AND candidate.state = 'archived'
          AND candidate.watched = 0
          AND candidate.updated_at < ${archivedCandidateCutoff}
      )`.execute(trx);
      await sql`DELETE FROM market_aggregates AS target WHERE ${purgePredicate}`.execute(trx);
      const purged = await sql`
        DELETE FROM candidates
        WHERE state = 'archived' AND watched = 0 AND updated_at < ${archivedCandidateCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM watchlist_items AS item
            WHERE item.chain_id = candidates.chain_id AND item.token_address = candidates.address
          )
      `.execute(trx);

      const discovery = await trx.deleteFrom('discovery_records').where('ingested_at', '<', discoveryCutoff).executeTakeFirst();
      const completedJobs = await trx.deleteFrom('jobs').where('state', '=', 'completed').where('updated_at', '<', completedJobCutoff).executeTakeFirst();
      const failedJobs = await trx.deleteFrom('jobs').where('state', '=', 'failed').where('updated_at', '<', failedJobCutoff).executeTakeFirst();
      const alerts = await sql`
        DELETE FROM alerts
        WHERE created_at < ${alertCutoff}
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY chain_id, token_address, kind ORDER BY created_at DESC, rowid DESC
              ) AS rank FROM alerts
            ) WHERE rank = 1
          )
      `.execute(trx);
      const appEvents = await trx.deleteFrom('app_events').where('created_at', '<', appEventCutoff).executeTakeFirst();

      let assessmentHistoryDeleted = 0;
      const assessmentTables = [
        ['swing_studies', 'generated_at'],
        ['contract_scans', 'scanned_at'],
        ['route_assessments', 'assessed_at'],
        ['score_history', 'calculated_at']
      ] as const;
      for (const [tableName, timeColumn] of assessmentTables) {
        const table = sql.raw(tableName);
        const time = sql.raw(timeColumn);
        const expired = await sql`
          DELETE FROM ${table}
          WHERE ${time} < ${assessmentDailyCutoff}
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY chain_id, token_address ORDER BY ${time} DESC, id DESC
                ) AS rank FROM ${table}
              ) WHERE rank = 1
            )
        `.execute(trx);
        const compacted = await sql`
          DELETE FROM ${table}
          WHERE ${time} < ${assessmentDetailCutoff}
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY chain_id, token_address, SUBSTR(${time}, 1, 10)
                  ORDER BY ${time} DESC, id DESC
                ) AS rank FROM ${table}
              ) WHERE rank = 1
            )
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY chain_id, token_address ORDER BY ${time} DESC, id DESC
                ) AS rank FROM ${table}
              ) WHERE rank = 1
            )
        `.execute(trx);
        assessmentHistoryDeleted += Number(expired.numAffectedRows ?? 0n) + Number(compacted.numAffectedRows ?? 0n);
      }

      return {
        marketHistoryDeleted,
        candidatesArchived: Number(archived.numAffectedRows ?? 0n),
        candidatesDeleted: Number(purged.numAffectedRows ?? 0n),
        discoveryDeleted: Number(discovery.numDeletedRows),
        jobsDeleted: Number(completedJobs.numDeletedRows + failedJobs.numDeletedRows),
        alertsDeleted: Number(alerts.numAffectedRows ?? 0n),
        appEventsDeleted: Number(appEvents.numDeletedRows),
        assessmentHistoryDeleted
      };
    });
  }
}

export { type DatabaseSchema } from './schema.js';
