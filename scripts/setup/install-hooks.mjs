#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!existsSync(path.join(workspaceRoot, '.git'))) {
  console.log('[prepare] 未检测到 Git 元数据，跳过本地 Git hooks。');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const cliPath = require.resolve('simple-git-hooks/cli.js');
const result = spawnSync(process.execPath, [cliPath], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
