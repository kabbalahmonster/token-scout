import { loadConfig, redactedConfig } from '@doomscout/config';
import { openDatabase } from '@doomscout/database';
import { buildApp } from './app.js';

const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);
const app = await buildApp(config, database);
app.log.info({ config: redactedConfig(config) }, 'starting DoomScout API');
try { await app.listen({ host: config.HOST, port: config.API_PORT }); }
catch (error) { app.log.error(error); await database.close(); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => database.close()); });
