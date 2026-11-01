import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';

describe('retention configuration', () => {
  it('preserves legacy cleanup behavior when comprehensive settings are absent', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' });
    expect(config.COMPREHENSIVE_RETENTION_ENABLED).toBe(false);
    expect(config.RAW_RETENTION_DAYS).toBe(7);
    expect(config.CANDLE_RETENTION_DAYS).toBe(90);
    expect(config.HOURLY_RETENTION_DAYS).toBe(730);
    expect(config.CANDIDATE_REFRESH_ENABLED).toBe(false);
    expect(config.UNIVERSE_REFRESH_ENABLED).toBe(false);
    expect(config.GECKOTERMINAL_REQUESTS_PER_MINUTE).toBe(6);
  });

  it('accepts explicit bounded candidate refresh activation', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', CANDIDATE_REFRESH_ENABLED: 'true', CANDIDATE_REFRESH_SECONDS: '1800', CANDIDATE_REFRESH_MIN_SCORE: '65', CANDIDATE_REFRESH_BATCH_SIZE: '25' });
    expect(config.CANDIDATE_REFRESH_ENABLED).toBe(true);
    expect(config.CANDIDATE_REFRESH_SECONDS).toBe(1800);
    expect(config.CANDIDATE_REFRESH_MIN_SCORE).toBe(65);
    expect(config.CANDIDATE_REFRESH_BATCH_SIZE).toBe(25);
  });

  it('rejects an unsafe candidate refresh cadence', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', CANDIDATE_REFRESH_SECONDS: '60' })).toThrow('CANDIDATE_REFRESH_SECONDS');
  });

  it('accepts explicit bounded full-universe refresh activation', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', UNIVERSE_REFRESH_ENABLED: 'true', UNIVERSE_REFRESH_SECONDS: '172800', UNIVERSE_REFRESH_BATCH_SIZE: '3', JOB_LEASE_SECONDS: '1200' });
    expect(config.UNIVERSE_REFRESH_ENABLED).toBe(true);
    expect(config.UNIVERSE_REFRESH_SECONDS).toBe(172800);
    expect(config.UNIVERSE_REFRESH_BATCH_SIZE).toBe(3);
    expect(config.JOB_LEASE_SECONDS).toBe(1200);
  });

  it('rejects an unsafe full-universe refresh cadence', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', UNIVERSE_REFRESH_SECONDS: '3600' })).toThrow('UNIVERSE_REFRESH_SECONDS');
  });

  it('accepts a bounded GeckoTerminal provider budget', () => {
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', GECKOTERMINAL_REQUESTS_PER_MINUTE: '10' }).GECKOTERMINAL_REQUESTS_PER_MINUTE).toBe(10);
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', GECKOTERMINAL_REQUESTS_PER_MINUTE: '31' })).toThrow('GECKOTERMINAL_REQUESTS_PER_MINUTE');
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
