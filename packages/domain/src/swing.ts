import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { clamp, distribution, mean, percentile, standardDeviation } from './statistics.js';
import { SWING_ALGORITHM_VERSION, type HistoryQuality, type MarketSnapshot, type SwingEvent, type SwingParameters, type SwingStudy, type SwingThresholdResult } from './types.js';

export const DEFAULT_SWING_PARAMETERS: SwingParameters = {
  thresholds: [0.02, 0.05, 0.1, 0.2],
  horizonsSeconds: { '1h': 3600, '6h': 21_600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 },
  expectedPollSeconds: 60,
  maxGapMultiplier: 3,
  minimumEventSeparationSeconds: 60,
  confirmationSamples: 1
};

interface Point { id: number; at: number; price: Decimal; source: string; expectedSeconds: number }

function expectedCadence(source: string, fallback: number): number {
  if (source === 'doomscout_5m_aggregate') return 300;
  if (source === 'doomscout_1h_aggregate' || source === 'geckoterminal_1h_candle') return 3600;
  return fallback;
}

function pricePoints(snapshots: MarketSnapshot[], fallbackExpectedSeconds: number): Point[] {
  return snapshots
    .filter((snapshot) => snapshot.priceUsd !== null || snapshot.priceNative !== null)
    .map((snapshot) => ({
      id: snapshot.id,
      at: Date.parse(snapshot.ingestedAt),
      price: new Decimal(snapshot.priceUsd ?? snapshot.priceNative ?? '0'),
      source: snapshot.source,
      expectedSeconds: expectedCadence(snapshot.source, fallbackExpectedSeconds)
    }))
    .filter((point) => Number.isFinite(point.at) && point.price.gt(0))
    .sort((a, b) => a.at - b.at || a.id - b.id);
}

function quality(points: Point[], horizonSeconds: number, expectedPollSeconds: number, maxGapMultiplier: number): HistoryQuality {
  const gaps = points.slice(1).map((point, index) => (point.at - (points[index]?.at ?? point.at)) / 1000);
  const first = points[0];
  const last = points.at(-1);
  // Coverage is measured against the requested horizon, not merely the span
  // observed so far; otherwise two minutes of a new market could masquerade as
  // 100% seven-day coverage and inflate confidence.
  let coveredSeconds = points[0]?.expectedSeconds ?? 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const previous = points[index - 1]!;
    const gap = (point.at - previous.at) / 1000;
    const expected = Math.max(point.expectedSeconds, previous.expectedSeconds);
    if (gap <= expected * maxGapMultiplier) coveredSeconds += Math.min(gap, expected);
    else coveredSeconds += point.expectedSeconds;
  }
  return {
    sampleCount: points.length,
    coveragePct: clamp((coveredSeconds / horizonSeconds) * 100),
    largestGapSeconds: gaps.length ? Math.max(...gaps) : null,
    expectedPollSeconds,
    sourceCount: new Set(points.map((point) => point.source)).size,
    earliestAt: first ? new Date(first.at).toISOString() : null,
    latestAt: last ? new Date(last.at).toISOString() : null
  };
}

function splitAtGaps(points: Point[], maxGapMultiplier: number): Point[][] {
  const segments: Point[][] = [];
  for (const point of points) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    const maximumGapMs = previous ? Math.max(previous.expectedSeconds, point.expectedSeconds) * maxGapMultiplier * 1000 : 0;
    if (!current || (previous && point.at - previous.at > maximumGapMs)) segments.push([point]);
    else current.push(point);
  }
  return segments;
}

function eventId(threshold: number, direction: string, start: Point, end: Point): string {
  return createHash('sha256').update(`${SWING_ALGORITHM_VERSION}:${threshold}:${direction}:${start.id}:${end.id}`).digest('hex').slice(0, 20);
}

/**
 * Detect confirmed threshold reversals with a directional-change algorithm.
 * An event begins at the running local extreme and only completes once price
 * crosses the configured percentage in the opposite direction. Events never
 * cross a source gap and confirmation samples must all remain beyond threshold.
 */
