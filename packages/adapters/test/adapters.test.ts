import { describe, expect, it, vi } from 'vitest';
import { DexScreenerAdapter, JsonRpcAdapter, ResilientHttpClient, SushiQuoteAdapter } from '../src/index.js';

const options = { timeoutMs: 1000, retries: 0, cacheTtlMs: 1, requestsPerMinute: 100_000 };
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('adapter fixtures', () => {
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
