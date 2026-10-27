import { describe, expect, it } from 'vitest';
import { calculateSwingStudy, type MarketSnapshot } from '../src/index.js';

const base = Date.parse('2026-01-01T00:00:00.000Z');
function snapshot(id: number, minute: number, price: string): MarketSnapshot {
  return { id, chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', pairAddress: null, dex: null, priceNative: price, priceUsd: null, liquidityUsd: '100000', fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: null, buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: null, ingestedAt: new Date(base + minute * 60_000).toISOString(), source: 'fixture', fingerprint: String(id) };
}

describe('swing engine', () => {
  it('detects confirmed directional crossings and round trips', () => {
    const study = calculateSwingStudy([
      snapshot(1, 0, '1'), snapshot(2, 1, '1.06'), snapshot(3, 2, '1.061'),
      snapshot(4, 3, '1.00'), snapshot(5, 4, '0.999'), snapshot(6, 5, '1.06')
    ], { thresholds: [0.05], horizonsSeconds: { '1h': 3600 }, confirmationSamples: 1 }, new Date(base + 5 * 60_000).toISOString());
    const result = study.results[0]!;
    expect(result.upCrossings).toBeGreaterThan(0);
    expect(result.downCrossings).toBeGreaterThan(0);
    expect(result.completedRoundTrips).toBeGreaterThan(0);
    expect(result.events.every((event) => event.startSnapshotId !== event.endSnapshotId)).toBe(true);
  });

  it('does not bridge a gap longer than three expected polls', () => {
    const result = calculateSwingStudy([snapshot(1, 0, '1'), snapshot(2, 10, '1.2')], { thresholds: [0.05], horizonsSeconds: { '1h': 3600 }, expectedPollSeconds: 60 }, new Date(base + 10 * 60_000).toISOString()).results[0]!;
    expect(result.events).toHaveLength(0);
    expect(result.quality.largestGapSeconds).toBe(600);
  });

  it('uses decimal prices without converting token units through Number first', () => {
    const result = calculateSwingStudy([snapshot(1, 0, '0.000000000000000001'), snapshot(2, 1, '0.0000000000000000011')], { thresholds: [0.05], horizonsSeconds: { '1h': 3600 } }, new Date(base + 60_000).toISOString()).results[0]!;
    expect(result.upCrossings).toBe(1);
  });

  it('keeps hourly aggregate points connected for 30-day swing studies', () => {
    const points = [
      { ...snapshot(-1, 0, '1'), source: 'doomscout_1h_aggregate' },
      { ...snapshot(-2, 60, '1.10'), source: 'doomscout_1h_aggregate' },
      { ...snapshot(-3, 120, '1.00'), source: 'doomscout_1h_aggregate' },
      { ...snapshot(-4, 180, '1.10'), source: 'doomscout_1h_aggregate' }
    ];
    const result = calculateSwingStudy(points, { thresholds: [0.05], horizonsSeconds: { '30d': 2_592_000 } }, new Date(base + 180 * 60_000).toISOString()).results[0]!;
    expect(result.events.length).toBeGreaterThan(1);
    expect(result.eventTraversalDurationSeconds.mean).toBe(3600);
    expect(result.quality.coveragePct).toBeGreaterThan(0);
  });
});
