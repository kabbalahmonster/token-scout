import { createHash } from 'node:crypto';
import { normalizeAddress, type Address, type MarketSnapshot } from '@doomscout/domain';
import { AdapterError, ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

interface GeckoRelationship { data?: { id?: string; type?: string } }
interface GeckoPool {
  id?: string;
  attributes?: {
    address?: string; name?: string; pool_created_at?: string | null;
    base_token_price_usd?: string | null; base_token_price_native_currency?: string | null;
    quote_token_price_usd?: string | null; quote_token_price_native_currency?: string | null;
    fdv_usd?: string | null; market_cap_usd?: string | null; reserve_in_usd?: string | null;
    volume_usd?: { m5?: string; h1?: string; h6?: string; h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: { base_token?: GeckoRelationship; quote_token?: GeckoRelationship; dex?: GeckoRelationship };
}
interface PoolListResponse { data?: GeckoPool[] }
interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
  meta?: { base?: { address?: string; name?: string; symbol?: string }; quote?: { address?: string; name?: string; symbol?: string } };
}

const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function relationshipAddress(relationship: GeckoRelationship | undefined): string | null {
  const id = relationship?.data?.id;
  if (!id) return null;
  const value = id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id;
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null;
}

export interface GeckoDiscoveryLead {
  address: Address;
  poolAddress: Address;
  quoteTokenAddress: Address | null;
  tokenSide: 'base' | 'quote';
  dex: string;
  createdAt: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  buys24h: number;
  sells24h: number;
  sourceId: string;
  snapshot: Omit<MarketSnapshot, 'id'>;
  raw: unknown;
}

export class GeckoTerminalAdapter {
  private readonly client: ResilientHttpClient;

  constructor(private readonly baseUrl: string, options: ResilienceOptions, fetchImpl?: FetchLike, private readonly network = 'robinhood') {
    // GeckoTerminal's key-free budget is roughly 30 rpm. Stay below it and
    // share one queue across discovery and candle backfills.
    // Although the published key-free ceiling is higher, shared-IP deployments
    // can receive 429s below it. Ten rpm leaves room for other tools on the VPS
    // and makes discovery/backfill slow-but-boring instead of bursty.
    this.client = new ResilientHttpClient('geckoterminal', { ...options, requestsPerMinute: Math.min(10, options.requestsPerMinute), cacheTtlMs: Math.max(options.cacheTtlMs, 60_000) }, fetchImpl);
  }

  status() { return this.client.status(); }

  private normalizePool(pool: GeckoPool): GeckoDiscoveryLead | null {
    const attributes = pool.attributes;
    const poolRaw = attributes?.address;
    const baseRaw = relationshipAddress(pool.relationships?.base_token);
    const quoteRaw = relationshipAddress(pool.relationships?.quote_token);
    if (!poolRaw || !baseRaw || !quoteRaw) return null;
    const baseIsNative = baseRaw === NATIVE_SENTINEL;
    const tokenRaw = baseIsNative ? quoteRaw : baseRaw;
    if (tokenRaw === NATIVE_SENTINEL) return null;
    try {
      const address = normalizeAddress(tokenRaw);
      const poolAddress = normalizeAddress(poolRaw);
      const quoteTokenAddress = (baseIsNative ? baseRaw : quoteRaw) === NATIVE_SENTINEL ? null : normalizeAddress(baseIsNative ? baseRaw : quoteRaw);
      const tokenSide = baseIsNative ? 'quote' : 'base';
      const ingestedAt = new Date().toISOString();
      const priceUsd = tokenSide === 'base' ? attributes.base_token_price_usd ?? null : attributes.quote_token_price_usd ?? null;
      const priceNative = tokenSide === 'base' ? attributes.base_token_price_native_currency ?? null : attributes.quote_token_price_native_currency ?? null;
      const snapshotBase = {
        chainId: 4663, tokenAddress: address, pairAddress: poolAddress, dex: pool.relationships?.dex?.data?.id ?? 'unknown',
        priceNative, priceUsd, liquidityUsd: attributes.reserve_in_usd ?? null, fdvUsd: attributes.fdv_usd ?? null,
        marketCapUsd: attributes.market_cap_usd ?? null, volume5mUsd: attributes.volume_usd?.m5 ?? null,
        volume1hUsd: attributes.volume_usd?.h1 ?? null, volume6hUsd: attributes.volume_usd?.h6 ?? null,
        volume24hUsd: attributes.volume_usd?.h24 ?? null, buys24h: attributes.transactions?.h24?.buys ?? null,
        sells24h: attributes.transactions?.h24?.sells ?? null, pairCreatedAt: attributes.pool_created_at ?? null,
        sourceTime: null, ingestedAt, source: 'geckoterminal'
      };
      const fingerprint = createHash('sha256').update(JSON.stringify({ ...snapshotBase, bucket: ingestedAt.slice(0, 16) })).digest('hex');
      return {
        address, poolAddress, quoteTokenAddress, tokenSide, dex: snapshotBase.dex,
        createdAt: snapshotBase.pairCreatedAt, liquidityUsd: snapshotBase.liquidityUsd,
        volume24hUsd: snapshotBase.volume24hUsd, buys24h: snapshotBase.buys24h ?? 0,
        sells24h: snapshotBase.sells24h ?? 0, sourceId: pool.id ?? poolAddress,
        snapshot: { ...snapshotBase, fingerprint }, raw: pool
      };
    } catch { return null; }
  }

  async discover(topPages: number, newPages: number): Promise<GeckoDiscoveryLead[]> {
    const leads: GeckoDiscoveryLead[] = [];
    const feeds: Array<{ path: 'pools' | 'new_pools'; pages: number }> = [{ path: 'pools', pages: topPages }, { path: 'new_pools', pages: newPages }];
    for (const feed of feeds) {
      for (let page = 1; page <= feed.pages; page += 1) {
        try {
          const response = await this.client.json<PoolListResponse>(`${this.baseUrl}/networks/${this.network}/${feed.path}?page=${page}`);
          const normalized = (response.data ?? []).flatMap((pool) => { const lead = this.normalizePool(pool); return lead ? [lead] : []; });
          leads.push(...normalized);
          if ((response.data?.length ?? 0) < 20) break;
        } catch (error) {
          // A partial provider page is still real evidence. Stop this feed on
          // throttling/degradation and preserve successfully fetched pages.
          if (error instanceof AdapterError) break;
          throw error;
        }
      }
    }
    return [...new Map(leads.map((lead) => [`${lead.address}:${lead.poolAddress}`, lead])).values()];
  }

  async hourlyHistory(address: Address, poolAddress: Address, limit: number): Promise<Array<Omit<MarketSnapshot, 'id'>>> {
    const fetchSide = async (side: 'base' | 'quote') => this.client.json<OhlcvResponse>(`${this.baseUrl}/networks/${this.network}/pools/${poolAddress}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd&token=${side}`);
    let response = await fetchSide('base');
    const baseAddress = response.meta?.base?.address?.toLowerCase();
    const quoteAddress = response.meta?.quote?.address?.toLowerCase();
    if (baseAddress !== address.toLowerCase() && quoteAddress === address.toLowerCase()) response = await fetchSide('quote');
    else if (baseAddress !== address.toLowerCase()) return [];
    return (response.data?.attributes?.ohlcv_list ?? []).flatMap((candle, index) => {
      const [epoch, , , , close, volume] = candle;
      if (!Number.isFinite(epoch) || !Number.isFinite(close) || close <= 0) return [];
      const at = new Date(epoch * 1000).toISOString();
      return [{
        chainId: 4663, tokenAddress: address, pairAddress: poolAddress, dex: null,
        priceNative: null, priceUsd: String(close), liquidityUsd: null, fdvUsd: null, marketCapUsd: null,
        volume5mUsd: null, volume1hUsd: String(volume), volume6hUsd: null, volume24hUsd: null,
        buys24h: null, sells24h: null, pairCreatedAt: null, sourceTime: at, ingestedAt: at,
        source: 'geckoterminal_1h_candle', fingerprint: `geckoterminal:1h:${poolAddress}:${epoch}:${index}`
      }];
    });
  }
}
