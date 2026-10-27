import { Decimal } from 'decimal.js';
import { SCORE_ALGORITHM_VERSION, type RiskFlag, type ScoreComponent, type ScoreInput, type ScoreResult } from './types.js';
import { clamp } from './statistics.js';

const WEIGHTS = { liquidity: 25, route: 20, swing: 20, activity: 15, stability: 10, contract: 10 } as const;

function decimal(value: string | null | undefined): Decimal | null {
  try { return value === null || value === undefined ? null : new Decimal(value); } catch { return null; }
}

function contractPoints(flags: RiskFlag[]): number {
  const detected = flags.filter((flag) => flag.state === 'detected');
  const unknown = flags.filter((flag) => flag.state === 'unknown');
  const deduction = detected.reduce((sum, flag) => sum + (flag.severity === 'hard_fail' ? 10 : flag.severity === 'warning' ? 3 : 1), 0);
  return clamp(WEIGHTS.contract - deduction - Math.min(3, unknown.length * 0.5), 0, WEIGHTS.contract);
}

export function scoreCandidate(input: ScoreInput): ScoreResult {
  const now = input.now ?? new Date().toISOString();
  const latest = input.latest;
  const materialUnknowns: string[] = [];
  const hardFails = input.risks.filter((flag) => flag.state === 'detected' && flag.severity === 'hard_fail').map((flag) => flag.code);
  const components: ScoreComponent[] = [];

  const liquidity = decimal(latest?.liquidityUsd);
  const planned = decimal(input.plannedPrincipalUsd);
  let liquidityPoints = 0;
  if (!liquidity) materialUnknowns.push('liquidity_unknown');
  else {
    const baseline = clamp((Math.log10(Math.max(1, liquidity.toNumber())) - 3) / 3 * 100);
    const impactPenalty = planned && liquidity.gt(0) ? clamp(planned.div(liquidity).toNumber() * 500) : 0;
    liquidityPoints = clamp((baseline - impactPenalty) / 100 * WEIGHTS.liquidity, 0, WEIGHTS.liquidity);
    if (planned && liquidity.lt(planned.mul(10))) hardFails.push('insufficient_planned_size_liquidity');
  }
  components.push({ key: 'liquidity', weight: WEIGHTS.liquidity, points: liquidityPoints, raw: { liquidityUsd: latest?.liquidityUsd ?? null, plannedPrincipalUsd: input.plannedPrincipalUsd ?? null }, source: latest?.source ?? 'unavailable', observedAt: latest?.sourceTime ?? latest?.ingestedAt ?? null, explanation: 'Rewards deeper USD liquidity and penalizes planned capital that is large relative to the pool.' });

  let routePoints = 0;
  if (!input.route || ['not_attempted', 'not_configured', 'quote_failed', 'timed_out', 'stale'].includes(input.route.state)) {
    materialUnknowns.push('executable_route_unverified');
    routePoints = input.route?.state === 'stale' ? 3 : 0;
  } else if (input.route.state === 'available') {
    const recovery = input.route.recoveryPct ?? 0;
    routePoints = clamp((recovery - 70) / 30 * WEIGHTS.route, 0, WEIGHTS.route);
    if (input.route.sell?.state === 'available' && recovery < 50) hardFails.push('severe_confirmed_round_trip_loss');
  } else if (input.route.state === 'no_route_or_liquidity') {
    if (input.route.buy?.state === 'available' && input.route.sell?.state === 'no_route_or_liquidity') hardFails.push('attempted_buy_but_no_sell_route');
  }
  components.push({ key: 'route', weight: WEIGHTS.route, points: routePoints, raw: { state: input.route?.state ?? 'not_attempted', recoveryPct: input.route?.recoveryPct ?? null }, source: input.route?.buy?.provider ?? 'unavailable', observedAt: input.route?.buy?.quotedAt ?? null, explanation: 'Uses independent read-only buy and sell quotes; missing quote access lowers confidence, not safety.' });

  const preferredSwing = input.swings?.results.find((result) => result.threshold === 0.05 && result.horizon === '7d')
    ?? input.swings?.results.filter((result) => result.threshold === 0.05).sort((a, b) => b.quality.sampleCount - a.quality.sampleCount)[0];
  const swingPoints = preferredSwing ? preferredSwing.suitability / 100 * WEIGHTS.swing : 0;
  if (!preferredSwing || preferredSwing.quality.coveragePct < 50) materialUnknowns.push('insufficient_swing_history');
  components.push({ key: 'swing', weight: WEIGHTS.swing, points: swingPoints, raw: { suitability: preferredSwing?.suitability ?? null, coveragePct: preferredSwing?.quality.coveragePct ?? null, roundTrips: preferredSwing?.completedRoundTrips ?? null }, source: 'retained_snapshots', observedAt: input.swings?.generatedAt ?? null, explanation: 'Measures observed 5% reversal frequency, regularity, coverage, amplitude and trend penalty.' });

  const volume = decimal(latest?.volume24hUsd);
  let activityPoints = 0;
  if (!volume || !liquidity || liquidity.eq(0)) materialUnknowns.push('activity_quality_unknown');
  else {
    const ratio = volume.div(liquidity).toNumber();
    const balance = latest?.buys24h !== null && latest?.sells24h !== null && latest?.buys24h !== undefined && latest?.sells24h !== undefined
      ? Math.min(latest.buys24h, latest.sells24h) / Math.max(1, latest.buys24h + latest.sells24h) * 2
      : 0.5;
    activityPoints = clamp(Math.min(1, ratio / 2) * balance * WEIGHTS.activity, 0, WEIGHTS.activity);
  }
  components.push({ key: 'activity', weight: WEIGHTS.activity, points: activityPoints, raw: { volume24hUsd: latest?.volume24hUsd ?? null, liquidityUsd: latest?.liquidityUsd ?? null, buys24h: latest?.buys24h ?? null, sells24h: latest?.sells24h ?? null }, source: latest?.source ?? 'unavailable', observedAt: latest?.sourceTime ?? latest?.ingestedAt ?? null, explanation: 'Rewards persistent turnover relative to liquidity and balanced two-way transaction activity.' });

  let stabilityPoints = 0;
  if (!latest?.pairCreatedAt) materialUnknowns.push('pair_age_unknown');
  else {
    const ageDays = Math.max(0, (Date.parse(now) - Date.parse(latest.pairCreatedAt)) / 86_400_000);
    stabilityPoints = clamp(ageDays / 30 * WEIGHTS.stability, 0, WEIGHTS.stability);
  }
  components.push({ key: 'stability', weight: WEIGHTS.stability, points: stabilityPoints, raw: { pairCreatedAt: latest?.pairCreatedAt ?? null }, source: latest?.source ?? 'unavailable', observedAt: latest?.sourceTime ?? latest?.ingestedAt ?? null, explanation: 'Older continuously observed markets receive more credit, capped after thirty days.' });

  const riskPoints = contractPoints(input.risks);
  if (input.risks.length === 0 || input.risks.some((flag) => flag.state === 'unknown')) materialUnknowns.push('contract_posture_incomplete');
  components.push({ key: 'contract', weight: WEIGHTS.contract, points: riskPoints, raw: { flags: input.risks.length, detected: input.risks.filter((flag) => flag.state === 'detected').length, unknown: input.risks.filter((flag) => flag.state === 'unknown').length }, source: 'rpc_static_scan', observedAt: input.risks[0]?.evidence[0]?.observedAt ?? null, explanation: 'Deducts for evidenced hazards and modestly for uncertainty; selector absence is never proof of safety.' });

  const score = Math.round(clamp(components.reduce((sum, component) => sum + component.points, 0)) * 10) / 10;
  const historyCoverage = preferredSwing?.quality.coveragePct ?? 0;
  const knownComponents = components.filter((component) => component.raw && !Object.values(component.raw).every((value) => value === null || value === 'unavailable')).reduce((sum, component) => sum + component.weight, 0);
  const routeConfidence = input.route?.state === 'available' ? 100 : input.route?.state === 'stale' ? 30 : 0;
  const confidence = Math.round(clamp(knownComponents * 0.45 + historyCoverage * 0.35 + routeConfidence * 0.2));
  const uniqueFails = [...new Set(hardFails)];
  const uniqueUnknowns = [...new Set(materialUnknowns)];
  const verdict = uniqueFails.length > 0 || score < 50 ? 'REJECT' : score >= 75 && uniqueUnknowns.length === 0 ? 'PASS' : 'CAUTION';
  return { version: SCORE_ALGORITHM_VERSION, score, confidence, verdict, hardFails: uniqueFails, materialUnknowns: uniqueUnknowns, components, calculatedAt: now };
}
