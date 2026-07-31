import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: testsDirectory,
  resolve: {
    alias: {
      '@e-agent/ai-runtime': path.resolve(testsDirectory, '../packages/ai-runtime/src/index.ts'),
      '@e-agent/contracts': path.resolve(testsDirectory, '../packages/contracts/src/index.ts'),
      '@e-agent/security': path.resolve(testsDirectory, '../packages/security/src/index.ts'),
    },
  },
  test: {
    name: 'cross-cutting',
    environment: 'node',
    include: ['contract/**/*.spec.ts', 'performance/**/*.spec.ts', 'security/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: path.resolve(testsDirectory, '../coverage/cross-cutting'),
      include: [
        '../packages/ai-runtime/src/**/*.ts',
        '../packages/security/src/**/*.ts',
        '../scripts/**/*.mjs',
      ],
    },
  },
});
