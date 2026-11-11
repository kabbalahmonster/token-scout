-- Add durable, bounded queue observability without changing scheduling or
-- priority semantics. Existing terminal jobs receive useful completion times;
-- active legacy jobs remain valid with their default progress values.
ALTER TABLE jobs ADD COLUMN progress_stage TEXT;
ALTER TABLE jobs ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN completed_at TEXT;
ALTER TABLE jobs ADD COLUMN result_verdict TEXT;
ALTER TABLE jobs ADD COLUMN result_score REAL;
ALTER TABLE jobs ADD COLUMN result_confidence INTEGER;

UPDATE jobs
SET completed_at = updated_at,
    progress_stage = CASE state WHEN 'completed' THEN 'completed' ELSE 'failed' END,
    progress_percent = CASE state WHEN 'completed' THEN 100 ELSE 0 END
WHERE state IN ('completed', 'failed');

UPDATE jobs
SET started_at = locked_at,
    progress_stage = 'starting',
    progress_percent = 1
WHERE state = 'running';

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  progress_percent INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_jobs_activity ON jobs(state, updated_at DESC);
CREATE INDEX idx_jobs_queue_order ON jobs(state, run_after, created_at);
CREATE INDEX idx_job_events_job_time ON job_events(job_id, created_at, id);
CREATE INDEX idx_job_events_recent ON job_events(created_at DESC, id DESC);