function detectSegmentEvents(segment: Point[], threshold: number, parameters: SwingParameters): SwingEvent[] {
  if (segment.length < 2) return [];
  const events: SwingEvent[] = [];
  let high = segment[0]!;
  let low = segment[0]!;
  let mode: 'seeking_either' | 'seeking_down' | 'seeking_up' = 'seeking_either';
  let lastEventAt = -Infinity;
  let adverse = new Decimal(0);

  for (let index = 1; index < segment.length; index += 1) {
    const point = segment[index]!;
    if (point.price.gt(high.price)) high = point;
    if (point.price.lt(low.price)) low = point;

    const downMove = high.price.minus(point.price).div(high.price);
    const upMove = point.price.minus(low.price).div(low.price);
    const candidates: Array<{ direction: 'up' | 'down'; start: Point; move: Decimal }> = [];
    if (mode !== 'seeking_up' && downMove.gte(threshold)) candidates.push({ direction: 'down', start: high, move: downMove });
    if (mode !== 'seeking_down' && upMove.gte(threshold)) candidates.push({ direction: 'up', start: low, move: upMove });
    const candidate = candidates.sort((a, b) => b.move.comparedTo(a.move))[0];
    if (!candidate) {
      if (mode === 'seeking_down') adverse = Decimal.max(adverse, upMove);
      if (mode === 'seeking_up') adverse = Decimal.max(adverse, downMove);
      continue;
    }

    const confirmation = segment.slice(index, index + parameters.confirmationSamples);
    if (confirmation.length < parameters.confirmationSamples) continue;
    const confirmed = confirmation.every((sample) => candidate.direction === 'down'
      ? candidate.start.price.minus(sample.price).div(candidate.start.price).gte(threshold)
      : sample.price.minus(candidate.start.price).div(candidate.start.price).gte(threshold));
    if (!confirmed || point.at - lastEventAt < parameters.minimumEventSeparationSeconds * 1000) continue;

    const previous = events.at(-1);
    const opposite = previous && previous.direction !== candidate.direction ? previous : null;
    const id = eventId(threshold, candidate.direction, candidate.start, point);
    events.push({
      id,
      threshold,
      direction: candidate.direction,
      startSnapshotId: candidate.start.id,
      endSnapshotId: point.id,
      startAt: new Date(candidate.start.at).toISOString(),
      endAt: new Date(point.at).toISOString(),
      startPrice: candidate.start.price.toSignificantDigits(30).toString(),
      endPrice: point.price.toSignificantDigits(30).toString(),
      durationSeconds: (point.at - candidate.start.at) / 1000,
      amplitude: candidate.move.toNumber(),
      adverseExcursion: adverse.toNumber(),
      roundTripId: opposite ? `${opposite.id}:${id}` : null
    });
    lastEventAt = point.at;
    mode = candidate.direction === 'down' ? 'seeking_up' : 'seeking_down';
    high = point;
    low = point;
    adverse = new Decimal(0);
  }
  return events;
}

function maximumDrawdown(points: Point[]): number {
  let peak: Decimal | null = null;
  let drawdown = new Decimal(0);
  for (const point of points) {
    peak = peak === null ? point.price : Decimal.max(peak, point.price);
    drawdown = Decimal.max(drawdown, peak.minus(point.price).div(peak));
  }
  return drawdown.toNumber();
}

function dominantRangePct(points: Point[]): number {
  if (points.length < 2) return points.length ? 100 : 0;
  const prices = points.map((point) => point.price.toNumber());
  const low = percentile(prices, 0.25);
  const high = percentile(prices, 0.75);
  if (low === null || high === null) return 0;
  return (prices.filter((price) => price >= low && price <= high).length / prices.length) * 100;
}

