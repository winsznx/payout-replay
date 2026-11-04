import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 90_000, fileParallelism: false } });
