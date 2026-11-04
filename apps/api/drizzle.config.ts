import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: '../../infra/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/payout_replay' },
});
