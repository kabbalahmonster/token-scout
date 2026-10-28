import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';

describe('retention configuration', () => {
  it('preserves legacy cleanup behavior when comprehensive settings are absent', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' });
    expect(config.COMPREHENSIVE_RETENTION_ENABLED).toBe(false);
    expect(config.RAW_RETENTION_DAYS).toBe(7);
    expect(config.CANDLE_RETENTION_DAYS).toBe(90);
    expect(config.HOURLY_RETENTION_DAYS).toBe(730);
  });

  it('accepts explicit comprehensive housekeeping activation', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', COMPREHENSIVE_RETENTION_ENABLED: 'true', CANDIDATE_ARCHIVE_DAYS: '14', ARCHIVED_CANDIDATE_RETENTION_DAYS: '90' });
    expect(config.COMPREHENSIVE_RETENTION_ENABLED).toBe(true);
    expect(config.CANDIDATE_ARCHIVE_DAYS).toBe(14);
    expect(config.ARCHIVED_CANDIDATE_RETENTION_DAYS).toBe(90);
  });

  it('rejects compaction horizons that would invert recent and daily retention', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ASSESSMENT_DETAIL_RETENTION_DAYS: '90', ASSESSMENT_DAILY_RETENTION_DAYS: '30' })).toThrow('ASSESSMENT_DAILY_RETENTION_DAYS');
  });
});
