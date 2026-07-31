#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDirectory = path.join(workspaceRoot, 'apps', 'desktop');
const desktopPackagePath = path.join(desktopDirectory, 'package.json');
const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
const desktopRequire = createRequire(desktopPackagePath);
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'));
const electronVersion = desktopPackage.devDependencies?.electron;

if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(electronVersion)) {
  throw new Error('apps/desktop/package.json 必须固定 Electron 的完整版本号');
}

const rebuildMain = workspaceRequire.resolve('@electron/rebuild');
const rebuildCli = path.join(path.dirname(rebuildMain), 'cli.js');
const electronExecutable = desktopRequire('electron');

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: desktopDirectory,
    env: process.env,
    shell: false,
    stdio: 'inherit',
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

// @electron/rebuild 的缓存标记可能在普通 Node 重建后失真，因此每次都强制重建。
run(process.execPath, [
  rebuildCli,
  '--force',
  '--only',
  'better-sqlite3',
  '--version',
  electronVersion,
  '--module-dir',
  desktopDirectory,
]);

const verification = run(
  electronExecutable,
  [
    '-e',
    [
      "const Database = require('better-sqlite3')",
      "const database = new Database(':memory:')",
      "const row = database.prepare('SELECT 1 AS value').get()",
      'database.close()',
      'if (row.value !== 1) process.exit(2)',
      'process.stdout.write(`NODE_MODULE_VERSION=${process.versions.modules}`)',
    ].join(';'),
  ],
  {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

console.log(`Electron 原生依赖 ABI 校验通过：${verification.stdout.trim()}`);
