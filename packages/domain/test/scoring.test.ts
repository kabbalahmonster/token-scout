import { describe, expect, it } from 'vitest';
import { scoreCandidate, type MarketSnapshot } from '../src/index.js';

const latest: MarketSnapshot = { id: 1, chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', pairAddress: null, dex: 'test', priceNative: '1', priceUsd: '3000', liquidityUsd: '1000000', fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: '1000000', buys24h: 100, sells24h: 100, pairCreatedAt: '2025-01-01T00:00:00.000Z', sourceTime: null, ingestedAt: '2026-01-01T00:00:00.000Z', source: 'fixture', fingerprint: '1' };

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
});
