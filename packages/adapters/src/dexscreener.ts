import { createHash } from 'node:crypto';
import { normalizeAddress, type Address, type MarketSnapshot } from '@doomscout/domain';
import { ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

interface TokenProfile { chainId?: string; tokenAddress?: string; url?: string; description?: string }
interface PairResponse { schemaVersion?: string; pairs?: DexPair[] | null }
interface DexPair {
  chainId?: string; dexId?: string; pairAddress?: string; url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceNative?: string; priceUsd?: string; liquidity?: { usd?: number }; fdv?: number; marketCap?: number;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } }; pairCreatedAt?: number;
}

export interface DiscoveryLead { address: Address; sourceId: string; sourceTime: string | null }
export interface DexTokenResult { token: { address: Address; symbol: string | null; name: string | null }; pairs: Array<{ pairAddress: Address; dex: string; url: string | null; quoteTokenAddress: Address | null; createdAt: string | null; liquidityUsd: string | null; snapshot: Omit<MarketSnapshot, 'id'>; raw: unknown }> }

export class DexScreenerAdapter {
  private readonly profilesClient: ResilientHttpClient;
  private readonly pairsClient: ResilientHttpClient;
  constructor(private readonly baseUrl: string, options: ResilienceOptions, fetchImpl?: FetchLike, private readonly chainSlug = 'robinhood') {
    // Official public budgets are 60 rpm for profiles and 300 rpm for pairs; stay below them.
    this.profilesClient = new ResilientHttpClient('dexscreener_profiles', { ...options, requestsPerMinute: Math.min(50, options.requestsPerMinute) }, fetchImpl);
    this.pairsClient = new ResilientHttpClient('dexscreener_pairs', { ...options, requestsPerMinute: Math.min(240, Math.max(options.requestsPerMinute, 60)) }, fetchImpl);
  }
  statuses() { return [this.profilesClient.status(), this.pairsClient.status()]; }

  async discover(): Promise<DiscoveryLead[]> {
    const profiles = await this.profilesClient.json<TokenProfile[]>(`${this.baseUrl}/token-profiles/latest/v1`);
    if (!Array.isArray(profiles)) return [];
    return profiles.filter((profile) => profile.chainId === this.chainSlug && profile.tokenAddress).flatMap((profile) => {
      try { const address = normalizeAddress(profile.tokenAddress!); return [{ address, sourceId: profile.url ?? address, sourceTime: null }]; } catch { return []; }
    });
  }

  async token(chainId: number, address: Address): Promise<DexTokenResult> {
    const response = await this.pairsClient.json<PairResponse>(`${this.baseUrl}/token-pairs/v1/${this.chainSlug}/${address}`);
    const pairs = Array.isArray(response) ? response as unknown as DexPair[] : response.pairs ?? [];
    // DoomScout analyzes the requested asset's own price and transfer route.
    // A pair where it appears only as quote has the inverse orientation and
    // must not be normalized as if its base price described this token.
    const valid = pairs.filter((pair) => pair.pairAddress
      && pair.baseToken?.address?.toLowerCase() === address.toLowerCase()
      && (!pair.chainId || pair.chainId === this.chainSlug));
    const primary = valid[0];
    return {
      token: { address, symbol: primary?.baseToken?.symbol ?? null, name: primary?.baseToken?.name ?? null },
      pairs: valid.flatMap((pair) => {
        try {
          const pairAddress = normalizeAddress(pair.pairAddress!);
          const quoteTokenAddress = pair.quoteToken?.address ? normalizeAddress(pair.quoteToken.address) : null;
          const ingestedAt = new Date().toISOString();
          const normalized = { pairAddress, dex: pair.dexId ?? 'unknown', priceNative: pair.priceNative ?? null, priceUsd: pair.priceUsd ?? null, liquidityUsd: pair.liquidity?.usd === undefined ? null : String(pair.liquidity.usd), fdvUsd: pair.fdv === undefined ? null : String(pair.fdv), marketCapUsd: pair.marketCap === undefined ? null : String(pair.marketCap), volume5mUsd: pair.volume?.m5 === undefined ? null : String(pair.volume.m5), volume1hUsd: pair.volume?.h1 === undefined ? null : String(pair.volume.h1), volume6hUsd: pair.volume?.h6 === undefined ? null : String(pair.volume.h6), volume24hUsd: pair.volume?.h24 === undefined ? null : String(pair.volume.h24), buys24h: pair.txns?.h24?.buys ?? null, sells24h: pair.txns?.h24?.sells ?? null, pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null, sourceTime: null, ingestedAt, source: 'dexscreener' };
          const fingerprint = createHash('sha256').update(JSON.stringify({ ...normalized, bucket: ingestedAt.slice(0, 16) })).digest('hex');
          return [{ pairAddress, dex: normalized.dex, url: pair.url ?? null, quoteTokenAddress, createdAt: normalized.pairCreatedAt, liquidityUsd: normalized.liquidityUsd, snapshot: { id: undefined, chainId, tokenAddress: address, ...normalized, fingerprint } as unknown as Omit<MarketSnapshot, 'id'>, raw: pair }];
        } catch { return []; }
      })
    };
  }
}
