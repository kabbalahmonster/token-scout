import { describe, expect, it } from 'vitest';
import { generateRecommendation, recommendationToEnv, type ScoreResult } from '../src/index.js';

const score: ScoreResult = { version: '1.0.0', score: 70, confidence: 60, verdict: 'CAUTION', hardFails: [], materialUnknowns: [], components: [], calculatedAt: '2026-01-01T00:00:00.000Z' };

describe('bot-compatible recommendation export', () => {
  it('uses real bot environment names and percentage units', () => {
    const draft = generateRecommendation({ chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', pairAddress: null, latest: null, swings: null, score, plannedBudgetWei: '100000000000000000', positionCount: 4 });
    expect(draft.values.GRIDLESS_BUY_THRESHOLD).toBe('-5.00');
    expect(draft.values.GRIDLESS_SELL_THRESHOLD).toBe('5.00');
    expect(draft.values.GRIDLESS_LADDER_TERMINAL_DRAWDOWN_PERCENT).toBe('24.00');
    expect(draft.values.GRIDLESS_MIN_POSITION_ETH).toBe('0.025');
    expect(draft.values.GRIDLESS_STOPLOSS_ENABLED).toBe(false);
    expect(draft.values).not.toHaveProperty('GRIDLESS_TERMINAL_DRAWDOWN');
    expect(draft.values).not.toHaveProperty('EXECUTION_MARGIN_BPS');
    const env = recommendationToEnv(draft);
    expect(env).toContain('USE_GRIDLESS=true');
    expect(env).toContain('GRIDLESS_ALLOCATION_MODE=drawdown_ladder');
  });
});
