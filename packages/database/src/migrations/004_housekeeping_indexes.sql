-- Keep daily housekeeping set-based as the discovery universe grows. These
-- additive indexes do not change persisted records or legacy behaviour.
CREATE INDEX IF NOT EXISTS idx_candidates_retention ON candidates(watched, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_discovery_retention ON discovery_records(ingested_at);
CREATE INDEX IF NOT EXISTS idx_discovery_token_time ON discovery_records(chain_id, token_address, ingested_at);
CREATE INDEX IF NOT EXISTS idx_jobs_retention ON jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_alerts_retention ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_latest ON alerts(chain_id, token_address, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_app_events_retention ON app_events(created_at);
CREATE INDEX IF NOT EXISTS idx_swing_studies_retention ON swing_studies(chain_id, token_address, generated_at);
CREATE INDEX IF NOT EXISTS idx_contract_scans_retention ON contract_scans(chain_id, token_address, scanned_at);
CREATE INDEX IF NOT EXISTS idx_route_assessments_retention ON route_assessments(chain_id, token_address, assessed_at);
CREATE INDEX IF NOT EXISTS idx_score_history_retention ON score_history(chain_id, token_address, calculated_at);
