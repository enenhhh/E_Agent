#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pnpmCli =
  process.env['npm_execpath'] && existsSync(process.env['npm_execpath'])
    ? process.env['npm_execpath']
    : null;
const playwrightCli = path.join(workspaceRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const electronNativePreparer = path.join(
  workspaceRoot,
  'scripts',
  'build',
  'prepare-electron-native.mjs',
);
const nodeNativePreparer = path.join(workspaceRoot, 'scripts', 'build', 'prepare-node-native.mjs');

function run(command, argumentsList, environment = process.env) {
  const result = spawnSync(command, argumentsList, {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`子进程执行失败（退出码 ${result.status ?? 1}）`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function runPnpm(argumentsList) {
  if (pnpmCli) {
    run(process.execPath, [pnpmCli, ...argumentsList]);
    return;
  }
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(executable, argumentsList, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`pnpm 执行失败（退出码 ${result.status ?? 1}）`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

if (!existsSync(playwrightCli)) {
  throw new Error('Playwright 未安装，请先运行 pnpm install。');
}

let exitCode = 0;

try {
  // 先生成最新产物，再针对 Electron ABI 重建原生依赖。
  runPnpm(['--filter', '@e-agent/desktop', 'build']);
  run(process.execPath, [electronNativePreparer]);

  run(
    process.execPath,
    [playwrightCli, 'test', 'tests/e2e/desktop', '--project=desktop', ...process.argv.slice(2)],
    {
      ...process.env,
      E_AGENT_DESKTOP_E2E: '1',
    },
  );
} catch (error) {
  exitCode =
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
      ? error.exitCode
      : 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  // 无论 E2E 是否成功，都恢复并验证普通 Node 所需的原生模块 ABI。
  try {
    run(process.execPath, [nodeNativePreparer]);
  } catch (error) {
    exitCode = exitCode || 1;
    console.error(
      '恢复 Node 原生依赖失败：',
      error instanceof Error ? error.message : String(error),
    );
  }
}

process.exitCode = exitCode;
