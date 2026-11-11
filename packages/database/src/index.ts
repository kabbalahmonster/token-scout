import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import { classifyAssetType, isEvmAddress, type Address, type AssetType, type Candidate, type CandidateState, type ContractScan, type MarketSnapshot, type PoolAddress, type RiskFlag, type RouteAssessment, type ScoreResult, type SourceStatus, type SwingStudy, type Verdict } from '@doomscout/domain';
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
    state: row.state as CandidateState, canonicalPair: row.canonical_pair as PoolAddress | null, discoveredAt: row.discovered_at, updatedAt: row.updated_at,
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

function sanitizeJobError(error: string): string {
  return error
    .replace(/https?:\/\/[^\s]+/gi, (value) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString(); } catch { return '[upstream URL]'; } })
    .replace(/(api[_-]?key|authorization|token)(?:=|:)[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
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
export type JobOrigin = 'manual' | 'import' | 'discovery' | 'watchlist' | 'refresh' | 'universe' | 'maintenance' | 'other';
export type JobLane = 'watchlist' | 'exploration' | 'refresh' | 'universe';
export interface JobActivity {
  id: string; kind: string; origin: JobOrigin; state: string; chainId: number | null; address: Address | null;
  symbol: string | null; name: string | null; verdict: Verdict | null; score: number | null; confidence: number | null;
  position: number | null; queuedAhead: number; estimatedWaitSeconds: number; progressStage: string | null; progressPercent: number;
  attempts: number; runAfter: string; createdAt: string; startedAt: string | null; completedAt: string | null; updatedAt: string;
  durationSeconds: number | null; error: string | null;
}
export interface JobActivityFilters { state?: string; kind?: string; origin?: JobOrigin; search?: string; limit?: number }
export interface JobEvent { id: number; jobId: string; eventType: string; stage: string | null; message: string; progressPercent: number | null; createdAt: string }
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
    return (await this.listCandidatePage(filters)).data;
  }

  async listCandidatePage(filters: CandidateFilters = {}): Promise<{ data: Candidate[]; total: number }> {
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
    return { data: sorted.slice(offset, offset + Math.min(filters.limit ?? 100, 2000)), total: sorted.length };
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

  async upsertPair(input: { chainId: number; tokenAddress: Address; pairAddress: PoolAddress; dex: string; url: string | null; quoteTokenAddress: Address | null; createdAt: string | null; liquidityUsd: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('pairs').values({ chain_id: input.chainId, token_address: input.tokenAddress, pair_address: input.pairAddress, dex: input.dex, url: input.url, quote_token_address: input.quoteTokenAddress, created_at: input.createdAt, liquidity_usd: input.liquidityUsd, last_seen_at: now })
      .onConflict((conflict) => conflict.columns(['chain_id', 'pair_address']).doUpdateSet({ liquidity_usd: input.liquidityUsd, last_seen_at: now, url: input.url })).execute();
    // Canonical pair defaults to greatest known USD liquidity. Unknown is never coerced to zero.
    const best = await this.db.selectFrom('pairs').select(['pair_address']).where('chain_id', '=', input.chainId).where('token_address', '=', input.tokenAddress).where('liquidity_usd', 'is not', null).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').executeTakeFirst();
    if (best) await this.db.updateTable('candidates').set({ canonical_pair: best.pair_address, updated_at: now }).where('chain_id', '=', input.chainId).where('address', '=', input.tokenAddress).where('canonical_pair_override', 'is', null).execute();
  }
  async listPairs(chainId: number, address: Address): Promise<Array<{ pairAddress: PoolAddress; dex: string; url: string | null; liquidityUsd: string | null; createdAt: string | null }>> { const rows = await this.db.selectFrom('pairs').selectAll().where('chain_id', '=', chainId).where('token_address', '=', address).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').execute(); return rows.map((row) => ({ pairAddress: row.pair_address as PoolAddress, dex: row.dex, url: row.url, liquidityUsd: row.liquidity_usd, createdAt: row.created_at })); }
  async setCanonicalPairOverride(chainId: number, address: Address, pairAddress: PoolAddress | null): Promise<void> {
    let canonicalPair = pairAddress;
    if (pairAddress !== null) {
      const pair = await this.db.selectFrom('pairs').select('pair_address').where('chain_id', '=', chainId).where('token_address', '=', address).where('pair_address', '=', pairAddress).executeTakeFirst();
      if (!pair) throw new Error('Canonical pair override must belong to this candidate');
    } else {
      const best = await this.db.selectFrom('pairs').select('pair_address').where('chain_id', '=', chainId).where('token_address', '=', address).where('liquidity_usd', 'is not', null).orderBy(sql`CAST(liquidity_usd AS REAL)`, 'desc').executeTakeFirst();
      canonicalPair = best?.pair_address as PoolAddress | undefined ?? null;
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
  async listWatchlistItems(id: string): Promise<Array<{ candidate: Candidate; tags: string[]; note: string | null; addedAt: string }>> {
    const rows = await this.db.selectFrom('watchlist_items').selectAll().where('watchlist_id', '=', id).orderBy('created_at', 'desc').execute();
    const items = await Promise.all(rows.map(async (row) => {
      const candidate = await this.getCandidate(row.chain_id, row.token_address as Address);
      return candidate ? { candidate, tags: JSON.parse(row.tags_json) as string[], note: row.note, addedAt: row.created_at } : null;
    }));
    return items.filter((item): item is NonNullable<typeof item> => item !== null);
  }
  async addWatchlistItem(id: string, chainId: number, address: Address, tags: string[] = []): Promise<void> { const now = new Date().toISOString(); await this.db.transaction().execute(async (trx) => { await trx.insertInto('watchlist_items').values({ watchlist_id: id, chain_id: chainId, token_address: address, tags_json: JSON.stringify(tags), note: null, created_at: now }).onConflict((conflict) => conflict.columns(['watchlist_id', 'chain_id', 'token_address']).doUpdateSet({ tags_json: JSON.stringify(tags) })).execute(); await trx.updateTable('candidates').set({ watched: 1, state: 'watched', updated_at: now }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }); }
  async removeWatchlistItem(id: string, chainId: number, address: Address): Promise<void> { await this.db.deleteFrom('watchlist_items').where('watchlist_id', '=', id).where('chain_id', '=', chainId).where('token_address', '=', address).execute(); const other = await this.db.selectFrom('watchlist_items').select(({ fn }) => fn.countAll<number>().as('count')).where('chain_id', '=', chainId).where('token_address', '=', address).executeTakeFirst(); if (Number(other?.count ?? 0) === 0) await this.db.updateTable('candidates').set({ watched: 0, state: 'assessed', updated_at: new Date().toISOString() }).where('chain_id', '=', chainId).where('address', '=', address).execute(); }

  async setSourceStatus(status: SourceStatus): Promise<void> { await this.db.insertInto('source_status').values({ source: status.source, state: status.state, checked_at: status.checkedAt, last_success_at: status.lastSuccessAt, latency_ms: status.latencyMs, failures: status.failures, circuit_open_until: status.circuitOpenUntil, message: status.message }).onConflict((conflict) => conflict.column('source').doUpdateSet({ state: status.state, checked_at: status.checkedAt, last_success_at: status.lastSuccessAt, latency_ms: status.latencyMs, failures: status.failures, circuit_open_until: status.circuitOpenUntil, message: status.message })).execute(); }
  async sourceStatuses(): Promise<SourceStatus[]> { const rows = await this.db.selectFrom('source_status').selectAll().orderBy('source').execute(); return rows.map((row) => ({ source: row.source, state: row.state as SourceStatus['state'], checkedAt: row.checked_at, lastSuccessAt: row.last_success_at, latencyMs: row.latency_ms, failures: row.failures, circuitOpenUntil: row.circuit_open_until, message: row.message })); }

  async recordDiscovery(input: { chainId: number; tokenAddress: Address | null; source: string; sourceId: string | null; sourceTime: string | null; outcome: string; errorCode?: string }): Promise<void> { const ingestedAt = new Date().toISOString(); const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, bucket: ingestedAt.slice(0, 16) })).digest('hex'); await this.db.insertInto('discovery_records').values({ chain_id: input.chainId, token_address: input.tokenAddress, source: input.source, source_id: input.sourceId, source_time: input.sourceTime, ingested_at: ingestedAt, outcome: input.outcome, error_code: input.errorCode ?? null, fingerprint }).onConflict((conflict) => conflict.column('fingerprint').doNothing()).execute(); }

  async enqueue(kind: string, dedupeKey: string, payload: unknown, runAfter = new Date().toISOString()): Promise<string | null> {
    const id = randomUUID(); const now = new Date().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const result = await trx.insertInto('jobs').values({ id, kind, dedupe_key: dedupeKey, payload_json: JSON.stringify(payload), state: 'queued', run_after: runAfter, attempts: 0, locked_at: null, locked_by: null, last_error: null, progress_stage: runAfter > now ? 'scheduled' : 'queued', progress_percent: 0, started_at: null, completed_at: null, result_verdict: null, result_score: null, result_confidence: null, created_at: now, updated_at: now }).onConflict((conflict) => conflict.doNothing()).returning('id').executeTakeFirst();
      if (!result) return null;
      await trx.insertInto('job_events').values({ job_id: id, event_type: 'queued', stage: runAfter > now ? 'scheduled' : 'queued', message: runAfter > now ? 'Assessment scheduled for a later retry window.' : 'Assessment entered the queue.', progress_percent: 0, created_at: now }).execute();
      return id;
    });
  }
  async enqueueScheduled(kind: string, dedupeKey: string, payload: unknown, runAfter = new Date().toISOString()): Promise<string | null> {
    // Scheduled bucket keys are permanent idempotency keys. The active-job
    // unique index prevents concurrent duplicates, while this historical check
    // prevents the ten-second scheduler from recreating a completed bucket.
    // Assessments additionally coalesce by contract. Otherwise each hourly
    // bucket can append another copy of work that has not started yet.
    if (kind === 'assess') {
      const payloadJson = JSON.stringify(payload); const now = new Date().toISOString();
      const active = await this.db.selectFrom('jobs').selectAll().where('kind', '=', 'assess').where('payload_json', '=', payloadJson).where('state', 'in', ['queued', 'running']).execute();
      const running = active.find((job) => job.state === 'running');
      if (running) return running.id;
      const queued = active.sort((left, right) => this.jobPriority(left.kind, left.dedupe_key) - this.jobPriority(right.kind, right.dedupe_key) || left.created_at.localeCompare(right.created_at))[0];
      if (queued) {
        if (this.jobPriority(kind, dedupeKey) < this.jobPriority(queued.kind, queued.dedupe_key)) {
          await this.db.transaction().execute(async (trx) => {
            await trx.updateTable('jobs').set({ dedupe_key: dedupeKey, run_after: runAfter < queued.run_after ? runAfter : queued.run_after, progress_stage: 'priority_promoted', updated_at: now }).where('id', '=', queued.id).where('state', '=', 'queued').execute();
            await trx.insertInto('job_events').values({ job_id: queued.id, event_type: 'priority_promoted', stage: 'priority_promoted', message: 'Existing assessment moved into a higher-priority queue lane.', progress_percent: 0, created_at: now }).execute();
          });
        }
        return queued.id;
      }
    }
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

  private jobOrigin(kind: string, dedupeKey: string): JobOrigin {
    if (dedupeKey.startsWith('manual:')) return 'manual';
    if (dedupeKey.startsWith('import:')) return 'import';
    if (kind === 'discover') return 'discovery';
    if (dedupeKey.startsWith('watch:')) return 'watchlist';
    if (dedupeKey.startsWith('refresh:')) return 'refresh';
    if (dedupeKey.startsWith('universe:')) return 'universe';
    if (dedupeKey.startsWith('explore:') || /^\d+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}$/.test(dedupeKey)) return 'discovery';
    if (kind === 'retention') return 'maintenance';
    return 'other';
  }

  private jobLane(kind: string, dedupeKey: string): JobLane | 'urgent' | 'other' {
    if (dedupeKey.startsWith('manual:') || kind === 'discover' || kind === 'retention') return 'urgent';
    if (dedupeKey.startsWith('watch:')) return 'watchlist';
    if (dedupeKey.startsWith('refresh:')) return 'refresh';
    if (dedupeKey.startsWith('universe:')) return 'universe';
    if (kind === 'assess' && (dedupeKey.startsWith('explore:') || dedupeKey.startsWith('import:') || /^\d+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}$/.test(dedupeKey))) return 'exploration';
    return 'other';
  }

  private fairQueueOrder(due: DatabaseSchema['jobs'][]): DatabaseSchema['jobs'][] {
    const ordered = [...due].sort((left, right) => this.jobPriority(left.kind, left.dedupe_key) - this.jobPriority(right.kind, right.dedupe_key)
      || left.run_after.localeCompare(right.run_after) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    const lanes = new Map<string, DatabaseSchema['jobs'][]>(['urgent', 'watchlist', 'exploration', 'refresh', 'universe', 'other'].map((lane) => [lane, []]));
    for (const job of ordered) lanes.get(this.jobLane(job.kind, job.dedupe_key))!.push(job);
    // Watchlist remains the largest share, while every twelve claims reserve
    // three exploration slots and one slot for each slower update lane.
    const pattern: JobLane[] = ['watchlist', 'watchlist', 'watchlist', 'exploration', 'watchlist', 'watchlist', 'refresh', 'exploration', 'watchlist', 'watchlist', 'universe', 'exploration'];
    const result: DatabaseSchema['jobs'][] = []; let slot = 0;
    while (result.length < due.length) {
      const urgent = lanes.get('urgent')!.shift();
      if (urgent) { result.push(urgent); continue; }
      const preferred = lanes.get(pattern[slot % pattern.length]!)!.shift();
      let fallback = preferred;
      if (!fallback) for (const lane of ['watchlist', 'exploration', 'refresh', 'universe', 'other']) { fallback = lanes.get(lane)!.shift(); if (fallback) break; }
      if (!fallback) break;
      result.push(fallback); slot += 1;
    }
    return result;
  }

  private fallbackJobSeconds(kind: string): number { return kind === 'discover' ? 180 : kind === 'retention' ? 60 : 15; }

  private async jobEstimates(): Promise<Map<string, number>> {
    const completed = await this.db.selectFrom('jobs').select(['kind', 'started_at', 'completed_at']).where('state', '=', 'completed').where('started_at', 'is not', null).where('completed_at', 'is not', null).orderBy('completed_at', 'desc').limit(100).execute();
    const samples = new Map<string, number[]>();
    for (const job of completed) {
      const seconds = (Date.parse(job.completed_at!) - Date.parse(job.started_at!)) / 1000;
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) continue;
      const values = samples.get(job.kind) ?? []; values.push(seconds); samples.set(job.kind, values);
    }
    return new Map([...samples].map(([kind, values]) => {
      const sorted = values.sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
      return [kind, Math.max(2, Math.ceil(median))];
    }));
  }

  private async queueContext(now = new Date().toISOString()): Promise<{ due: DatabaseSchema['jobs'][]; positions: Map<string, number>; waits: Map<string, number>; running: DatabaseSchema['jobs'][] }> {
    const [due, running, estimates] = await Promise.all([
      this.db.selectFrom('jobs').selectAll().where('state', '=', 'queued').where('run_after', '<=', now).execute(),
      this.db.selectFrom('jobs').selectAll().where('state', '=', 'running').orderBy('started_at').execute(),
      this.jobEstimates()
    ]);
    const orderedDue = this.fairQueueOrder(due);
    const estimate = (job: Pick<DatabaseSchema['jobs'], 'kind'>) => estimates.get(job.kind) ?? this.fallbackJobSeconds(job.kind);
    const runningWait = running.reduce((seconds, job) => {
      const elapsed = job.started_at ? Math.max(0, (Date.parse(now) - Date.parse(job.started_at)) / 1000) : 0;
      return seconds + Math.max(0, estimate(job) - elapsed);
    }, 0);
    let cumulative = runningWait;
    const positions = new Map<string, number>(); const waits = new Map<string, number>();
    orderedDue.forEach((job, index) => { positions.set(job.id, index + 1); waits.set(job.id, Math.max(0, Math.ceil(cumulative))); cumulative += estimate(job); });
    return { due: orderedDue, positions, waits, running };
  }

  private async jobActivityFromRows(rows: DatabaseSchema['jobs'][]): Promise<JobActivity[]> {
    const context = await this.queueContext();
    const identities = new Map<string, { chainId: number; address: Address }>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as { chainId?: unknown; address?: unknown };
        if (typeof payload.chainId === 'number' && typeof payload.address === 'string' && isEvmAddress(payload.address)) identities.set(`${payload.chainId}:${payload.address.toLowerCase()}`, { chainId: payload.chainId, address: payload.address.toLowerCase() as Address });
      } catch { /* malformed historical payloads remain visible without identity */ }
    }
    const candidates = new Map<string, { symbol: string | null; name: string | null; verdict: Verdict; score: number | null; confidence: number }>();
    if (identities.size) {
      const wanted = [...identities.values()];
      for (let offset = 0; offset < wanted.length; offset += 200) {
        const chunk = wanted.slice(offset, offset + 200);
        const rows = await this.db.selectFrom('candidates').select(['chain_id', 'address', 'symbol', 'name', 'verdict', 'score', 'confidence']).where((eb) => eb.or(chunk.map((identity) => eb.and([eb('chain_id', '=', identity.chainId), eb('address', '=', identity.address)])))).execute();
        for (const candidate of rows) { const key = `${candidate.chain_id}:${candidate.address.toLowerCase()}`; candidates.set(key, { symbol: candidate.symbol, name: candidate.name, verdict: candidate.verdict as Verdict, score: candidate.score, confidence: candidate.confidence }); }
      }
    }
    return rows.map((row) => {
      let chainId: number | null = null; let address: Address | null = null;
      try { const payload = JSON.parse(row.payload_json) as { chainId?: unknown; address?: unknown }; if (typeof payload.chainId === 'number') chainId = payload.chainId; if (typeof payload.address === 'string' && isEvmAddress(payload.address)) address = payload.address.toLowerCase() as Address; } catch { /* see above */ }
      const candidate = chainId !== null && address ? candidates.get(`${chainId}:${address}`) : undefined;
      const durationSeconds = row.started_at ? Math.max(0, Math.round((Date.parse(row.completed_at ?? new Date().toISOString()) - Date.parse(row.started_at)) / 1000)) : null;
      return { id: row.id, kind: row.kind, origin: this.jobOrigin(row.kind, row.dedupe_key), state: row.state, chainId, address, symbol: candidate?.symbol ?? null, name: candidate?.name ?? null, verdict: (row.result_verdict as Verdict | null) ?? candidate?.verdict ?? null, score: row.result_score ?? candidate?.score ?? null, confidence: row.result_confidence ?? candidate?.confidence ?? null, position: row.state === 'running' ? 0 : context.positions.get(row.id) ?? null, queuedAhead: row.state === 'queued' ? Math.max(0, (context.positions.get(row.id) ?? 1) - 1) : 0, estimatedWaitSeconds: context.waits.get(row.id) ?? 0, progressStage: row.progress_stage, progressPercent: row.progress_percent, attempts: row.attempts, runAfter: row.run_after, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, updatedAt: row.updated_at, durationSeconds, error: row.last_error };
    });
  }

  async jobQueueStatus(id: string): Promise<JobActivity | null> {
    const job = await this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
    return job ? (await this.jobActivityFromRows([job]))[0] ?? null : null;
  }

  async listJobActivity(filters: JobActivityFilters = {}): Promise<JobActivity[]> {
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 250));
    let query = this.db.selectFrom('jobs').selectAll().where('state', '<>', 'superseded');
    if (filters.state === 'active') query = query.where('state', 'in', ['queued', 'running']);
    else if (filters.state) query = query.where('state', '=', filters.state);
    if (filters.kind) query = query.where('kind', '=', filters.kind);
    const activeView = ['active', 'queued', 'running'].includes(filters.state ?? '');
    const fetchLimit = activeView ? 2000 : Math.max(limit, filters.search || filters.origin ? 500 : limit);
    const rows = await query.orderBy(sql`CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END`).orderBy('updated_at', 'desc').limit(fetchLimit).execute();
    let activity = await this.jobActivityFromRows(rows);
    if (filters.origin) activity = activity.filter((job) => job.origin === filters.origin);
    if (filters.search) { const term = filters.search.toLowerCase(); activity = activity.filter((job) => [job.address, job.symbol, job.name, job.id].some((value) => value?.toLowerCase().includes(term))); }
    activity.sort((left, right) => {
      const rank = (state: string) => state === 'running' ? 0 : state === 'queued' ? 1 : 2;
      const stateDifference = rank(left.state) - rank(right.state); if (stateDifference) return stateDifference;
      if (left.state === 'queued' && right.state === 'queued') return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) || left.runAfter.localeCompare(right.runAfter);
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    return activity.slice(0, limit);
  }

  async jobEvents(jobId?: string, limit = 100): Promise<JobEvent[]> {
    let query = this.db.selectFrom('job_events').selectAll();
    if (jobId) query = query.where('job_id', '=', jobId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.max(1, Math.min(limit, 250))).execute();
    return rows.map((row) => ({ id: row.id, jobId: row.job_id, eventType: row.event_type, stage: row.stage, message: row.message, progressPercent: row.progress_percent, createdAt: row.created_at }));
  }

  async claimJob(workerId: string, preferredLane?: JobLane): Promise<{ id: string; kind: string; payload: any; attempts: number; lane: JobLane | 'urgent' | 'other' } | null> {
    return this.db.transaction().execute(async (trx) => {
      const laneOrder = preferredLane === 'watchlist'
        ? sql<number>`CASE WHEN dedupe_key LIKE 'watch:%' THEN 0 ELSE 1 END`
        : preferredLane === 'refresh'
          ? sql<number>`CASE WHEN dedupe_key LIKE 'refresh:%' THEN 0 ELSE 1 END`
          : preferredLane === 'universe'
            ? sql<number>`CASE WHEN dedupe_key LIKE 'universe:%' THEN 0 ELSE 1 END`
            : preferredLane === 'exploration'
              ? sql<number>`CASE WHEN kind = 'assess' AND dedupe_key NOT LIKE 'manual:%' AND dedupe_key NOT LIKE 'watch:%' AND dedupe_key NOT LIKE 'refresh:%' AND dedupe_key NOT LIKE 'universe:%' THEN 0 ELSE 1 END`
              : sql<number>`CASE WHEN 1 = 1 THEN 0 ELSE 1 END`;
      const row = await trx.selectFrom('jobs').selectAll().where('state', '=', 'queued').where('run_after', '<=', new Date().toISOString())
        .orderBy(sql`CASE WHEN dedupe_key LIKE 'manual:%' OR kind = 'discover' OR kind = 'retention' THEN 0 ELSE 1 END`)
        .orderBy(laneOrder)
        .orderBy(sql`CASE WHEN dedupe_key LIKE 'manual:%' THEN 0 WHEN kind = 'discover' THEN 1 WHEN kind = 'retention' THEN 2 WHEN dedupe_key LIKE 'watch:%' THEN 3 WHEN dedupe_key LIKE 'refresh:%' THEN 5 WHEN dedupe_key LIKE 'universe:%' THEN 6 ELSE 4 END`).orderBy('run_after').orderBy('created_at').orderBy('id').executeTakeFirst();
      if (!row) return null;
      const now = new Date().toISOString();
      const updated = await trx.updateTable('jobs').set({ state: 'running', locked_at: now, locked_by: workerId, attempts: row.attempts + 1, last_error: null, progress_stage: 'starting', progress_percent: 1, started_at: now, completed_at: null, updated_at: now }).where('id', '=', row.id).where('state', '=', 'queued').returningAll().executeTakeFirst();
      if (!updated) return null;
      await trx.insertInto('job_events').values({ job_id: updated.id, event_type: 'started', stage: 'starting', message: `Worker started ${updated.kind}.`, progress_percent: 1, created_at: now }).execute();
      return { id: updated.id, kind: updated.kind, payload: JSON.parse(updated.payload_json), attempts: updated.attempts, lane: this.jobLane(updated.kind, updated.dedupe_key) };
    });
  }

  async updateJobProgress(id: string, stage: string, progressPercent: number, message: string): Promise<void> {
    const now = new Date().toISOString(); const progress = Math.max(1, Math.min(99, Math.round(progressPercent))); const safeStage = stage.slice(0, 80); const safeMessage = message.slice(0, 300);
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable('jobs').set({ progress_stage: safeStage, progress_percent: progress, updated_at: now }).where('id', '=', id).where('state', '=', 'running').returning('id').executeTakeFirst();
      if (updated) await trx.insertInto('job_events').values({ job_id: id, event_type: 'progress', stage: safeStage, message: safeMessage, progress_percent: progress, created_at: now }).execute();
    });
  }
  async recoverExpiredJobLeases(lockedBefore: string): Promise<number> {
    const now = new Date().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const expired = await trx.selectFrom('jobs').select('id').where('state', '=', 'running').where('locked_at', '<=', lockedBefore).execute();
      if (!expired.length) return 0;
      await trx.updateTable('jobs').set({ state: 'queued', locked_at: null, locked_by: null, started_at: null, progress_stage: 'lease_recovered', progress_percent: 0, updated_at: now }).where('id', 'in', expired.map((job) => job.id)).execute();
      await trx.insertInto('job_events').values(expired.map((job) => ({ job_id: job.id, event_type: 'lease_recovered', stage: 'lease_recovered', message: 'Expired worker lease recovered; job returned to the queue.', progress_percent: 0, created_at: now }))).execute();
      return expired.length;
    });
  }
  async finishJob(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom('jobs').select(['kind', 'payload_json']).where('id', '=', id).executeTakeFirst();
      let result: { verdict: string; score: number | null; confidence: number } | undefined;
      if (job?.kind === 'assess') try { const payload = JSON.parse(job.payload_json) as { chainId?: unknown; address?: unknown }; if (typeof payload.chainId === 'number' && typeof payload.address === 'string' && isEvmAddress(payload.address)) result = await trx.selectFrom('candidates').select(['verdict', 'score', 'confidence']).where('chain_id', '=', payload.chainId).where('address', '=', payload.address.toLowerCase()).executeTakeFirst(); } catch { /* completion remains valid without a result snapshot */ }
      await trx.updateTable('jobs').set({ state: 'completed', progress_stage: 'completed', progress_percent: 100, locked_at: null, locked_by: null, completed_at: now, result_verdict: result?.verdict ?? null, result_score: result?.score ?? null, result_confidence: result?.confidence ?? null, updated_at: now }).where('id', '=', id).execute();
      await trx.insertInto('job_events').values({ job_id: id, event_type: 'completed', stage: 'completed', message: result ? `Assessment completed: ${result.verdict}${result.score === null ? '' : ` ${result.score.toFixed(1)}`}.` : 'Assessment completed and results were persisted.', progress_percent: 100, created_at: now }).execute();
    });
  }
  async failJob(id: string, error: string, retryAt?: string): Promise<void> {
    const now = new Date().toISOString(); const safeError = sanitizeJobError(error); const retrying = Boolean(retryAt);
    await this.db.transaction().execute(async (trx) => { await trx.updateTable('jobs').set({ state: retrying ? 'queued' : 'failed', run_after: retryAt ?? now, last_error: safeError, progress_stage: retrying ? 'retrying' : 'failed', progress_percent: 0, locked_at: null, locked_by: null, started_at: retrying ? null : undefined, completed_at: retrying ? null : now, updated_at: now }).where('id', '=', id).execute(); await trx.insertInto('job_events').values({ job_id: id, event_type: retrying ? 'retry_scheduled' : 'failed', stage: retrying ? 'retrying' : 'failed', message: retrying ? `Attempt failed; retry scheduled. ${safeError}` : `Assessment failed after its retry budget. ${safeError}`, progress_percent: 0, created_at: now }).execute(); });
  }
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
      const completedJobs = await trx.deleteFrom('jobs').where('state', 'in', ['completed', 'superseded']).where('updated_at', '<', completedJobCutoff).executeTakeFirst();
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
