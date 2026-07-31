import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@e-agent/ai-runtime': resolve(import.meta.dirname, '../ai-runtime/src/index.ts'),
      '@e-agent/contracts': resolve(import.meta.dirname, '../contracts/src/index.ts'),
      '@e-agent/database': resolve(import.meta.dirname, '../database/src/index.ts'),
      '@e-agent/observability': resolve(import.meta.dirname, '../observability/src/index.ts'),
      '@e-agent/security': resolve(import.meta.dirname, '../security/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70,
      },
    },
  },
});
