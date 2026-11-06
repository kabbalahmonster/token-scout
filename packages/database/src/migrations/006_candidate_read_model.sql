-- Keep list endpoints off the large immutable evidence tables. Full evidence
-- remains available through candidate detail/history endpoints.
ALTER TABLE candidates ADD COLUMN detected_flags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE candidates ADD COLUMN latest_snapshot_json TEXT;
ALTER TABLE candidates ADD COLUMN latest_snapshot_at TEXT;
ALTER TABLE candidates ADD COLUMN swing_score REAL;
ALTER TABLE candidates ADD COLUMN swing_events_per_day REAL;
ALTER TABLE candidates ADD COLUMN route_state TEXT NOT NULL DEFAULT 'not_attempted';
ALTER TABLE candidates ADD COLUMN route_recovery_pct REAL;

UPDATE candidates AS candidate
SET detected_flags_json = COALESCE((
  SELECT json_group_array(json_object(
    'code', json_extract(value, '$.code'),
    'label', json_extract(value, '$.label'),
    'state', 'detected',
    'severity', json_extract(value, '$.severity'),
    'confidence', json_extract(value, '$.confidence'),
    'explanation', '',
    'evidence', json('[]')
  ))
  FROM json_each(candidate.flags_json)
  WHERE json_extract(value, '$.state') = 'detected'
    AND json_extract(value, '$.code') != 'source_verification'
), '[]');

UPDATE candidates AS candidate
SET (latest_snapshot_json, latest_snapshot_at) = (
  SELECT json_object(
    'id', snapshot.id,
    'chainId', snapshot.chain_id,
    'tokenAddress', snapshot.token_address,
    'pairAddress', snapshot.pair_address,
    'dex', snapshot.dex,
    'priceNative', snapshot.price_native,
    'priceUsd', snapshot.price_usd,
    'liquidityUsd', snapshot.liquidity_usd,
    'fdvUsd', snapshot.fdv_usd,
    'marketCapUsd', snapshot.market_cap_usd,
    'volume5mUsd', snapshot.volume_5m_usd,
    'volume1hUsd', snapshot.volume_1h_usd,
    'volume6hUsd', snapshot.volume_6h_usd,
    'volume24hUsd', snapshot.volume_24h_usd,
    'buys24h', snapshot.buys_24h,
    'sells24h', snapshot.sells_24h,
    'pairCreatedAt', snapshot.pair_created_at,
    'sourceTime', snapshot.source_time,
    'ingestedAt', snapshot.ingested_at,
    'source', snapshot.source,
    'fingerprint', snapshot.fingerprint
  ), snapshot.ingested_at
  FROM market_snapshots AS snapshot
  WHERE snapshot.chain_id = candidate.chain_id
    AND snapshot.token_address = candidate.address
  ORDER BY snapshot.ingested_at DESC, snapshot.id DESC
  LIMIT 1
);

UPDATE candidates AS candidate
SET (swing_score, swing_events_per_day) = (
  SELECT
    COALESCE(
      (SELECT json_extract(value, '$.suitability') FROM json_each(study.result_json, '$.results') WHERE json_extract(value, '$.threshold') = 0.05 AND json_extract(value, '$.horizon') = '7d' LIMIT 1),
      json_extract(study.result_json, '$.results[0].suitability')
    ),
    COALESCE(
      (SELECT json_extract(value, '$.eventsPerDay') FROM json_each(study.result_json, '$.results') WHERE json_extract(value, '$.threshold') = 0.05 AND json_extract(value, '$.horizon') = '7d' LIMIT 1),
      json_extract(study.result_json, '$.results[0].eventsPerDay')
    )
  FROM swing_studies AS study
  WHERE study.chain_id = candidate.chain_id
    AND study.token_address = candidate.address
  ORDER BY study.generated_at DESC, study.id DESC
  LIMIT 1
);

UPDATE candidates AS candidate
SET route_state = COALESCE((
  SELECT route.state
  FROM route_assessments AS route
  WHERE route.chain_id = candidate.chain_id
    AND route.token_address = candidate.address
  ORDER BY route.assessed_at DESC, route.id DESC
  LIMIT 1
), 'not_attempted'),
route_recovery_pct = (
  SELECT json_extract(route.result_json, '$.recoveryPct')
  FROM route_assessments AS route
  WHERE route.chain_id = candidate.chain_id
    AND route.token_address = candidate.address
  ORDER BY route.assessed_at DESC, route.id DESC
  LIMIT 1
);
