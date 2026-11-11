import { randomUUID } from 'node:crypto';
import { loadConfig } from '@doomscout/config';
import { openDatabase } from '@doomscout/database';
import { AssessmentService, staleAfterSeconds } from './service.js';

const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);
const service = new AssessmentService(config, database.repositories);
const workerId = `worker-${randomUUID().slice(0, 8)}`;
let stopping = false;

function log(level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, event, at: new Date().toISOString(), ...detail }));
}

async function schedule(): Promise<void> {
  const now = Date.now();
  const recovered = await database.repositories.recoverExpiredJobLeases(new Date(now - config.JOB_LEASE_SECONDS * 1000).toISOString());
  if (recovered > 0) log('warn', 'jobs.leases_recovered', { recovered });
  await database.repositories.enqueueScheduled('discover', `discovery:${Math.floor(now / (config.DISCOVERY_INTERVAL_SECONDS * 1000))}`, {});
  const watched = await database.repositories.listCandidates({ watched: true, limit: 2000 });
  await Promise.all(watched.map((candidate) => database.repositories.enqueueScheduled('assess', `watch:${candidate.chainId}:${candidate.address}:${Math.floor(now / (config.WATCHED_POLL_SECONDS * 1000))}`, { chainId: candidate.chainId, address: candidate.address })));
  if (config.CANDIDATE_REFRESH_ENABLED) {
    const assessedBefore = new Date(now - config.CANDIDATE_REFRESH_SECONDS * 1000).toISOString();
    const refresh = await database.repositories.listRefreshCandidates({
      assessedBefore,
      minScore: config.CANDIDATE_REFRESH_MIN_SCORE,
      limit: config.CANDIDATE_REFRESH_BATCH_SIZE
    });
    await Promise.all(refresh.map((candidate) => database.repositories.enqueueScheduled(
      'assess',
      `refresh:${candidate.chainId}:${candidate.address}:${Math.floor(now / (config.CANDIDATE_REFRESH_SECONDS * 1000))}`,
      { chainId: candidate.chainId, address: candidate.address }
    )));
  }
  if (config.UNIVERSE_REFRESH_ENABLED) {
    const assessedBefore = new Date(now - config.UNIVERSE_REFRESH_SECONDS * 1000).toISOString();
    const refresh = await database.repositories.listUniverseRefreshCandidates({
      assessedBefore,
      priorityMinScore: config.CANDIDATE_REFRESH_MIN_SCORE,
      limit: config.UNIVERSE_REFRESH_BATCH_SIZE
    });
    await Promise.all(refresh.map((candidate) => database.repositories.enqueueScheduled(
      'assess',
      `universe:${candidate.chainId}:${candidate.address}:${Math.floor(now / (config.UNIVERSE_REFRESH_SECONDS * 1000))}`,
      { chainId: candidate.chainId, address: candidate.address }
    )));
  }
  const assessed = await database.repositories.listCandidates({ limit: 2000 });
  await Promise.all(assessed.filter((candidate) => {
    if (!candidate.latestSnapshot) return false;
    const refreshEligible = config.CANDIDATE_REFRESH_ENABLED
      && ['PASS', 'CAUTION'].includes(candidate.verdict)
      && (candidate.score ?? -1) >= config.CANDIDATE_REFRESH_MIN_SCORE;
    const retainedCadence = refreshEligible
      ? config.CANDIDATE_REFRESH_SECONDS
      : config.UNIVERSE_REFRESH_ENABLED ? config.UNIVERSE_REFRESH_SECONDS : undefined;
    const staleAfterMs = staleAfterSeconds(candidate.watched, config.WATCHED_POLL_SECONDS, config.DISCOVERY_INTERVAL_SECONDS, retainedCadence) * 1000;
    return candidate.state !== 'stale' && Date.now() - Date.parse(candidate.latestSnapshot.ingestedAt) > staleAfterMs;
  }).map((candidate) => database.repositories.setCandidateState(candidate.chainId, candidate.address, 'stale')));
  await database.repositories.enqueueScheduled('retention', `retention:${new Date().toISOString().slice(0, 10)}`, {});
}

async function runJob(): Promise<boolean> {
  const job = await database.repositories.claimJob(workerId);
  if (!job) return false;
  try {
    if (job.kind === 'discover') { await database.repositories.updateJobProgress(job.id, 'discovering_markets', 10, 'Exploring indexed market feeds for eligible contracts.'); await service.discover(); }
    else if (job.kind === 'assess') await service.assess(Number(job.payload.chainId), String(job.payload.address), (stage, percent, message) => database.repositories.updateJobProgress(job.id, stage, percent, message));
    else if (job.kind === 'retention') {
      await database.repositories.updateJobProgress(job.id, 'maintaining_evidence', 10, 'Applying bounded evidence-retention policy.');
      if (config.COMPREHENSIVE_RETENTION_ENABLED) {
        const report = await database.repositories.housekeeping({
          rawDays: config.RAW_RETENTION_DAYS,
          fiveMinuteDays: config.CANDLE_RETENTION_DAYS,
          hourlyDays: config.HOURLY_RETENTION_DAYS,
          candidateArchiveDays: config.CANDIDATE_ARCHIVE_DAYS,
          archivedCandidateDays: config.ARCHIVED_CANDIDATE_RETENTION_DAYS,
          discoveryDays: config.DISCOVERY_RETENTION_DAYS,
          completedJobDays: config.COMPLETED_JOB_RETENTION_DAYS,
          failedJobDays: config.FAILED_JOB_RETENTION_DAYS,
          alertDays: config.ALERT_RETENTION_DAYS,
          appEventDays: config.APP_EVENT_RETENTION_DAYS,
          assessmentDetailDays: config.ASSESSMENT_DETAIL_RETENTION_DAYS,
          assessmentDailyDays: config.ASSESSMENT_DAILY_RETENTION_DAYS
        });
        log('info', 'housekeeping.completed', { ...report });
      } else {
        await database.repositories.retention(config.RAW_RETENTION_DAYS, config.CANDLE_RETENTION_DAYS, config.HOURLY_RETENTION_DAYS);
      }
    }
    else throw new Error(`Unknown job kind: ${job.kind}`);
    await database.repositories.finishJob(job.id);
    log('info', 'job.completed', { id: job.id, kind: job.kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure';
    const retryAt = job.attempts < 4 ? new Date(Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts)).toISOString() : undefined;
    await database.repositories.failJob(job.id, message, retryAt);
    log('error', 'job.failed', { id: job.id, kind: job.kind, message, retry: Boolean(retryAt) });
  }
  return true;
}

async function main(): Promise<void> {
  log('info', 'worker.started', { workerId, chainId: config.CHAIN_ID });
  let lastSchedule = 0;
  while (!stopping) {
    if (Date.now() - lastSchedule > 10_000) { await schedule(); lastSchedule = Date.now(); }
    const worked = await runJob();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; log('info', 'worker.stopping', { signal }); });

try { await main(); } finally { await database.close(); }
