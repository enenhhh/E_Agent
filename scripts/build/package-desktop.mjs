#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopDirectory = path.join(workspaceRoot, 'apps', 'desktop');
const turboEntry = path.join(workspaceRoot, 'node_modules', 'turbo', 'bin', 'turbo');
const builderEntry = path.join(
  desktopDirectory,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);
const iconGenerator = path.join(workspaceRoot, 'scripts', 'assets', 'generate-icons.mjs');
const electronNativePreparer = path.join(
  workspaceRoot,
  'scripts',
  'build',
  'prepare-electron-native.mjs',
);
const nodeNativePreparer = path.join(workspaceRoot, 'scripts', 'build', 'prepare-node-native.mjs');
const installerValidator = path.join(
  workspaceRoot,
  'scripts',
  'ci',
  'validate-desktop-installer.mjs',
);

function runNode(entry, argumentsList, cwd = workspaceRoot) {
  if (!existsSync(entry)) {
    throw new Error(`缺少打包工具：${entry}，请先运行 pnpm install --frozen-lockfile`);
  }
  const result = spawnSync(process.execPath, [entry, ...argumentsList], {
    cwd,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`子进程执行失败（退出码 ${result.status ?? 1}）`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const builderArguments = process.argv.slice(2).filter((argument) => argument !== '--');
let exitCode = 0;

try {
  // 安装器校验依赖由该脚本生成的图标与原生 BMP 资源，干净环境中必须先生成资源。
  runNode(iconGenerator, []);
  runNode(installerValidator, []);
  // extraResources 不属于 Desktop 的依赖图，必须在打包前显式生成。
  runNode(turboEntry, [
    'run',
    'build',
    '--filter=@e-agent/plugin-host',
    '--filter=@e-agent/plugin-code-review',
    '--filter=@e-agent/plugin-builtin-skills',
  ]);
  runNode(turboEntry, ['run', 'build', '--filter=@e-agent/desktop']);
  runNode(electronNativePreparer, []);
  runNode(builderEntry, ['--publish', 'never', ...builderArguments], desktopDirectory);
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
  // 打包结束后恢复普通 Node ABI，避免后续开发、单测因原生模块版本不匹配而失败。
  try {
    runNode(nodeNativePreparer, []);
  } catch (error) {
    exitCode = exitCode || 1;
    console.error(
      '恢复 Node 原生依赖失败：',
      error instanceof Error ? error.message : String(error),
    );
  }
}

process.exitCode = exitCode;
