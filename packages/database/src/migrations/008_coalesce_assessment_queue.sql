-- Collapse periodic duplicates that accumulated while an earlier assessment
-- for the same contract was still waiting. Keep running work first, otherwise
-- preserve the highest-priority/oldest queued request as the durable receipt.
INSERT INTO job_events(job_id, event_type, stage, message, progress_percent, created_at)
SELECT id, 'superseded', 'superseded',
       'Redundant queued assessment was coalesced into another active assessment.',
       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT id, state,
         ROW_NUMBER() OVER (
           PARTITION BY payload_json
           ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                    CASE
                      WHEN dedupe_key LIKE 'manual:%' THEN 0
                      WHEN dedupe_key LIKE 'watch:%' THEN 1
                      WHEN dedupe_key LIKE 'refresh:%' THEN 3
                      WHEN dedupe_key LIKE 'universe:%' THEN 4
                      ELSE 2
                    END,
                    run_after, created_at, id
         ) AS target_rank
  FROM jobs
  WHERE kind = 'assess' AND state IN ('queued', 'running')
)
WHERE state = 'queued' AND target_rank > 1;

UPDATE jobs
SET state = 'superseded',
    progress_stage = 'superseded',
    progress_percent = 0,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT id FROM (
    SELECT id, state,
           ROW_NUMBER() OVER (
             PARTITION BY payload_json
             ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                      CASE
                        WHEN dedupe_key LIKE 'manual:%' THEN 0
                        WHEN dedupe_key LIKE 'watch:%' THEN 1
                        WHEN dedupe_key LIKE 'refresh:%' THEN 3
                        WHEN dedupe_key LIKE 'universe:%' THEN 4
                        ELSE 2
                      END,
                      run_after, created_at, id
           ) AS target_rank
    FROM jobs
    WHERE kind = 'assess' AND state IN ('queued', 'running')
  )
  WHERE state = 'queued' AND target_rank > 1
);

CREATE INDEX idx_jobs_active_assessment_payload
ON jobs(kind, payload_json, state)
WHERE kind = 'assess' AND state IN ('queued', 'running');
