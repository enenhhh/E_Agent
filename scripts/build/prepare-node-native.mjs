#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDirectory = path.join(workspaceRoot, 'apps', 'desktop');
const desktopPackagePath = path.join(desktopDirectory, 'package.json');

const electronEnvironmentKeys = new Set([
  'electron_run_as_node',
  'npm_config_dist_url',
  'npm_config_disturl',
  'npm_config_electron_version',
  'npm_config_runtime',
  'npm_config_target',
  'npm_config_target_arch',
]);

function createNodeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !electronEnvironmentKeys.has(key.toLowerCase())),
  );
}

const nodeEnvironment = createNodeEnvironment();

function formatProcessFailure(result) {
  const details = [result.stderr, result.stdout]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n');
  return details || `进程退出码：${result.status ?? 1}`;
}

function verifyNodeNative() {
  const verificationScript = [
    "const { createRequire } = require('node:module')",
    `const requireFromDesktop = createRequire(${JSON.stringify(desktopPackagePath)})`,
    "const Database = requireFromDesktop('better-sqlite3')",
    "const database = new Database(':memory:')",
    "const row = database.prepare('SELECT 1 AS value').get()",
    'database.close()',
    "if (row?.value !== 1) throw new Error('better-sqlite3 内存数据库查询结果异常')",
    'process.stdout.write(`NODE_MODULE_VERSION=${process.versions.modules}`)',
  ].join(';');

  return spawnSync(process.execPath, ['-e', verificationScript], {
    cwd: workspaceRoot,
    env: nodeEnvironment,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPnpm(argumentsList) {
  const npmExecutable = process.env['npm_execpath'];
  if (npmExecutable && existsSync(npmExecutable)) {
    return spawnSync(process.execPath, [npmExecutable, ...argumentsList], {
      cwd: workspaceRoot,
      env: nodeEnvironment,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const executable = process.platform === 'win32' ? (process.env['ComSpec'] ?? 'cmd.exe') : 'pnpm';
  const executableArguments =
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', ...argumentsList] : argumentsList;
  return spawnSync(executable, executableArguments, {
    cwd: workspaceRoot,
    env: nodeEnvironment,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const initialVerification = verifyNodeNative();
if (initialVerification.error === undefined && initialVerification.status === 0) {
  console.log(`Node 原生依赖 ABI 已就绪：${initialVerification.stdout.trim()}`);
  process.exit(0);
}

console.warn('检测到 better-sqlite3 与当前 Node ABI 不兼容，正在自动修复……');

const rebuild = runPnpm([
  '--filter',
  '@e-agent/desktop',
  'rebuild',
  'better-sqlite3',
  '--reporter=append-only',
]);
if (rebuild.error !== undefined) {
  throw rebuild.error;
}
if (rebuild.status !== 0) {
  throw new Error(`Node 原生依赖重建失败。\n${formatProcessFailure(rebuild)}`);
}

const finalVerification = verifyNodeNative();
if (finalVerification.error !== undefined) {
  throw finalVerification.error;
}
if (finalVerification.status !== 0) {
  throw new Error(
    `Node 原生依赖重建后仍无法创建内存数据库。\n${formatProcessFailure(finalVerification)}`,
  );
}

console.log(`Node 原生依赖 ABI 自愈完成：${finalVerification.stdout.trim()}`);
