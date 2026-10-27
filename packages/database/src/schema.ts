import type { Generated } from 'kysely';

export interface CandidateTable {
  chain_id: number; address: string; symbol: string | null; name: string | null; decimals: number | null; total_supply: string | null;
  state: string; canonical_pair: string | null; canonical_pair_override: string | null; discovered_at: string; updated_at: string;
  watched: number; score: number | null; verdict: string; confidence: number; score_version: string | null; flags_json: string;
  last_error_code: string | null; last_error_message: string | null; last_error_at: string | null;
}
export interface SnapshotTable {
  id: Generated<number>; chain_id: number; token_address: string; pair_address: string | null; dex: string | null;
  price_native: string | null; price_usd: string | null; liquidity_usd: string | null; fdv_usd: string | null; market_cap_usd: string | null;
  volume_5m_usd: string | null; volume_1h_usd: string | null; volume_6h_usd: string | null; volume_24h_usd: string | null;
  buys_24h: number | null; sells_24h: number | null; pair_created_at: string | null; source_time: string | null; ingested_at: string;
  source: string; fingerprint: string; raw_evidence_json: string | null;
}
export interface PairTable { chain_id: number; token_address: string; pair_address: string; dex: string; url: string | null; quote_token_address: string | null; created_at: string | null; liquidity_usd: string | null; last_seen_at: string }
export interface SourceStatusTable { source: string; state: string; checked_at: string; last_success_at: string | null; latency_ms: number | null; failures: number; circuit_open_until: string | null; message: string | null }
export interface JobTable { id: string; kind: string; dedupe_key: string; payload_json: string; state: string; run_after: string; attempts: number; locked_at: string | null; locked_by: string | null; last_error: string | null; created_at: string; updated_at: string }
export interface WatchlistTable { id: string; name: string; labels_json: string; assessment_budget_wei: string | null; intended_position_count: number | null; created_at: string; updated_at: string }
export interface WatchlistItemTable { watchlist_id: string; chain_id: number; token_address: string; tags_json: string; note: string | null; created_at: string }
export interface JsonResultTable { id: Generated<number>; chain_id: number; token_address: string; result_json: string }
export interface SwingStudyTable extends JsonResultTable { algorithm_version: string; generated_at: string; parameters_json: string }
export interface ContractScanTable extends JsonResultTable { scan_version: string; code_hash: string | null; scanned_at: string }
export interface RouteAssessmentTable extends JsonResultTable { assessed_at: string; provider: string | null; state: string }
export interface ScoreHistoryTable extends JsonResultTable { score_version: string; calculated_at: string; score: number; confidence: number; verdict: string }
export interface AppEventTable { id: Generated<number>; event_type: string; payload_json: string; created_at: string }
export interface AlertTable { id: string; chain_id: number; token_address: string; kind: string; severity: string; message: string; evidence_json: string; created_at: string; read_at: string | null }
export interface DiscoveryTable { id: Generated<number>; chain_id: number; token_address: string | null; source: string; source_id: string | null; source_time: string | null; ingested_at: string; outcome: string; error_code: string | null; fingerprint: string }
export interface AggregateTable { chain_id: number; token_address: string; resolution_seconds: number; bucket_at: string; open_price: string | null; high_price: string | null; low_price: string | null; close_price: string | null; sample_count: number; latest_snapshot_json: string }

export interface DatabaseSchema {
  candidates: CandidateTable; market_snapshots: SnapshotTable; pairs: PairTable; source_status: SourceStatusTable; jobs: JobTable;
  watchlists: WatchlistTable; watchlist_items: WatchlistItemTable; swing_studies: SwingStudyTable; contract_scans: ContractScanTable;
  route_assessments: RouteAssessmentTable; score_history: ScoreHistoryTable; app_events: AppEventTable; alerts: AlertTable; discovery_records: DiscoveryTable;
  market_aggregates: AggregateTable;
}
