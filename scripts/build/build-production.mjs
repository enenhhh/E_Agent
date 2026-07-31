#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import { parseArguments, workspaceRoot } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const includeDesktopPackage = argumentsMap.has('package-desktop');
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const stages = [['typecheck'], ['lint'], ['test'], ['turbo', 'run', 'build']];

if (includeDesktopPackage) {
  stages.push(['--filter', '@e-agent/desktop', 'package']);
}

for (const stage of stages) {
  console.log(`\n[build] pnpm ${stage.join(' ')}`);
  const result = spawnSync(command, stage, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\n生产构建完成。');
