import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@doomscout/domain';
import { historicalMarketCap, priceChartData } from '../src/components/PriceChart.js';

function snapshot(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    id: 1,
    chainId: 4663,
    tokenAddress: '0x1111111111111111111111111111111111111111',
    pairAddress: null,
    dex: null,
    priceNative: null,
    priceUsd: '1',
    liquidityUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    volume5mUsd: null,
    volume1hUsd: null,
    volume6hUsd: null,
    volume24hUsd: null,
    buys24h: null,
    sells24h: null,
    pairCreatedAt: null,
    sourceTime: null,
    ingestedAt: '2026-10-27T00:00:00.000Z',
    source: 'fixture',
    fingerprint: 'fixture',
    ...overrides
  };
}

describe('historicalMarketCap', () => {
  it('keeps provider-reported values exact', () => {
    const point = snapshot({ marketCapUsd: '500000' });
    expect(historicalMarketCap(point, [point])).toEqual({ value: 500000, estimated: false });
  });

  it('estimates a candle from the nearest reported market-cap/price anchor', () => {
    const point = snapshot({ id: 2, priceUsd: '1.25', ingestedAt: '2026-10-26T23:00:00.000Z', source: 'geckoterminal_1h_candle' });
    const anchor = snapshot({ priceUsd: '1', marketCapUsd: '1000000' });
    expect(historicalMarketCap(point, [point, anchor])).toEqual({ value: 1250000, estimated: true });
  });

  it('does not pretend FDV is market cap when no reported anchor exists', () => {
    const point = snapshot({ priceUsd: '1.25', fdvUsd: '1250000' });
    expect(historicalMarketCap(point, [point])).toBeNull();
  });
});

describe('priceChartData', () => {
  it('connects regular retained samples using their observed cadence', () => {
    const snapshots = [0, 1, 2, 3].map((hour) => snapshot({
      id: hour + 1,
      fingerprint: `hour-${hour}`,
      source: 'doomscout_5m_aggregate',
      sourceTime: `2026-10-27T0${hour}:00:00.000Z`,
      ingestedAt: `2026-10-27T0${hour}:00:00.000Z`,
      priceUsd: String(1 + hour / 10)
    }));

    expect(priceChartData(snapshots).points).toHaveLength(4);
    expect(priceChartData(snapshots).points.every((point) => 'value' in point)).toBe(true);
  });

  it('still inserts whitespace across a genuine outage', () => {
    const hours = [0, 1, 2, 7];
    const snapshots = hours.map((hour, index) => snapshot({
      id: index + 1,
      fingerprint: `hour-${hour}`,
      source: 'geckoterminal_1h_candle',
      sourceTime: `2026-10-27T0${hour}:00:00.000Z`,
      ingestedAt: `2026-10-27T0${hour}:00:00.000Z`,
      priceUsd: String(1 + index / 10)
    }));

    const points = priceChartData(snapshots).points;
    expect(points).toHaveLength(5);
    expect(points.filter((point) => !('value' in point))).toHaveLength(1);
  });
});
