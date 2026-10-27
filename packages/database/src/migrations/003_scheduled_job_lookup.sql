CREATE INDEX IF NOT EXISTS idx_jobs_kind_dedupe ON jobs(kind, dedupe_key);
