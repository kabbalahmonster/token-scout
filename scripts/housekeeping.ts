import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../packages/config/src/index.js';
import { openDatabase, type HousekeepingPolicy } from '../packages/database/src/index.js';

const config = loadConfig();
const apply = process.argv.includes('--apply');
if (process.argv.includes('--help')) {
  console.log('Usage: pnpm housekeeping [-- --apply]\n\nWithout --apply, runs exact cleanup against a temporary SQLite backup.');
  process.exit(0);
}
const policy: HousekeepingPolicy = {
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
};

async function main(): Promise<void> {
  const source = openDatabase(config.DATABASE_PATH);
  let temporaryDirectory: string | null = null;
  try {
    if (apply) {
      const report = await source.repositories.housekeeping(policy);
      console.log(JSON.stringify({ mode: 'apply', databasePath: config.DATABASE_PATH, policy, report }, null, 2));
    } else {
      // SQLite's online backup API gives the preview a transactionally
      // consistent copy even while API and worker processes remain active.
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'doomscout-housekeeping-'));
      const previewPath = join(temporaryDirectory, 'preview.db');
      await source.sqlite.backup(previewPath);
      const preview = openDatabase(previewPath);
      try {
        const report = await preview.repositories.housekeeping(policy);
        console.log(JSON.stringify({ mode: 'preview', databasePath: config.DATABASE_PATH, policy, report }, null, 2));
      } finally {
        await preview.close();
      }
    }
  } finally {
    await source.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main();
