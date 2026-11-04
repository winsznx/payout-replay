import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDatabase } from './client.js';

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDatabase(url);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../infra/migrations', import.meta.url)) });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
  console.log('migrations applied');
}
