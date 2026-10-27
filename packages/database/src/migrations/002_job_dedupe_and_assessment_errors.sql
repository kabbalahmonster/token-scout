DROP INDEX IF EXISTS idx_jobs_active_dedupe;

CREATE TABLE jobs_v2 (
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
INSERT INTO jobs_v2 SELECT id, kind, dedupe_key, payload_json, state, run_after,
  attempts, locked_at, locked_by, last_error, created_at, updated_at FROM jobs;
-- The old uniqueness rule allowed one queued and one running copy of the same
-- logical job. Preserve the running owner and discard only its redundant queue
-- entry before installing the active-job partial index.
DELETE FROM jobs_v2 AS queued
WHERE queued.state = 'queued'
  AND EXISTS (
    SELECT 1 FROM jobs_v2 AS running
    WHERE running.kind = queued.kind
      AND running.dedupe_key = queued.dedupe_key
      AND running.state = 'running'
  );
DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;
CREATE INDEX idx_jobs_due ON jobs(state, run_after);
CREATE UNIQUE INDEX idx_jobs_active_dedupe ON jobs(kind, dedupe_key) WHERE state IN ('queued', 'running');

ALTER TABLE candidates ADD COLUMN last_error_code TEXT;
ALTER TABLE candidates ADD COLUMN last_error_message TEXT;
ALTER TABLE candidates ADD COLUMN last_error_at TEXT;
