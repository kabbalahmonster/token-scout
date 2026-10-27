import { Decimal } from 'decimal.js';
import { RECOMMENDATION_VERSION, SCHEMA_VERSION, type Address, type MarketSnapshot, type RecommendationDraft, type ScoreResult, type SwingStudy } from './types.js';

interface RecommendationInput {
  chainId: number;
  tokenAddress: Address;
  pairAddress: Address | null;
  latest: MarketSnapshot | null;
  swings: SwingStudy | null;
  score: ScoreResult;
  plannedBudgetWei: string;
  positionCount: number;
  allocationMode?: 'threshold' | 'drawdown_ladder' | 'survivor';
}

export function generateRecommendation(input: RecommendationInput): RecommendationDraft {
  const candidates = input.swings?.results
    .filter((result) => result.horizon === '7d' && result.completedRoundTrips >= 2 && result.quality.coveragePct >= 50)
    .sort((a, b) => b.suitability - a.suitability) ?? [];
  const selected = candidates[0];
  const threshold = selected ? Math.max(0.02, selected.threshold) : 0.05;
  const maxDrawdown = selected?.maximumDrawdown ?? 0.2;
  const thresholdPercent = threshold * 100;
  const terminalDrawdownPercent = Math.min(95, Math.max(maxDrawdown * 120, thresholdPercent * 3));
  const minimumPositionEth = new Decimal(input.plannedBudgetWei).div(input.positionCount).div('1e18').toDecimalPlaces(18).toString();
  const warnings = [
    'Operator review is required. This file is configuration data, never a trade command.',
    'The referenced bot has a known caveat: ordinary losing gridless stop-loss exits may be blocked by an earlier profit precheck. Do not treat stop-loss as a safety guarantee.',
    'Quotes and route conditions can change before execution; retain all bot execution guards.'
  ];
  if (!selected) warnings.push('History was insufficient for a data-supported threshold; conservative defaults are shown for review only.');
  if (input.score.verdict === 'REJECT') warnings.push('Current assessment is REJECT. Export is provided for audit/review, not endorsement.');
  return {
    schemaVersion: SCHEMA_VERSION,
    scoutVersion: '0.1.0',
    recommendationVersion: RECOMMENDATION_VERSION,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    pairAddress: input.pairAddress,
    generatedAt: new Date().toISOString(),
    latestSourceTime: input.latest?.sourceTime ?? input.latest?.ingestedAt ?? null,
    operatorReviewRequired: true,
    configurationOnly: true,
    engine: 'gridless',
    allocationMode: input.allocationMode ?? 'drawdown_ladder',
    values: {
      TOKEN_ADDRESS: input.tokenAddress,
      USE_GRIDLESS: true,
      GRIDLESS_ALLOCATION_MODE: input.allocationMode ?? 'drawdown_ladder',
      GRIDLESS_BUY_THRESHOLD: (-thresholdPercent).toFixed(2),
      GRIDLESS_SELL_THRESHOLD: thresholdPercent.toFixed(2),
      MIN_PROFIT_PERCENT: thresholdPercent.toFixed(2),
      GRIDLESS_LADDER_TERMINAL_DRAWDOWN_PERCENT: terminalDrawdownPercent.toFixed(2),
      GRIDLESS_LADDER_SPACING: terminalDrawdownPercent >= 50 ? 'log' : 'linear',
      MAX_ACTIVE_POSITIONS: input.positionCount,
      GRIDLESS_MIN_POSITION_ETH: minimumPositionEth,
      GRIDLESS_BUY_COOLDOWN_SECONDS: 60,
      GRIDLESS_BUY_EXECUTION_MARGIN: 50,
      POLL_INTERVAL_SECONDS: 15,
      POLL_CADENCE_MODE: 'fixed_rate',
      PNL_POLLING_MODE: 'bidirectional',
      PNL_LEGACY_TRIGGERS: false,
      GRIDLESS_STOPLOSS_ENABLED: false,
      GRIDLESS_MULTI_ACTION_ROUNDS: false
    },
    rationale: [
      selected ? `Selected ${(threshold * 100).toFixed(0)}% spacing from ${selected.completedRoundTrips} observed 7-day round trips with ${selected.quality.coveragePct.toFixed(0)}% coverage.` : 'Used a review-only fallback because no 7-day threshold met history requirements.',
      `Assessment score ${input.score.score}/100, ${input.score.verdict}, confidence ${input.score.confidence}/100.`
    ],
    warnings,
    unknowns: ['wallet balance', 'future gas cost', 'future liquidity', 'mutable transfer tax', 'route at execution', ...input.score.materialUnknowns]
  };
}

export function recommendationToEnv(draft: RecommendationDraft): string {
  const header = [
    `# DoomScout schema=${draft.schemaVersion} recommendation=${draft.recommendationVersion}`,
    `# generated_at=${draft.generatedAt}`,
    '# OPERATOR_REVIEW_REQUIRED=true',
    '# WARNING: configuration only; never a trade command.'
  ];
  return [...header, ...Object.entries(draft.values).map(([key, value]) => `${key}=${String(value)}`)].join('\n') + '\n';
}
