import { ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

export class CoinGeckoAdapter {
  private readonly client: ResilientHttpClient;
  constructor(private readonly baseUrl: string, options: ResilienceOptions, fetchImpl?: FetchLike) { this.client = new ResilientHttpClient('coingecko', { ...options, requestsPerMinute: Math.min(options.requestsPerMinute, 20), cacheTtlMs: Math.max(options.cacheTtlMs, 300_000) }, fetchImpl); }
  status() { return this.client.status(); }
  async ethUsd(): Promise<string | null> { const result = await this.client.json<any>(`${this.baseUrl}/simple/price?ids=ethereum&vs_currencies=usd`); const value = result?.ethereum?.usd; return typeof value === 'number' && Number.isFinite(value) ? String(value) : null; }
}
