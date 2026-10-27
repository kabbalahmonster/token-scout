import { describe, expect, it } from 'vitest';
import { selectCanonicalMarketPair, staleAfterSeconds } from '../src/service.js';

const shallow = { pairAddress: '0x2222222222222222222222222222222222222222' as const, liquidityUsd: '100' };
const deep = { pairAddress: '0x3333333333333333333333333333333333333333' as const, liquidityUsd: '1000' };

describe('assessment pair selection', () => {
  it('honors a persisted canonical override before liquidity ranking', () => {
    expect(selectCanonicalMarketPair([deep, shallow], shallow.pairAddress)).toBe(shallow);
  });

  it('falls back to the deepest known-liquidity pair', () => {
    expect(selectCanonicalMarketPair([shallow, deep], null)).toBe(deep);
  });
});

describe('candidate freshness windows', () => {
  it('uses the fast poll cadence for watched candidates', () => {
    expect(staleAfterSeconds(true, 60, 900)).toBe(180);
  });

  it('uses the discovery cadence for the broader candidate universe', () => {
    expect(staleAfterSeconds(false, 60, 900)).toBe(2700);
  });
});
