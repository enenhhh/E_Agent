import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@e-agent/ai-runtime': resolve(import.meta.dirname, '../../packages/ai-runtime/src/index.ts'),
      '@e-agent/config': resolve(import.meta.dirname, '../../packages/config/src/index.ts'),
      '@e-agent/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
      '@e-agent/core': resolve(import.meta.dirname, '../../packages/core/src/index.ts'),
      '@e-agent/database': resolve(import.meta.dirname, '../../packages/database/src/index.ts'),
      '@e-agent/observability': resolve(
        import.meta.dirname,
        '../../packages/observability/src/index.ts',
      ),
      '@e-agent/plugin-runtime': resolve(
        import.meta.dirname,
        '../../packages/plugin-runtime/src/index.ts',
      ),
      '@e-agent/plugin-sdk': resolve(import.meta.dirname, '../../packages/plugin-sdk/src/index.ts'),
      '@e-agent/security': resolve(import.meta.dirname, '../../packages/security/src/index.ts'),
      '@e-agent/skills': resolve(import.meta.dirname, '../../packages/skills/src/index.ts'),
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
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
