import { describe, expect, it } from 'vitest';
import { scoreCandidate, type MarketSnapshot, type RiskFlag, type RouteAssessment, type SwingStudy } from '../src/index.js';

const latest: MarketSnapshot = { id: 1, chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', pairAddress: null, dex: 'test', priceNative: '1', priceUsd: '3000', liquidityUsd: '1000000', fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: '1000000', buys24h: 100, sells24h: 100, pairCreatedAt: '2025-01-01T00:00:00.000Z', sourceTime: null, ingestedAt: '2026-01-01T00:00:00.000Z', source: 'fixture', fingerprint: '1' };

const availableRoute: RouteAssessment = {
  plannedPrincipalWei: '1', recoveryPct: 99, state: 'available', hardFail: false, explanation: 'available',
  buy: { provider: 'fixture', quotedAt: '2026-01-01T00:00:00.000Z', state: 'available', tokenIn: 'native', tokenOut: latest.tokenAddress, amountIn: '1', amountOut: '10', priceImpactPct: null, gasEstimate: null, errorCode: null },
  sell: { provider: 'fixture', quotedAt: '2026-01-01T00:00:00.000Z', state: 'available', tokenIn: latest.tokenAddress, tokenOut: 'native', amountIn: '10', amountOut: '1', priceImpactPct: null, gasEstimate: null, errorCode: null }
};

const swingStudy: SwingStudy = {
  algorithmVersion: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', parameters: { thresholds: [0.05], horizonsSeconds: { '7d': 604_800 }, expectedPollSeconds: 3600, maxGapMultiplier: 3, minimumEventSeparationSeconds: 60, confirmationSamples: 1 },
  results: [{ threshold: 0.05, horizon: '7d', upCrossings: 8, downCrossings: 8, completedRoundTrips: 15, eventsPerDay: 2.3, timeSinceLastEventSeconds: 3600, durationSeconds: { min: 3600, p25: 7200, median: 10_800, mean: 10_800, p75: 14_400, max: 18_000 }, eventTraversalDurationSeconds: { min: 3600, p25: 3600, median: 7200, mean: 7200, p75: 10_800, max: 14_400 }, amplitude: { min: 0.05, p25: 0.07, median: 0.09, mean: 0.09, p75: 0.11, max: 0.14 }, maximumDrawdown: 0.2, volatility: 0.04, drift: 0.05, rangeChange: 0, timeInsideDominantRangePct: 60, suitability: 90, quality: { sampleCount: 160, coveragePct: 95, largestGapSeconds: 3600, expectedPollSeconds: 3600, sourceCount: 1, earliestAt: '2025-12-25T00:00:00.000Z', latestAt: '2026-01-01T00:00:00.000Z' }, events: [] }]
};

const unknownRisk: RiskFlag = { code: 'source_verification', label: 'Source verification', state: 'unknown', severity: 'info', confidence: 0, explanation: 'unknown', evidence: [] };

describe('transparent scoring', () => {
  it('lowers confidence rather than inventing route safety when quotes are unavailable', () => {
    const result = scoreCandidate({ latest, swings: null, route: { plannedPrincipalWei: '1', buy: null, sell: null, recoveryPct: null, state: 'not_configured', hardFail: false, explanation: 'missing' }, risks: [], now: '2026-01-01T00:00:00.000Z' });
    expect(result.materialUnknowns).toContain('executable_route_unverified');
    expect(result.hardFails).not.toContain('attempted_buy_but_no_sell_route');
    expect(result.confidence).toBeLessThan(70);
  });

  it('hard-fails only an attempted buy whose sell route is absent', () => {
    const result = scoreCandidate({ latest, swings: null, route: { plannedPrincipalWei: '1', recoveryPct: null, state: 'no_route_or_liquidity', hardFail: true, explanation: 'sell missing', buy: { provider: 'fixture', quotedAt: '2026-01-01T00:00:00.000Z', state: 'available', tokenIn: 'native', tokenOut: latest.tokenAddress, amountIn: '1', amountOut: '10', priceImpactPct: null, gasEstimate: null, errorCode: null }, sell: { provider: 'fixture', quotedAt: '2026-01-01T00:00:00.000Z', state: 'no_route_or_liquidity', tokenIn: latest.tokenAddress, tokenOut: 'native', amountIn: '10', amountOut: null, priceImpactPct: null, gasEstimate: null, errorCode: 'NO_ROUTE' } }, risks: [], now: '2026-01-01T00:00:00.000Z' });
    expect(result.verdict).toBe('REJECT');
    expect(result.hardFails).toContain('attempted_buy_but_no_sell_route');
  });

  it('passes an established swing-rich market while keeping non-safety unknowns visible', () => {
    const result = scoreCandidate({ latest, swings: swingStudy, route: availableRoute, risks: [unknownRisk], now: '2026-01-01T00:00:00.000Z' });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.verdict).toBe('PASS');
    expect(result.materialUnknowns).toContain('contract_posture_incomplete');
  });

  it('prefers seven-day maturity and does not pass a two-day-old market', () => {
    const established = scoreCandidate({ latest: { ...latest, pairCreatedAt: '2025-12-24T00:00:00.000Z' }, swings: swingStudy, route: availableRoute, risks: [unknownRisk], now: '2026-01-01T00:00:00.000Z' });
    const young = scoreCandidate({ latest: { ...latest, pairCreatedAt: '2025-12-30T00:00:00.000Z' }, swings: swingStudy, route: availableRoute, risks: [unknownRisk], now: '2026-01-01T00:00:00.000Z' });
    expect(established.score).toBeGreaterThan(young.score);
    expect(established.verdict).toBe('PASS');
    expect(young.verdict).toBe('CAUTION');
  });

  it('requires a confirmed executable route before PASS', () => {
    const result = scoreCandidate({ latest, swings: swingStudy, route: { ...availableRoute, state: 'not_configured', buy: null, sell: null, recoveryPct: null }, risks: [unknownRisk], now: '2026-01-01T00:00:00.000Z' });
    expect(result.verdict).toBe('CAUTION');
    expect(result.materialUnknowns).toContain('executable_route_unverified');
  });

  it('does not pass a market whose swing behaviour is mediocre', () => {
    const mediocre = { ...swingStudy, results: swingStudy.results.map((result) => ({ ...result, suitability: 55 })) };
    const result = scoreCandidate({ latest, swings: mediocre, route: availableRoute, risks: [unknownRisk], now: '2026-01-01T00:00:00.000Z' });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.verdict).toBe('CAUTION');
  });
});
