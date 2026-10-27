import { describe, expect, it } from 'vitest';
import { classifyAssetType } from '../src/index.js';

describe('asset classification', () => {
  it('recognizes Robinhood stock and fund wrappers', () => {
    expect(classifyAssetType('GME', 'GameStop • Robinhood Token')).toBe('tokenized_stock');
    expect(classifyAssetType('SPY', 'SPDR S&P 500 ETF Trust • Robinhood Token')).toBe('tokenized_stock');
  });

  it('recognizes stablecoin metadata', () => {
    expect(classifyAssetType('USDG', 'Global Dollar')).toBe('stablecoin');
    expect(classifyAssetType('USDC', 'USD Coin')).toBe('stablecoin');
  });

  it('keeps ordinary and unknown tokens in the crypto view', () => {
    expect(classifyAssetType('WETH', 'Wrapped Ether')).toBe('crypto');
    expect(classifyAssetType(null, null)).toBe('crypto');
  });
});
