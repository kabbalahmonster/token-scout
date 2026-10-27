import type { AssetType } from './types.js';

const STABLECOIN_NAMES = /\b(stablecoin|usd coin|tether|global dollar|dai stablecoin|paypal usd|pax dollar|trueusd|first digital usd|frax|ethena usde|ripple usd)\b/i;
const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'USDG', 'USDS', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'GUSD', 'TUSD', 'FDUSD', 'USDE', 'USD0', 'CRVUSD', 'EURC', 'RLUSD']);

/** Classifies provider metadata without pretending an absent upstream category is authoritative. */
export function classifyAssetType(symbol: string | null, name: string | null): AssetType {
  if (/\brobinhood token\b/i.test(name ?? '')) return 'tokenized_stock';
  if (STABLECOIN_NAMES.test(name ?? '') || STABLECOIN_SYMBOLS.has((symbol ?? '').toUpperCase())) return 'stablecoin';
  return 'crypto';
}
