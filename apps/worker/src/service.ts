import { Decimal } from 'decimal.js';
import { BlockscoutAdapter, CoinGeckoAdapter, DexScreenerAdapter, JsonRpcAdapter, SushiQuoteAdapter, type ResilienceOptions } from '@doomscout/adapters';
import type { AppConfig } from '@doomscout/config';
import type { Repositories } from '@doomscout/database';
import { calculateSwingStudy, normalizeAddress, scoreCandidate, type Address, type RouteAssessment } from '@doomscout/domain';

export class AssessmentService {
  readonly dex: DexScreenerAdapter;
  readonly rpc: JsonRpcAdapter;
  readonly blockscout: BlockscoutAdapter;
  readonly coinGecko: CoinGeckoAdapter;
  readonly sushi: SushiQuoteAdapter;

  constructor(private readonly config: AppConfig, private readonly repositories: Repositories) {
    const resilience: ResilienceOptions = { timeoutMs: config.ADAPTER_TIMEOUT_MS, retries: config.ADAPTER_RETRIES, cacheTtlMs: config.ADAPTER_CACHE_SECONDS * 1000, requestsPerMinute: 60 };
    this.dex = new DexScreenerAdapter(config.DEXSCREENER_API_URL, resilience);
    this.rpc = new JsonRpcAdapter(config.ROBINHOOD_RPC_URL, resilience);
    this.blockscout = new BlockscoutAdapter(config.ROBINHOOD_BLOCKSCOUT_URL, resilience);
    this.coinGecko = new CoinGeckoAdapter(config.COINGECKO_API_URL, resilience);
    this.sushi = new SushiQuoteAdapter(config.SUSHI_QUOTE_URL, resilience);
  }

  async persistStatuses(): Promise<void> {
    const statuses = [...this.dex.statuses(), this.rpc.status(), this.blockscout.status(), this.coinGecko.status(), this.sushi.status()];
    await Promise.all(statuses.map((status) => this.repositories.setSourceStatus(status)));
  }

