#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listFiles,
  parseArguments,
  resolveWorkspacePath,
  workspaceRoot,
} from '../lib/workspace.mjs';

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.appimage',
  '.avif',
  '.bin',
  '.bmp',
  '.db',
  '.dmg',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.sqlite',
  '.tar',
  '.tgz',
  '.ttf',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const SECRET_PATTERNS = [
  {
    id: 'private-key',
    expression: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'openai-compatible-key',
    expression: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'github-token',
    expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'google-api-key',
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    expression: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g,
  },
  {
    id: 'aws-access-key',
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
];

const SAFE_ENV_VALUE_PATTERNS = [
  /^$/,
  /^\$\{/,
  /^\{\{/,
  /^<.+>$/,
  /^(?:change-me|example|placeholder|redacted|replace-|your-)/i,
  /^(?:false|true|null|undefined)$/i,
];

function isClearlySyntheticSecret(value) {
  const normalized = value.toLowerCase();
  if (
    normalized.startsWith('sk-test-') ||
    normalized.startsWith('sk-fake-') ||
    normalized.startsWith('sk-dummy-') ||
    normalized.includes('example')
  ) {
    return true;
  }
  const body = normalized.replace(/^sk-(?:proj-|svcacct-)?/u, '');
  return body.includes('abcdefghijklmnopqrstuvwxyz') || /^([a-z0-9])\1{19,}$/u.test(body);
}

/**
 * 扫描文本并仅返回规则与位置，绝不回显疑似密钥。
 *
 * @param {string} content 文件内容
 * @param {string} relativePath 相对路径
 * @returns {{ file: string; line: number; rule: string }[]} 命中列表
 */
export function scanText(content, relativePath) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of content.matchAll(pattern.expression)) {
      if (isClearlySyntheticSecret(match[0])) {
        continue;
      }
      const matchedIndex = match.index ?? 0;
      findings.push({
        file: relativePath,
        line: content.slice(0, matchedIndex).split(/\r?\n/u).length,
        rule: pattern.id,
      });
    }
  }

  if (path.basename(relativePath).startsWith('.env')) {
    const lines = content.split(/\r?\n/u);
    for (const [lineIndex, line] of lines.entries()) {
      const assignment = line.match(
        /^\s*[A-Z0-9_]*(?:API_KEY|MASTER_KEY|PASSWORD|SECRET|TOKEN)\s*=\s*(.*?)\s*$/u,
      );
      if (!assignment) {
        continue;
      }
      const value = (assignment[1] ?? '').replace(/^['"]|['"]$/gu, '');
      if (!SAFE_ENV_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
        findings.push({
          file: relativePath,
          line: lineIndex + 1,
          rule: 'committed-env-secret',
        });
      }
    }
  }
  return findings;
}

/**
 * 扫描一个目录，忽略二进制文件和生成目录。
 *
 * @param {string} scanRoot 扫描目录
 * @returns {Promise<{ file: string; line: number; rule: string }[]>} 命中列表
 */
export async function scanDirectory(scanRoot) {
  const findings = [];
  for (const filePath of await listFiles(scanRoot)) {
    if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      continue;
    }
    const content = await readFile(filePath, 'utf8');
    const relativePath = path.relative(scanRoot, filePath).split(path.sep).join('/');
    findings.push(...scanText(content, relativePath));
  }
  return findings;
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const scanRoot = resolveWorkspacePath(argumentsMap.get('root'), '.');
  const findings = await scanDirectory(scanRoot);

  if (findings.length > 0) {
    console.error(`密钥扫描失败：发现 ${findings.length} 个疑似敏感值。`);
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.rule}]`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `密钥扫描通过：${path.relative(workspaceRoot, scanRoot) || '.'} 未发现已知密钥格式。`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
