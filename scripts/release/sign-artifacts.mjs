#!/usr/bin/env node

import { createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArguments, resolveWorkspacePath } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const checksumPath = resolveWorkspacePath(argumentsMap.get('checksums'), 'artifacts/SHA256SUMS');
const signaturePath = resolveWorkspacePath(argumentsMap.get('output'), `${checksumPath}.sig`);
const keyFileArgument = argumentsMap.get('key-file');
const keyFile =
  typeof keyFileArgument === 'string'
    ? resolveWorkspacePath(keyFileArgument, keyFileArgument)
    : process.env.E_AGENT_SIGNING_KEY_FILE;
const keyMaterial = process.env.E_AGENT_SIGNING_KEY
  ? process.env.E_AGENT_SIGNING_KEY.replaceAll('\\n', '\n')
  : keyFile
    ? await readFile(path.resolve(keyFile), 'utf8')
    : undefined;

if (!keyMaterial) {
  throw new Error('缺少签名私钥。请设置 E_AGENT_SIGNING_KEY 或 E_AGENT_SIGNING_KEY_FILE。');
}

const payload = await readFile(checksumPath);
const privateKey = createPrivateKey(keyMaterial);
const signature = sign('sha256', payload, privateKey).toString('base64');
await writeFile(signaturePath, `${signature}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`签名完成：${path.basename(checksumPath)} -> ${path.basename(signaturePath)}`);