  async discover(): Promise<number> {
    try {
      const leads = await this.dex.discover();
      for (const lead of leads) {
        await this.repositories.upsertCandidate({ chainId: this.config.CHAIN_ID, address: lead.address });
        await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: lead.address, source: 'dexscreener_profiles', sourceId: lead.sourceId, sourceTime: lead.sourceTime, outcome: 'accepted' });
        await this.repositories.enqueue('assess', `${this.config.CHAIN_ID}:${lead.address}:${new Date().toISOString().slice(0, 13)}`, { chainId: this.config.CHAIN_ID, address: lead.address });
      }
      return leads.length;
    } catch (error) {
      await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: null, source: 'dexscreener_profiles', sourceId: null, sourceTime: null, outcome: 'provider_error', errorCode: error instanceof Error ? error.name : 'UNKNOWN' });
      throw error;
    } finally { await this.persistStatuses(); }
  }

  async assess(chainId: number, rawAddress: string): Promise<void> {
    if (chainId !== this.config.CHAIN_ID) throw new Error(`Chain ${chainId} is not enabled`);
    const address = normalizeAddress(rawAddress);
    await this.repositories.upsertCandidate({ chainId, address, state: 'queued' });
    await this.repositories.setCandidateState(chainId, address, 'collecting_history');
    try {
      const isContract = await this.rpc.validateContract(address);
      if (!isContract) {
        const scan = await this.rpc.scanContract(chainId, address);
        await this.repositories.saveContractScan(scan);
        await this.repositories.setCandidateState(chainId, address, 'rejected');
        return;
      }

      const [market, scan, explorer] = await Promise.all([this.dex.token(chainId, address), this.rpc.scanContract(chainId, address), this.blockscout.token(address)]);
      scan.flags.push({ code: 'source_verification', label: 'Explorer source verification', state: explorer.verified === true ? 'not_detected' : 'unknown', severity: 'info', confidence: explorer.verified === true ? 90 : 0, explanation: explorer.verified === true ? 'Blockscout reported verification context. Verification does not make a contract safe.' : 'Verification was absent or unavailable; this is uncertainty, not evidence of danger or safety.', evidence: [{ source: 'blockscout', observedAt: scan.scannedAt, detail: explorer.verified === true ? 'verification reported' : 'verification not established' }] });
      await this.repositories.setCandidateMetadata(chainId, address, { symbol: market.token.symbol ?? scan.metadata.symbol, name: market.token.name ?? scan.metadata.name, decimals: scan.metadata.decimals, totalSupply: scan.metadata.totalSupply });
      await this.repositories.saveContractScan(scan);

      for (const pair of market.pairs) await this.repositories.upsertPair({ chainId, tokenAddress: address, pairAddress: pair.pairAddress, dex: pair.dex, url: pair.url, quoteTokenAddress: pair.quoteTokenAddress, createdAt: pair.createdAt, liquidityUsd: pair.liquidityUsd });
      const persistedCandidate = await this.repositories.getCandidate(chainId, address);
      const canonical = selectCanonicalMarketPair(market.pairs, persistedCandidate?.canonicalPair ?? null);
      if (canonical) await this.repositories.insertSnapshot(canonical.snapshot, canonical.raw);

      const history = await this.repositories.analyticsHistory(chainId, address, this.config.RAW_RETENTION_DAYS, this.config.CANDLE_RETENTION_DAYS, this.config.HOURLY_RETENTION_DAYS);
      const study = calculateSwingStudy(history, { thresholds: this.config.SWING_THRESHOLDS, expectedPollSeconds: this.config.EXPECTED_POLL_SECONDS, minimumEventSeparationSeconds: this.config.SWING_MIN_SEPARATION_SECONDS, confirmationSamples: this.config.SWING_CONFIRMATION_SAMPLES });
      await this.repositories.saveSwingStudy(chainId, address, study);

      const principal = (BigInt(this.config.PLANNED_BUDGET_WEI) / BigInt(this.config.POSITION_COUNT)).toString();
      const route: RouteAssessment = await this.sushi.roundTrip(address, principal);
      await this.repositories.saveRouteAssessment(chainId, address, route);
      const [latest, ethUsd] = await Promise.all([this.repositories.latestSnapshot(chainId, address), this.coinGecko.ethUsd().catch(() => null)]);
      const plannedUsd = ethUsd ? new Decimal(principal).div('1e18').mul(ethUsd).toString() : null;
      const previousScore = await this.repositories.latestScore(chainId, address);
      const score = scoreCandidate({ latest, swings: study, route, risks: scan.flags, plannedPrincipalUsd: plannedUsd });
      await this.repositories.saveScore(chainId, address, score);
      if (previousScore && previousScore.verdict !== score.verdict) await this.repositories.createAlert({ chainId, address, kind: 'verdict_change', severity: score.verdict === 'REJECT' ? 'critical' : 'warning', message: `Verdict changed from ${previousScore.verdict} to ${score.verdict}.`, evidence: { previous: previousScore, current: score } });
      const newHardFails = score.hardFails.filter((failure) => !previousScore?.hardFails.includes(failure));
      if (newHardFails.length) await this.repositories.createAlert({ chainId, address, kind: 'new_hard_fail', severity: 'critical', message: `New hard-fail evidence: ${newHardFails.join(', ')}`, evidence: { hardFails: newHardFails, scoreVersion: score.version } });
    } catch (error) {
      const code = error instanceof Error ? error.name || 'ASSESSMENT_FAILED' : 'ASSESSMENT_FAILED';
      const message = error instanceof Error ? error.message : 'Unknown assessment failure';
      await this.repositories.recordAssessmentFailure(chainId, address, code, message);
      throw error;
    } finally { await this.persistStatuses(); }
  }
}

export function selectCanonicalMarketPair<T extends { pairAddress: Address; liquidityUsd: string | null }>(pairs: T[], canonicalAddress: Address | null): T | undefined {
  if (canonicalAddress) {
    const overridden = pairs.find((pair) => pair.pairAddress.toLowerCase() === canonicalAddress.toLowerCase());
    if (overridden) return overridden;
  }
  return [...pairs].filter((pair) => pair.liquidityUsd !== null).sort((a, b) => new Decimal(b.liquidityUsd!).comparedTo(a.liquidityUsd!))[0] ?? pairs[0];
}
