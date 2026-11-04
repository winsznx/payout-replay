import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { ChainRegistry } from './chain/registry.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startWorker } from './worker.js';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db, close } = createDatabase(config.DATABASE_URL);
const chains = new ChainRegistry(config);
const services = { db, config, chains };
const app = createApp(services);
const worker = config.WORKER_ENABLED ? startWorker(services) : null;

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(JSON.stringify({ level: 'info', message: 'payout-replay api listening', port: info.port, worker: Boolean(worker) }));
});

void chains.health({ fresh: true }).then(
  (health) => console.log(JSON.stringify({ level: 'info', message: 'chain capability', native: health.native.capability, evm: health.evm.capability })),
  (error: unknown) => console.error(JSON.stringify({ level: 'error', message: 'chain probe failed', detail: (error as Error).message })),
);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
  server.close();
  await worker?.stop();
  await chains.close();
  await close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
