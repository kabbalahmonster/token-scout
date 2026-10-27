import { Decimal } from 'decimal.js';
import type { Address, RouteAssessment, RouteQuote, RouteState } from '@doomscout/domain';
import { AdapterError, ResilientHttpClient, type FetchLike, type ResilienceOptions } from './resilient.js';

const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export class SushiQuoteAdapter {
  private readonly client: ResilientHttpClient | null;
  constructor(private readonly endpoint: string, options: ResilienceOptions, fetchImpl?: FetchLike) { this.client = endpoint ? new ResilientHttpClient('sushi_quote', { ...options, requestsPerMinute: Math.min(options.requestsPerMinute, 30), cacheTtlMs: Math.max(options.cacheTtlMs, 15_000) }, fetchImpl) : null; }
  status() { return this.client?.status() ?? { source: 'sushi_quote', state: 'not_configured' as const, checkedAt: new Date().toISOString(), lastSuccessAt: null, latencyMs: null, failures: 0, circuitOpenUntil: null, message: 'SUSHI_QUOTE_URL is not configured' }; }

  private async quote(tokenIn: Address | 'native', tokenOut: Address | 'native', amount: string): Promise<RouteQuote> {
    if (!this.client) return { provider: 'sushi', quotedAt: new Date().toISOString(), state: 'not_configured', tokenIn, tokenOut, amountIn: amount, amountOut: null, priceImpactPct: null, gasEstimate: null, errorCode: 'NOT_CONFIGURED' };
    const input = tokenIn === 'native' ? NATIVE_SENTINEL : tokenIn;
    const output = tokenOut === 'native' ? NATIVE_SENTINEL : tokenOut;
    const url = new URL(this.endpoint);
    url.searchParams.set('tokenIn', input);
    url.searchParams.set('tokenOut', output);
    url.searchParams.set('amount', amount);
    url.searchParams.set('maxSlippage', '0.01');
    try {
      const result = await this.client.json<any>(url.toString());
      const amountOut = result?.amountOut ?? result?.route?.amountOut ?? result?.assumedAmountOut;
      const state: RouteState = amountOut ? 'available' : 'no_route_or_liquidity';
      return { provider: 'sushi', quotedAt: new Date().toISOString(), state, tokenIn, tokenOut, amountIn: amount, amountOut: amountOut ? String(amountOut) : null, priceImpactPct: typeof result?.priceImpact === 'number' ? result.priceImpact : null, gasEstimate: result?.gasSpent === undefined && result?.gasEstimate === undefined ? null : String(result.gasSpent ?? result.gasEstimate), errorCode: amountOut ? null : 'NO_ROUTE' };
    } catch (error) {
      const state: RouteState = error instanceof AdapterError && error.code === 'TIMEOUT' ? 'timed_out' : error instanceof AdapterError && error.status === 404 ? 'no_route_or_liquidity' : 'quote_failed';
      return { provider: 'sushi', quotedAt: new Date().toISOString(), state, tokenIn, tokenOut, amountIn: amount, amountOut: null, priceImpactPct: null, gasEstimate: null, errorCode: error instanceof AdapterError ? error.code : 'QUOTE_FAILED' };
    }
  }

  async roundTrip(token: Address, principalWei: string): Promise<RouteAssessment> {
    if (!this.client) return { plannedPrincipalWei: principalWei, buy: null, sell: null, recoveryPct: null, state: 'not_configured', hardFail: false, explanation: 'Sushi quote endpoint is not configured; route safety is unknown.' };
    const buy = await this.quote('native', token, principalWei);
    if (buy.state !== 'available' || buy.amountOut === null) return { plannedPrincipalWei: principalWei, buy, sell: null, recoveryPct: null, state: buy.state, hardFail: false, explanation: 'No usable buy quote was returned. This is not proof the token is unsafe.' };
    const sell = await this.quote(token, 'native', buy.amountOut);
    if (sell.state !== 'available' || sell.amountOut === null) return { plannedPrincipalWei: principalWei, buy, sell, recoveryPct: null, state: sell.state, hardFail: sell.state === 'no_route_or_liquidity', explanation: 'A buy quote existed but the same quoted quantity did not receive a sell route. Operator review is required.' };
    const recoveryPct = new Decimal(sell.amountOut).div(principalWei).mul(100).toNumber();
    return { plannedPrincipalWei: principalWei, buy, sell, recoveryPct, state: 'available', hardFail: recoveryPct < 50, explanation: `Read-only planned-size round-trip quote recovered ${recoveryPct.toFixed(2)}% before future gas and execution changes.` };
  }
}
