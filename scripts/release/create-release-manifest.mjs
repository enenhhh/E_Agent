#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  fileSize,
  listFiles,
  parseArguments,
  resolveWorkspacePath,
  sha256File,
  toPortableRelativePath,
  workspaceRoot,
} from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const artifactsDirectory = resolveWorkspacePath(argumentsMap.get('directory'), 'artifacts');
const outputPath = resolveWorkspacePath(
  argumentsMap.get('output'),
  path.join(artifactsDirectory, 'release-manifest.json'),
);
const rootPackage = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
const ignoredNames = new Set(['release-manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig']);
const files = [];

for (const filePath of await listFiles(artifactsDirectory, {
  ignoredDirectories: new Set(),
})) {
  if (ignoredNames.has(path.basename(filePath))) {
    continue;
  }
  const portablePath = toPortableRelativePath(artifactsDirectory, filePath);
  files.push({
    path: portablePath,
    platform: portablePath.startsWith('windows/')
      ? 'windows'
      : portablePath.startsWith('macos/')
        ? 'macos'
        : portablePath.startsWith('linux/')
          ? 'linux'
          : 'platform-independent',
    bytes: await fileSize(filePath),
    sha256: await sha256File(filePath),
  });
}

files.sort((left, right) => left.path.localeCompare(right.path));
if (files.length === 0) {
  throw new Error('发布目录中没有产物。');
}

const manifest = {
  schemaVersion: 1,
  product: 'E Agent',
  version: rootPackage.version,
  gitCommit: process.env.GITHUB_SHA ?? process.env.E_AGENT_GIT_COMMIT ?? null,
  generatedAt: new Date().toISOString(),
  files,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`发布清单已生成：${outputPath}`);
