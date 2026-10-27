export const SCHEMA_VERSION = '1.0.0';
export const SWING_ALGORITHM_VERSION = '1.0.0';
export const SCORE_ALGORITHM_VERSION = '1.0.0';
export const RISK_SCAN_VERSION = '1.0.0';
export const RECOMMENDATION_VERSION = '1.0.0';

export type ChainId = number;
export type Address = `0x${string}`;

export type CandidateState =
  | 'discovered' | 'queued' | 'collecting_history' | 'assessed'
  | 'watched' | 'stale' | 'rejected' | 'archived';
export type Verdict = 'PASS' | 'CAUTION' | 'REJECT' | 'UNASSESSED';
export type AssetType = 'crypto' | 'tokenized_stock' | 'stablecoin';
export type RouteState =
  | 'not_attempted' | 'not_configured' | 'available'
  | 'no_route_or_liquidity' | 'quote_failed' | 'timed_out' | 'stale';
export type TriState = 'detected' | 'not_detected' | 'unknown';
export type SourceHealthState = 'healthy' | 'degraded' | 'open_circuit' | 'not_configured';

export interface PairIdentity {
  address: Address;
  dex: string;
  url?: string;
  quoteTokenAddress?: Address;
  createdAt?: string;
  liquidityUsd?: string;
  canonical: boolean;
}

export interface MarketSnapshot {
  id: number;
  chainId: ChainId;
  tokenAddress: Address;
  pairAddress: Address | null;
  dex: string | null;
  priceNative: string | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
  fdvUsd: string | null;
  marketCapUsd: string | null;
  volume5mUsd: string | null;
  volume1hUsd: string | null;
  volume6hUsd: string | null;
  volume24hUsd: string | null;
  buys24h: number | null;
  sells24h: number | null;
  pairCreatedAt: string | null;
  sourceTime: string | null;
  ingestedAt: string;
  source: string;
  fingerprint: string;
}

export interface Candidate {
  chainId: ChainId;
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: string | null;
  assetType: AssetType;
  state: CandidateState;
  canonicalPair: Address | null;
  discoveredAt: string;
  updatedAt: string;
  watched: boolean;
  score: number | null;
  verdict: Verdict;
  confidence: number;
  scoreVersion: string | null;
  flags: RiskFlag[];
  latestSnapshot?: MarketSnapshot | null;
  swingScore?: number | null;
  routeState?: RouteState;
  routeRecoveryPct?: number | null;
  assessmentError?: { code: string; message: string; at: string } | null;
}

export interface HistoryQuality {
  sampleCount: number;
  coveragePct: number;
  largestGapSeconds: number | null;
  expectedPollSeconds: number;
  sourceCount: number;
  earliestAt: string | null;
  latestAt: string | null;
}

export interface SwingEvent {
  id: string;
  threshold: number;
  direction: 'up' | 'down';
  startSnapshotId: number;
  endSnapshotId: number;
  startAt: string;
  endAt: string;
  startPrice: string;
  endPrice: string;
  durationSeconds: number;
  amplitude: number;
  adverseExcursion: number;
  roundTripId: string | null;
}

export interface Distribution {
  min: number | null;
  p25: number | null;
  median: number | null;
  mean: number | null;
  p75: number | null;
  max: number | null;
}

export interface SwingThresholdResult {
  threshold: number;
  horizon: string;
  upCrossings: number;
  downCrossings: number;
  completedRoundTrips: number;
  eventsPerDay: number;
  timeSinceLastEventSeconds: number | null;
  durationSeconds: Distribution;
  eventTraversalDurationSeconds: Distribution;
  amplitude: Distribution;
  maximumDrawdown: number;
  volatility: number;
  drift: number;
  rangeChange: number | null;
  timeInsideDominantRangePct: number;
  suitability: number;
  quality: HistoryQuality;
  events: SwingEvent[];
}

export interface SwingStudy {
  algorithmVersion: string;
  generatedAt: string;
  parameters: SwingParameters;
  results: SwingThresholdResult[];
}

export interface SwingParameters {
  thresholds: number[];
  horizonsSeconds: Record<string, number>;
  expectedPollSeconds: number;
  maxGapMultiplier: number;
  minimumEventSeparationSeconds: number;
  confirmationSamples: number;
}

export interface RiskEvidence {
  source: string;
  observedAt: string;
  detail: string;
  reference?: string;
}

export interface RiskFlag {
  code: string;
  label: string;
  state: TriState;
  severity: 'info' | 'warning' | 'hard_fail';
  confidence: number;
  explanation: string;
  evidence: RiskEvidence[];
}

export interface ContractScan {
  version: string;
  chainId: ChainId;
  address: Address;
  scannedAt: string;
  codeHash: string | null;
  codeSize: number | null;
  isContract: TriState;
  metadata: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null };
  flags: RiskFlag[];
}

export interface RouteQuote {
  provider: string;
  quotedAt: string;
  state: RouteState;
  tokenIn: Address | 'native';
  tokenOut: Address | 'native';
  amountIn: string;
  amountOut: string | null;
  priceImpactPct: number | null;
  gasEstimate: string | null;
  errorCode: string | null;
}

export interface RouteAssessment {
  plannedPrincipalWei: string;
  buy: RouteQuote | null;
  sell: RouteQuote | null;
  recoveryPct: number | null;
  state: RouteState;
  hardFail: boolean;
  explanation: string;
}

export interface ScoreInput {
  latest: MarketSnapshot | null;
  swings: SwingStudy | null;
  route: RouteAssessment | null;
  risks: RiskFlag[];
  now?: string;
  plannedPrincipalUsd?: string | null;
}

export interface ScoreComponent {
  key: 'liquidity' | 'route' | 'swing' | 'activity' | 'stability' | 'contract';
  weight: number;
  points: number;
  raw: Record<string, string | number | boolean | null>;
  source: string;
  observedAt: string | null;
  explanation: string;
}

export interface ScoreResult {
  version: string;
  score: number;
  confidence: number;
  verdict: Verdict;
  hardFails: string[];
  materialUnknowns: string[];
  components: ScoreComponent[];
  calculatedAt: string;
}

export interface RecommendationDraft {
  schemaVersion: string;
  scoutVersion: string;
  recommendationVersion: string;
  chainId: ChainId;
  tokenAddress: Address;
  pairAddress: Address | null;
  generatedAt: string;
  latestSourceTime: string | null;
  operatorReviewRequired: true;
  configurationOnly: true;
  engine: 'gridless';
  allocationMode: 'threshold' | 'drawdown_ladder' | 'survivor';
  values: Record<string, string | number | boolean>;
  rationale: string[];
  warnings: string[];
  unknowns: string[];
}

export interface SourceStatus {
  source: string;
  state: SourceHealthState;
  checkedAt: string;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  failures: number;
  circuitOpenUntil: string | null;
  message: string | null;
}
