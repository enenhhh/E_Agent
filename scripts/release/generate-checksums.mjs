#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  listFiles,
  parseArguments,
  resolveWorkspacePath,
  sha256File,
  toPortableRelativePath,
} from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const artifactsDirectory = resolveWorkspacePath(argumentsMap.get('directory'), 'artifacts');
const outputPath = resolveWorkspacePath(
  argumentsMap.get('output'),
  path.join(artifactsDirectory, 'SHA256SUMS'),
);

await mkdir(artifactsDirectory, { recursive: true });
const excludedNames = new Set([path.basename(outputPath), `${path.basename(outputPath)}.sig`]);
const artifactFiles = (
  await listFiles(artifactsDirectory, {
    ignoredDirectories: new Set(),
  })
).filter((filePath) => !excludedNames.has(path.basename(filePath)));

if (artifactFiles.length === 0) {
  throw new Error(`没有可校验的发布产物：${artifactsDirectory}`);
}

const lines = [];
for (const artifactFile of artifactFiles) {
  lines.push(
    `${await sha256File(artifactFile)}  ${toPortableRelativePath(
      artifactsDirectory,
      artifactFile,
    )}`,
  );
}
lines.sort();

const temporaryPath = `${outputPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${lines.join('\n')}\n`, 'utf8');
await rename(temporaryPath, outputPath);
console.log(`已生成 ${lines.length} 个文件的 SHA-256 清单：${outputPath}`);
