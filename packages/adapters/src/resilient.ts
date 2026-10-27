import type { SourceStatus } from '@doomscout/domain';

export interface ResilienceOptions {
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  requestsPerMinute: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
}
export type FetchLike = typeof fetch;

interface CacheEntry { value: unknown; expiresAt: number; staleUntil: number }

export class AdapterError extends Error {
  constructor(readonly code: 'TIMEOUT' | 'HTTP' | 'INVALID_RESPONSE' | 'CIRCUIT_OPEN' | 'NOT_CONFIGURED', message: string, readonly status?: number) { super(message); }
}

export class ResilientHttpClient {
  private readonly cache = new Map<string, CacheEntry>();
  private failures = 0;
  private circuitOpenUntil = 0;
  private nextRequestAt = 0;
  private lastSuccessAt: string | null = null;
  private latencyMs: number | null = null;
  private message: string | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly source: string, private readonly options: ResilienceOptions, private readonly fetchImpl: FetchLike = fetch) {}

  status(): SourceStatus {
    const now = new Date().toISOString();
    return { source: this.source, state: Date.now() < this.circuitOpenUntil ? 'open_circuit' : this.failures > 0 ? 'degraded' : 'healthy', checkedAt: now, lastSuccessAt: this.lastSuccessAt, latencyMs: this.latencyMs, failures: this.failures, circuitOpenUntil: this.circuitOpenUntil > Date.now() ? new Date(this.circuitOpenUntil).toISOString() : null, message: this.message };
  }

  private async rateLimit(): Promise<void> {
    const spacing = Math.ceil(60_000 / Math.max(1, this.options.requestsPerMinute));
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + spacing;
    release();
  }

  async json<T>(url: string, init: RequestInit = {}, cacheKey = `${init.method ?? 'GET'}:${url}`): Promise<T> {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    if (cached && cached.staleUntil > Date.now()) {
      // Serve bounded stale evidence immediately while one background request
      // refreshes it. If refresh fails, preserve the stale item until its hard
      // expiry and let source health expose the degradation.
      this.cache.delete(cacheKey);
      void this.json<T>(url, init, cacheKey).catch(() => this.cache.set(cacheKey, cached));
      return cached.value as T;
    }
    if (Date.now() < this.circuitOpenUntil) throw new AdapterError('CIRCUIT_OPEN', `${this.source} circuit is temporarily open`);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      await this.rateLimit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const start = Date.now();
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'DoomScout/0.1 (read-only research)', ...init.headers } });
        this.latencyMs = Date.now() - start;
        if (!response.ok) throw new AdapterError('HTTP', `${this.source} returned HTTP ${response.status}`, response.status);
        const value = await response.json() as T;
        this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.options.cacheTtlMs, staleUntil: Date.now() + this.options.cacheTtlMs * 10 });
        this.failures = 0;
        this.lastSuccessAt = new Date().toISOString();
        this.message = null;
        return value;
      } catch (error) {
        lastError = error;
        this.failures += 1;
        this.message = error instanceof Error ? error.message.slice(0, 200) : 'Unknown adapter error';
        if (this.failures >= (this.options.circuitFailureThreshold ?? 5)) this.circuitOpenUntil = Date.now() + (this.options.circuitCooldownMs ?? 60_000);
        if (attempt < this.options.retries) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 200 * 2 ** attempt + Math.random() * 100)));
      } finally { clearTimeout(timer); }
    }
    if (lastError instanceof AdapterError) throw lastError;
    if (lastError instanceof Error && lastError.name === 'AbortError') throw new AdapterError('TIMEOUT', `${this.source} timed out`);
    throw new AdapterError('INVALID_RESPONSE', this.message ?? `${this.source} request failed`);
  }
}
