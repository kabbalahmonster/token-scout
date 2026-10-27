import Database from 'better-sqlite3';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

if (!process.argv.includes('--confirm')) throw new Error('Restore overwrites DATABASE_PATH. Stop API/worker, then rerun: pnpm db:restore <backup.db> --confirm');
const input = process.argv[2];
if (!input || input === '--confirm') throw new Error('A backup path is required');
const source = resolve(input); const destination = resolve(process.env.DATABASE_PATH ?? './data/doomscout.db');
if (source === destination) throw new Error('Backup source and DATABASE_PATH must differ');
const check = new Database(source, { readonly: true, fileMustExist: true });
try { const result = check.pragma('integrity_check') as Array<{ integrity_check: string }>; if (result[0]?.integrity_check !== 'ok') throw new Error('Backup failed SQLite integrity_check'); } finally { check.close(); }
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.restore-${process.pid}`;
await copyFile(source, temporary); await rename(temporary, destination);
console.log(JSON.stringify({ level: 'info', event: 'restore.complete', destination }));
