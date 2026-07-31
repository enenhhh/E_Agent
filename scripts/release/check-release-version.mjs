#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateDesktopInstallerConfig } from '../lib/desktop-installer-config.mjs';
import { parseArguments, workspaceRoot } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const versionArgument = argumentsMap.get('version');
if (typeof versionArgument !== 'string') {
  throw new Error('必须通过 --version 提供发布版本。');
}
const normalizedVersion = versionArgument.replace(/^v/u, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalizedVersion)) {
  throw new Error(`发布版本不是有效的 SemVer：${versionArgument}`);
}

const rootPackage = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
if (rootPackage.version !== normalizedVersion) {
  throw new Error(
    `版本不一致：触发版本为 ${normalizedVersion}，package.json 为 ${rootPackage.version}。`,
  );
}
const installerConfig = await validateDesktopInstallerConfig();
if (installerConfig.version !== normalizedVersion) {
  throw new Error(
    `桌面安装器版本不一致：触发版本为 ${normalizedVersion}，产品版本为 ${installerConfig.version}。`,
  );
}
console.log(`发布版本校验通过：${normalizedVersion}`);
