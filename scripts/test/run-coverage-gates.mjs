import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vitestEntry = resolve(workspaceRoot, 'node_modules/vitest/vitest.mjs');
const nodeNativePreparer = resolve(workspaceRoot, 'scripts/build/prepare-node-native.mjs');

const gatedProjects = [
  'packages/contracts',
  'packages/config',
  'packages/security',
  'packages/observability',
  'packages/ai-runtime',
  'packages/core',
  'packages/database',
  'packages/plugin-sdk',
  'packages/plugin-runtime',
  'packages/skills',
  'apps/plugin-host',
  'apps/server',
  'apps/desktop',
  'packages/app-ui',
  'plugins/code-review',
  'plugins/builtin-skills',
];

function runNode(entry, cwd, arguments_ = []) {
  const result = spawnSync(process.execPath, [entry, ...arguments_], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runNode(nodeNativePreparer, workspaceRoot);

console.log('Generating the combined workspace coverage report...');
runNode(vitestEntry, workspaceRoot, ['run', '--config', 'vitest.config.ts', '--coverage']);

for (const project of gatedProjects) {
  console.log(`\nEnforcing coverage thresholds: ${project}`);
  runNode(vitestEntry, resolve(workspaceRoot, project), ['run', '--coverage']);
}

console.log('\nAll configured coverage thresholds passed.');
