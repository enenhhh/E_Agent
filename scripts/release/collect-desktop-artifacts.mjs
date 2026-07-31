#!/usr/bin/env node

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseArguments, resolveWorkspacePath } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const sourceDirectory = resolveWorkspacePath(argumentsMap.get('source'), 'release');
const outputDirectory = resolveWorkspacePath(argumentsMap.get('output'), 'artifacts/desktop');
const installerExtensions = new Set([
  '.appimage',
  '.blockmap',
  '.deb',
  '.dmg',
  '.exe',
  '.msi',
  '.pkg',
  '.rpm',
  '.snap',
  '.zip',
]);
const updateMetadataPattern = /^(?:latest|alpha|beta)(?:-[a-z0-9._-]+)?\.ya?ml$/iu;
const entries = await readdir(sourceDirectory, { withFileTypes: true });
const selectedFiles = entries
  .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
  .map((entry) => path.join(sourceDirectory, entry.name))
  .filter((filePath) => {
    const name = path.basename(filePath);
    const lowerCaseName = name.toLowerCase();
    return (
      installerExtensions.has(path.extname(lowerCaseName)) ||
      lowerCaseName.endsWith('.tar.gz') ||
      updateMetadataPattern.test(name)
    );
  })
  .sort((left, right) => left.localeCompare(right));

if (selectedFiles.length === 0) {
  throw new Error(`桌面构建目录没有可发布文件：${sourceDirectory}`);
}

await mkdir(outputDirectory, { recursive: true });
for (const selectedFile of selectedFiles) {
  const targetPath = path.join(outputDirectory, path.basename(selectedFile));
  await copyFile(selectedFile, targetPath);
  console.log(`已收集：${path.basename(selectedFile)}`);
}
