import { Decimal } from 'decimal.js';
import { BlockscoutAdapter, CoinGeckoAdapter, DexScreenerAdapter, GeckoTerminalAdapter, JsonRpcAdapter, SushiQuoteAdapter, type GeckoDiscoveryLead, type ResilienceOptions } from '@doomscout/adapters';
import type { AppConfig } from '@doomscout/config';
import type { Repositories } from '@doomscout/database';
import { calculateSwingStudy, normalizeAddress, scoreCandidate, type Address, type RouteAssessment } from '@doomscout/domain';

export class AssessmentService {
  readonly dex: DexScreenerAdapter;
  readonly geckoTerminal: GeckoTerminalAdapter;
  readonly rpc: JsonRpcAdapter;
  readonly blockscout: BlockscoutAdapter;
  readonly coinGecko: CoinGeckoAdapter;
  readonly sushi: SushiQuoteAdapter;

  constructor(private readonly config: AppConfig, private readonly repositories: Repositories) {
    const resilience: ResilienceOptions = { timeoutMs: config.ADAPTER_TIMEOUT_MS, retries: config.ADAPTER_RETRIES, cacheTtlMs: config.ADAPTER_CACHE_SECONDS * 1000, requestsPerMinute: 60 };
    this.dex = new DexScreenerAdapter(config.DEXSCREENER_API_URL, resilience);
    this.geckoTerminal = new GeckoTerminalAdapter(config.GECKOTERMINAL_API_URL, resilience);
    this.rpc = new JsonRpcAdapter(config.ROBINHOOD_RPC_URL, resilience);
    this.blockscout = new BlockscoutAdapter(config.ROBINHOOD_BLOCKSCOUT_URL, resilience);
    this.coinGecko = new CoinGeckoAdapter(config.COINGECKO_API_URL, resilience);
    this.sushi = new SushiQuoteAdapter(config.SUSHI_QUOTE_URL, resilience);
  }

  async persistStatuses(): Promise<void> {
    const statuses = [...this.dex.statuses(), this.geckoTerminal.status(), this.rpc.status(), this.blockscout.status(), this.coinGecko.status(), this.sushi.status()];
    await Promise.all(statuses.map((status) => this.repositories.setSourceStatus(status)));
  }

  async discover(): Promise<number> {
    try {
      const [geckoResult, profileResult] = await Promise.allSettled([
        this.geckoTerminal.discover(this.config.DISCOVERY_TOP_PAGES, this.config.DISCOVERY_NEW_PAGES),
        this.dex.discover()
      ]);
      const geckoLeads = geckoResult.status === 'fulfilled' ? geckoResult.value : [];
      const profileLeads = profileResult.status === 'fulfilled' ? profileResult.value : [];
      if (geckoResult.status === 'rejected') await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: null, source: 'geckoterminal', sourceId: null, sourceTime: null, outcome: 'provider_error', errorCode: geckoResult.reason instanceof Error ? geckoResult.reason.name : 'UNKNOWN' });
      if (profileResult.status === 'rejected') await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: null, source: 'dexscreener_profiles', sourceId: null, sourceTime: null, outcome: 'provider_error', errorCode: profileResult.reason instanceof Error ? profileResult.reason.name : 'UNKNOWN' });

      // One candidate can appear in several pools/feeds. Prefer its deepest
      // indexed pool as the initial evidence and let assessment retain all
      // later pair observations.
      const preferred = new Map<string, GeckoDiscoveryLead>();
      for (const lead of geckoLeads) {
        const current = preferred.get(lead.address);
        if (!current || Number(lead.liquidityUsd ?? -1) > Number(current.liquidityUsd ?? -1)) preferred.set(lead.address, lead);
      }
      let accepted = 0;
      for (const lead of preferred.values()) {
        const liquidity = Number(lead.liquidityUsd ?? 0);
        const volume = Number(lead.volume24hUsd ?? 0);
        const transactions = lead.buys24h + lead.sells24h;
        const eligible = liquidity >= this.config.DISCOVERY_MIN_LIQUIDITY_USD
          && volume >= this.config.DISCOVERY_MIN_VOLUME_24H_USD
          && transactions >= this.config.DISCOVERY_MIN_TRANSACTIONS_24H;
        await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: lead.address, source: 'geckoterminal_pool_index', sourceId: lead.sourceId, sourceTime: lead.createdAt, outcome: eligible ? 'accepted' : 'below_intake_threshold' });
        if (!eligible) continue;
        await this.repositories.upsertCandidate({ chainId: this.config.CHAIN_ID, address: lead.address });
        await this.repositories.upsertPair({ chainId: this.config.CHAIN_ID, tokenAddress: lead.address, pairAddress: lead.poolAddress, dex: lead.dex, url: null, quoteTokenAddress: lead.quoteTokenAddress, createdAt: lead.createdAt, liquidityUsd: lead.liquidityUsd });
        await this.repositories.insertSnapshot(lead.snapshot, lead.raw);
        await this.repositories.enqueue('assess', `${this.config.CHAIN_ID}:${lead.address}:${new Date().toISOString().slice(0, 13)}`, { chainId: this.config.CHAIN_ID, address: lead.address });
        accepted += 1;
      }
      // Keep DexScreener profiles as a secondary early-warning feed. They are
      // queued for validation but do not bypass the market-activity criteria
      // for the ranked universe unless GeckoTerminal also observes a pool.
      const acceptedAddresses = new Set([...preferred.values()].map((lead) => lead.address));
      for (const lead of profileLeads.filter((item) => !acceptedAddresses.has(item.address))) {
        await this.repositories.recordDiscovery({ chainId: this.config.CHAIN_ID, tokenAddress: lead.address, source: 'dexscreener_profiles', sourceId: lead.sourceId, sourceTime: lead.sourceTime, outcome: 'lead_only' });
      }
      return accepted;
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

      const canonicalPair = canonical?.pairAddress ?? persistedCandidate?.canonicalPair ?? null;
      if (canonicalPair && !(await this.repositories.hasSnapshotSource(chainId, address, 'geckoterminal_1h_candle'))) {
        const backfill = await this.geckoTerminal.hourlyHistory(address, canonicalPair, this.config.HISTORY_BACKFILL_HOURS).catch(() => []);
        for (const snapshot of backfill) await this.repositories.insertSnapshot(snapshot, { provider: 'geckoterminal', kind: 'hourly_ohlcv' });
      }

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
