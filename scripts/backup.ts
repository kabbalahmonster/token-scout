import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.DATABASE_PATH ?? './data/doomscout.db');
const destination = resolve(process.argv[2] ?? `./backups/doomscout-${new Date().toISOString().replaceAll(':', '-')}.db`);
if (source === destination) throw new Error('Backup destination must differ from DATABASE_PATH');
await mkdir(dirname(destination), { recursive: true });
const database = new Database(source, { readonly: true });
try { await database.backup(destination); console.log(JSON.stringify({ level: 'info', event: 'backup.complete', destination })); }
finally { database.close(); }
