import { describe, expect, it, vi } from 'vitest';
import { DexScreenerAdapter, GeckoTerminalAdapter, JsonRpcAdapter, ResilientHttpClient, SushiQuoteAdapter } from '../src/index.js';

const options = { timeoutMs: 1000, retries: 0, cacheTtlMs: 1, requestsPerMinute: 100_000 };
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('adapter fixtures', () => {
  it('merges DexScreener latest profiles and top boosted discovery without duplicates', async () => {
    const address = '0x1111111111111111111111111111111111111111';
    const requestedUrls: string[] = [];
    const fetcher = vi.fn((url: unknown) => { requestedUrls.push(String(url)); return response([{ chainId: 'robinhood', tokenAddress: address }]); }) as unknown as typeof fetch;
    const result = await new DexScreenerAdapter('https://fixture.test', options, fetcher, 'robinhood', 100_000).discover();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ address, source: 'dexscreener_top_boost' });
    expect(requestedUrls).toEqual(['https://fixture.test/token-profiles/latest/v1', 'https://fixture.test/token-boosts/top/v1']);
  });

  it('normalizes DexScreener pairs without inventing missing values', async () => {
    const fetcher = vi.fn(() => response([{ chainId: 'robinhood', dexId: 'fixture', pairAddress: '0x2222222222222222222222222222222222222222', baseToken: { address: '0x1111111111111111111111111111111111111111', symbol: 'FOX', name: 'Fox' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' }, priceNative: '0.1', liquidity: { usd: 5000 } }])) as unknown as typeof fetch;
    const adapter = new DexScreenerAdapter('https://fixture.test', options, fetcher);
    const result = await adapter.token(4663, '0x1111111111111111111111111111111111111111');
    expect(result.pairs[0]?.snapshot.liquidityUsd).toBe('5000');
    expect(result.pairs[0]?.snapshot.volume24hUsd).toBeNull();
  });

  it('does not attribute a quote-side asset price to the requested token', async () => {
    const requested = '0x1111111111111111111111111111111111111111';
    const fetcher = vi.fn(() => response([{ chainId: 'robinhood', dexId: 'fixture', pairAddress: '0x2222222222222222222222222222222222222222', baseToken: { address: '0x3333333333333333333333333333333333333333', symbol: 'OTHER' }, quoteToken: { address: requested, symbol: 'FOX' }, priceUsd: '99', liquidity: { usd: 999999 } }])) as unknown as typeof fetch;
    const result = await new DexScreenerAdapter('https://fixture.test', options, fetcher).token(4663, requested);
    expect(result.token.symbol).toBeNull();
    expect(result.pairs).toHaveLength(0);
  });

  it('normalizes and deduplicates GeckoTerminal top/new/trending pool discovery', async () => {
    const pool = { id: 'robinhood_0x2222222222222222222222222222222222222222', attributes: { address: '0x2222222222222222222222222222222222222222', pool_created_at: '2026-10-01T00:00:00Z', base_token_price_usd: '0.01', base_token_price_native_currency: '0.00001', reserve_in_usd: '25000', volume_usd: { h24: '5000' }, transactions: { h24: { buys: 12, sells: 8 } } }, relationships: { base_token: { data: { id: 'robinhood_0x1111111111111111111111111111111111111111' } }, quote_token: { data: { id: 'robinhood_0x3333333333333333333333333333333333333333' } }, dex: { data: { id: 'fixture-dex' } } } };
    const requestedUrls: string[] = [];
    const fetcher = vi.fn((url: unknown) => { requestedUrls.push(String(url)); return response({ data: [pool] }); }) as unknown as typeof fetch;
    const leads = await new GeckoTerminalAdapter('https://fixture.test', options, fetcher, 'robinhood', 100_000).discover(1, 1, 1);
    expect(leads).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(requestedUrls).toEqual([
      'https://fixture.test/networks/robinhood/pools?page=1',
      'https://fixture.test/networks/robinhood/new_pools?page=1',
      'https://fixture.test/networks/robinhood/trending_pools?page=1'
    ]);
    expect(leads[0]).toMatchObject({ address: '0x1111111111111111111111111111111111111111', poolAddress: '0x2222222222222222222222222222222222222222', liquidityUsd: '25000', volume24hUsd: '5000', buys24h: 12, sells24h: 8 });
    expect(leads[0]?.snapshot.source).toBe('geckoterminal');
  });

  it('imports immutable hourly OHLCV candles for retained swing analysis', async () => {
    const fetcher = vi.fn(() => response({ data: { attributes: { ohlcv_list: [[1793070000, 1, 1.2, 0.9, 1.1, 1234]] } }, meta: { base: { address: '0x1111111111111111111111111111111111111111' }, quote: { address: '0x3333333333333333333333333333333333333333' } } })) as unknown as typeof fetch;
    const candles = await new GeckoTerminalAdapter('https://fixture.test', options, fetcher).hourlyHistory('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 168);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ priceUsd: '1.1', volume1hUsd: '1234', source: 'geckoterminal_1h_candle' });
  });

  it('rejects an EOA using eth_getCode', async () => {
    const fetcher = vi.fn(() => response({ jsonrpc: '2.0', id: 1, result: '0x' })) as unknown as typeof fetch;
    const rpc = new JsonRpcAdapter('https://fixture.test', options, fetcher);
    expect(await rpc.validateContract('0x1111111111111111111111111111111111111111')).toBe(false);
  });

  it('marks an absent quote adapter not configured, never unsafe', async () => {
    const quote = new SushiQuoteAdapter('', options);
    const result = await quote.roundTrip('0x1111111111111111111111111111111111111111', '1000');
    expect(result.state).toBe('not_configured');
    expect(result.hardFail).toBe(false);
  });

  it('surfaces an upstream outage as degraded source health', async () => {
    const fetcher = vi.fn(() => response({ error: 'outage' }, 503)) as unknown as typeof fetch;
    const client = new ResilientHttpClient('fixture', options, fetcher);
    await expect(client.json('https://fixture.test/outage')).rejects.toThrow('HTTP 503');
    expect(client.status().state).toBe('degraded');
    expect(client.status().failures).toBe(1);
  });
});
