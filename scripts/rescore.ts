import { loadConfig } from '../packages/config/src/index.js';
import { openDatabase } from '../packages/database/src/index.js';
import { calculateSwingStudy, scoreCandidate } from '../packages/domain/src/index.js';

const apply = process.argv.includes('--apply');
const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);
const batchAt = new Date().toISOString();

async function main(): Promise<void> {
try {
  const candidates = await database.repositories.listCandidates({ limit: 2000 });
  const results: Array<{ symbol: string; address: string; score: number; verdict: string; swing: number | null; ageDays: number | null }> = [];

  for (const candidate of candidates) {
    const [history, latest, route, scan, previous] = await Promise.all([
      database.repositories.analyticsHistory(candidate.chainId, candidate.address, config.RAW_RETENTION_DAYS, config.CANDLE_RETENTION_DAYS, config.HOURLY_RETENTION_DAYS),
      database.repositories.latestSnapshot(candidate.chainId, candidate.address),
      database.repositories.latestRouteAssessment(candidate.chainId, candidate.address),
      database.repositories.latestContractScan(candidate.chainId, candidate.address),
      database.repositories.latestScore(candidate.chainId, candidate.address)
    ]);
    const study = calculateSwingStudy(history, {
      thresholds: config.SWING_THRESHOLDS,
      expectedPollSeconds: config.EXPECTED_POLL_SECONDS,
      minimumEventSeparationSeconds: config.SWING_MIN_SEPARATION_SECONDS,
      confirmationSamples: config.SWING_CONFIRMATION_SAMPLES
    }, batchAt);
    const priorPlanned = previous?.components.find((component) => component.key === 'liquidity')?.raw.plannedPrincipalUsd;
    const plannedPrincipalUsd = typeof priorPlanned === 'string' ? priorPlanned : null;
    const score = scoreCandidate({ latest, swings: study, route, risks: scan?.flags ?? candidate.flags, plannedPrincipalUsd, now: batchAt });
    const preferredSwing = study.results.find((result) => result.threshold === 0.05 && result.horizon === '7d');
    const ageDays = latest?.pairCreatedAt ? Math.max(0, (Date.parse(batchAt) - Date.parse(latest.pairCreatedAt)) / 86_400_000) : null;
    results.push({ symbol: candidate.symbol ?? 'unknown', address: candidate.address, score: score.score, verdict: score.verdict, swing: preferredSwing?.suitability ?? null, ageDays });
    if (apply) {
      await database.repositories.saveSwingStudy(candidate.chainId, candidate.address, study);
      await database.repositories.saveScore(candidate.chainId, candidate.address, score);
    }
  }

  const verdicts = results.reduce<Record<string, number>>((counts, result) => {
    counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', algorithmVersion: '2.0.0', candidates: results.length, verdicts, top: results.sort((a, b) => b.score - a.score).slice(0, 25) }, null, 2));
} finally {
  await database.close();
}
}

void main();
