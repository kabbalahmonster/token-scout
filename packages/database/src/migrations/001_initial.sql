PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candidates (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  decimals INTEGER,
  total_supply TEXT,
  state TEXT NOT NULL DEFAULT 'discovered',
  canonical_pair TEXT,
  canonical_pair_override TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  watched INTEGER NOT NULL DEFAULT 0,
  score REAL,
  verdict TEXT NOT NULL DEFAULT 'UNASSESSED',
  confidence INTEGER NOT NULL DEFAULT 0,
  score_version TEXT,
  flags_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS pairs (
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  dex TEXT NOT NULL,
  url TEXT,
  quote_token_address TEXT,
  created_at TEXT,
  liquidity_usd TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, pair_address),
  FOREIGN KEY (chain_id, token_address) REFERENCES candidates(chain_id, address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  pair_address TEXT,
  dex TEXT,
  price_native TEXT,
  price_usd TEXT,
  liquidity_usd TEXT,
  fdv_usd TEXT,
  market_cap_usd TEXT,
  volume_5m_usd TEXT,
  volume_1h_usd TEXT,
  volume_6h_usd TEXT,
  volume_24h_usd TEXT,
  buys_24h INTEGER,
  sells_24h INTEGER,
  pair_created_at TEXT,
  source_time TEXT,
  ingested_at TEXT NOT NULL,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  raw_evidence_json TEXT,
  UNIQUE (chain_id, token_address, fingerprint),
  FOREIGN KEY (chain_id, token_address) REFERENCES candidates(chain_id, address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON market_snapshots(chain_id, token_address, ingested_at);

CREATE TABLE IF NOT EXISTS market_aggregates (
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  bucket_at TEXT NOT NULL,
  open_price TEXT,
  high_price TEXT,
  low_price TEXT,
  close_price TEXT,
  sample_count INTEGER NOT NULL,
  latest_snapshot_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, token_address, resolution_seconds, bucket_at)
);
CREATE INDEX IF NOT EXISTS idx_aggregates_token_time ON market_aggregates(chain_id, token_address, resolution_seconds, bucket_at);

CREATE TABLE IF NOT EXISTS discovery_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT,
  source TEXT NOT NULL,
  source_id TEXT,
  source_time TEXT,
  ingested_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS swing_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE(chain_id, token_address, algorithm_version, generated_at)
);

CREATE TABLE IF NOT EXISTS contract_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  scan_version TEXT NOT NULL,
  code_hash TEXT,
  scanned_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  provider TEXT,
  state TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  score_version TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  score REAL NOT NULL,
  confidence INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  labels_json TEXT NOT NULL DEFAULT '[]',
  assessment_budget_wei TEXT,
  intended_position_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist_items (
  watchlist_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (watchlist_id, chain_id, token_address),
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, token_address) REFERENCES candidates(chain_id, address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS filter_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS source_status (
  source TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  last_success_at TEXT,
  latency_ms INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until TEXT,
  message TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  run_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(state, run_after);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe ON jobs(kind, dedupe_key) WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
