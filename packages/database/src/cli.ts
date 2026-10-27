import { openDatabase } from './index.js';

const command = process.argv[2];
if (command !== 'migrate') throw new Error('Usage: pnpm --filter @doomscout/database migrate');
const database = openDatabase(process.env.DATABASE_PATH ?? './data/doomscout.db');
console.log(JSON.stringify({ level: 'info', event: 'database.migrated', path: process.env.DATABASE_PATH ?? './data/doomscout.db' }));
await database.close();