function analyze(points: Point[], threshold: number, horizon: string, horizonSeconds: number, parameters: SwingParameters, now: number): SwingThresholdResult {
  const relevant = points.filter((point) => point.at >= now - horizonSeconds * 1000 && point.at <= now);
  const segments = splitAtGaps(relevant, parameters.maxGapMultiplier);
  const events = segments.flatMap((segment) => detectSegmentEvents(segment, threshold, parameters));
  const traversalDurations = events.map((event) => event.durationSeconds);
  // Comparable-event intervals answer “how often does another up/down swing
  // occur?” independently for each direction. Traversal duration remains a
  // separate distribution describing time from local extreme to threshold.
  const comparableDurations = (['up', 'down'] as const).flatMap((direction) => {
    const directional = events.filter((event) => event.direction === direction);
    return directional.slice(1).map((event, index) => (Date.parse(event.endAt) - Date.parse(directional[index]!.endAt)) / 1000);
  });
  const amplitudes = events.map((event) => event.amplitude);
  const logs = relevant.slice(1).map((point, index) => Math.log(point.price.div(relevant[index]!.price).toNumber()));
  const first = relevant[0];
  const last = relevant.at(-1);
  const elapsedDays = first && last ? Math.max((last.at - first.at) / 86_400_000, parameters.expectedPollSeconds / 86_400) : horizonSeconds / 86_400;
  const drift = first && last ? last.price.div(first.price).minus(1).toNumber() : 0;
  const half = Math.floor(relevant.length / 2);
  const range = (samples: Point[]) => {
    if (samples.length < 2) return null;
    const values = samples.map((point) => point.price);
    return Decimal.max(...values).minus(Decimal.min(...values)).div(Decimal.min(...values)).toNumber();
  };
  const firstRange = range(relevant.slice(0, half));
  const secondRange = range(relevant.slice(half));
  const qualityResult = quality(relevant, horizonSeconds, parameters.expectedPollSeconds, parameters.maxGapMultiplier);
  const upCrossings = events.filter((event) => event.direction === 'up').length;
  const downCrossings = events.filter((event) => event.direction === 'down').length;
  const directionBalance = events.length ? Math.min(upCrossings, downCrossings) * 2 / events.length : 0;
  // A grid bot needs repeatable movement in both directions. Saturate frequency
  // at three balanced events/day so hyperactive noise cannot overwhelm every
  // other input.
  const balancedEventsPerDay = events.length / Math.max(elapsedDays, 1 / 24) * directionBalance;
  const frequencyScore = clamp(balancedEventsPerDay / 3 * 100);
  // Merely touching the configured threshold earns modest credit. Moves around
  // twice the threshold earn most of the amplitude score, while extreme outliers
  // are capped instead of dominating the ranking.
  const amplitudeScore = clamp(30 + (((mean(amplitudes) ?? 0) / threshold) - 1) * 60);
  const medianTraversalHours = (distribution(traversalDurations).median ?? Number.POSITIVE_INFINITY) / 3600;
  // Fast moves are more useful to a practical bot. One hour or less receives
  // full credit; the score then decays logarithmically to zero near 32 hours.
  const speedScore = Number.isFinite(medianTraversalHours)
    ? clamp(100 - Math.max(0, Math.log2(Math.max(1, medianTraversalHours))) * 20)
    : 0;
  const repeatScore = clamp(events.filter((event) => event.roundTripId !== null).length / 12 * 100);
  // Strong drift remains a risk, but it no longer erases dozens of legitimate
  // completed swings. Execution and contract failures remain separate hard fails.
  const trendPenalty = clamp((Math.abs(drift) - 0.25) / 0.75 * 15, 0, 15);
  const suitability = clamp(
    frequencyScore * 0.25 + amplitudeScore * 0.25 + speedScore * 0.2
    + repeatScore * 0.15 + qualityResult.coveragePct * 0.1
    + directionBalance * 100 * 0.05 - trendPenalty
  );
  return {
    threshold,
    horizon,
    upCrossings,
    downCrossings,
    completedRoundTrips: events.filter((event) => event.roundTripId !== null).length,
    eventsPerDay: events.length / Math.max(elapsedDays, 1 / 24),
    timeSinceLastEventSeconds: events.length ? (now - Date.parse(events.at(-1)!.endAt)) / 1000 : null,
    durationSeconds: distribution(comparableDurations),
    eventTraversalDurationSeconds: distribution(traversalDurations),
    amplitude: distribution(amplitudes),
    maximumDrawdown: maximumDrawdown(relevant),
    volatility: standardDeviation(logs),
    drift,
    rangeChange: firstRange !== null && secondRange !== null && firstRange > 0 ? secondRange / firstRange - 1 : null,
    timeInsideDominantRangePct: dominantRangePct(relevant),
    suitability,
    quality: qualityResult,
    events
  };
}

export function calculateSwingStudy(snapshots: MarketSnapshot[], partial: Partial<SwingParameters> = {}, generatedAt?: string): SwingStudy {
  const parameters: SwingParameters = { ...DEFAULT_SWING_PARAMETERS, ...partial };
  const points = pricePoints(snapshots, parameters.expectedPollSeconds);
  const now = generatedAt ? Date.parse(generatedAt) : points.at(-1)?.at ?? Date.now();
  const results = Object.entries(parameters.horizonsSeconds).flatMap(([horizon, seconds]) =>
    parameters.thresholds.map((threshold) => analyze(points, threshold, horizon, seconds, parameters, now))
  );
  return { algorithmVersion: SWING_ALGORITHM_VERSION, generatedAt: new Date(now).toISOString(), parameters, results };
}
