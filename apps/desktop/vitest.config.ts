import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const workspaceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@e-agent/ai-runtime': resolve(workspaceRoot, 'packages/ai-runtime/src/index.ts'),
      '@e-agent/config': resolve(workspaceRoot, 'packages/config/src/index.ts'),
      '@e-agent/contracts': resolve(workspaceRoot, 'packages/contracts/src/index.ts'),
      '@e-agent/core': resolve(workspaceRoot, 'packages/core/src/index.ts'),
      '@e-agent/database': resolve(workspaceRoot, 'packages/database/src/index.ts'),
      '@e-agent/observability': resolve(workspaceRoot, 'packages/observability/src/index.ts'),
      '@e-agent/plugin-runtime': resolve(workspaceRoot, 'packages/plugin-runtime/src/index.ts'),
      '@e-agent/plugin-sdk': resolve(workspaceRoot, 'packages/plugin-sdk/src/index.ts'),
      '@e-agent/security': resolve(workspaceRoot, 'packages/security/src/index.ts'),
      '@e-agent/skills': resolve(workspaceRoot, 'packages/skills/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
