import type { Address } from '@doomscout/domain';
import { ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

export class BlockscoutAdapter {
  private readonly client: ResilientHttpClient;
  constructor(private readonly baseUrl: string, options: ResilienceOptions, fetchImpl?: FetchLike) { this.client = new ResilientHttpClient('blockscout', { ...options, requestsPerMinute: Math.min(options.requestsPerMinute, 50), cacheTtlMs: Math.max(options.cacheTtlMs, 300_000) }, fetchImpl); }
  status() { return this.client.status(); }
  async token(address: Address): Promise<{ verified: boolean | null; type: string | null; holders: string | null }> {
    try { const result = await this.client.json<any>(`${this.baseUrl}/api/v2/tokens/${address}`); return { verified: typeof result.is_verified_via_admin_panel === 'boolean' ? result.is_verified_via_admin_panel : null, type: result.type ?? null, holders: result.holders_count === undefined ? null : String(result.holders_count) }; } catch { return { verified: null, type: null, holders: null }; }
  }
}
