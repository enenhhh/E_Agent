#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hookCommands = new Map([
  ['pre-commit', [['lint'], ['test']]],
  ['pre-push', [['typecheck']]],
]);

function runPnpm(argumentsList) {
  const isWindows = process.platform === 'win32';
  const executable = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const commandArguments = isWindows ? ['/d', '/s', '/c', 'pnpm', ...argumentsList] : argumentsList;
  const result = spawnSync(executable, commandArguments, {
    cwd: workspaceRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

const hookName = process.argv[2];
const commands = hookCommands.get(hookName);
if (commands === undefined) {
  console.error(`不支持的 Git hook：${hookName ?? 'missing'}`);
  process.exitCode = 2;
} else {
  for (const argumentsList of commands) {
    const exitCode = runPnpm(argumentsList);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
}
