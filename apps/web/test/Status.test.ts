import { describe, expect, it } from 'vitest';
import type { Candidate } from '@doomscout/domain';
import { candidateMarketCap } from '../src/components/Status.js';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    chainId: 4663, address: '0x1111111111111111111111111111111111111111', symbol: 'FOX', name: 'Fox',
    decimals: 18, totalSupply: '1000000000000000000000000', assetType: 'crypto', state: 'assessed',
    canonicalPair: null, discoveredAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    watched: false, score: 50, verdict: 'CAUTION', confidence: 50, scoreVersion: '2.0.0', flags: [],
    latestSnapshot: { id: 1, chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', pairAddress: null, dex: null, priceNative: null, priceUsd: '0.5', liquidityUsd: null, fdvUsd: null, marketCapUsd: null, volume5mUsd: null, volume1hUsd: null, volume6hUsd: null, volume24hUsd: null, buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: null, ingestedAt: '2026-01-01T00:00:00Z', source: 'fixture', fingerprint: 'one' },
    ...overrides
  };
}

describe('candidate market cap', () => {
  it('prefers provider-reported market cap', () => {
    const value = candidateMarketCap(candidate({ latestSnapshot: { ...candidate().latestSnapshot!, marketCapUsd: '400000' } }));
    expect(value).toEqual({ value: '400000', estimated: false });
  });

  it('estimates from price and on-chain total supply when providers omit it', () => {
    expect(candidateMarketCap(candidate())).toEqual({ value: '500000', estimated: true });
  });
});
