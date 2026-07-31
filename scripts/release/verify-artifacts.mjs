#!/usr/bin/env node

import { createPublicKey, verify } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isPathInside,
  parseArguments,
  resolveWorkspacePath,
  sha256File,
} from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const artifactsDirectory = resolveWorkspacePath(argumentsMap.get('directory'), 'artifacts');
const checksumPath = resolveWorkspacePath(
  argumentsMap.get('checksums'),
  path.join(artifactsDirectory, 'SHA256SUMS'),
);
const checksumPayload = await readFile(checksumPath);
const checksumLines = checksumPayload.toString('utf8').split(/\r?\n/u).filter(Boolean);

if (checksumLines.length === 0) {
  throw new Error('SHA256SUMS 为空。');
}

for (const line of checksumLines) {
  const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/u);
  if (!match) {
    throw new Error('SHA256SUMS 格式无效。');
  }
  const expectedDigest = match[1];
  const relativePath = match[2];
  const artifactPath = path.resolve(artifactsDirectory, relativePath);
  if (!isPathInside(artifactsDirectory, artifactPath)) {
    throw new Error(`清单包含越界路径：${relativePath}`);
  }
  await access(artifactPath);
  const actualDigest = await sha256File(artifactPath);
  if (actualDigest !== expectedDigest) {
    throw new Error(`摘要不匹配：${relativePath}`);
  }
}

const publicKeyArgument = argumentsMap.get('public-key');
const signatureArgument = argumentsMap.get('signature');
if ((typeof publicKeyArgument === 'string') !== (typeof signatureArgument === 'string')) {
  throw new Error('--public-key 与 --signature 必须同时提供。');
}

if (typeof publicKeyArgument === 'string' && typeof signatureArgument === 'string') {
  const publicKeyPath = resolveWorkspacePath(publicKeyArgument, publicKeyArgument);
  const signaturePath = resolveWorkspacePath(signatureArgument, signatureArgument);
  const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'));
  const signature = Buffer.from((await readFile(signaturePath, 'utf8')).trim(), 'base64');
  if (!verify('sha256', checksumPayload, publicKey, signature)) {
    throw new Error('发布清单签名无效。');
  }
  console.log('签名验证通过。');
}

console.log(`摘要验证通过：${checksumLines.length} 个发布文件。`);
