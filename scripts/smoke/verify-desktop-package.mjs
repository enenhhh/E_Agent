#!/usr/bin/env node

import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFile, listPackage } from '@electron/asar';

import { parseArguments, resolveWorkspacePath } from '../lib/workspace.mjs';
import { scanText } from '../security/secret-scan.mjs';

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const forbiddenEntryRules = [
  {
    id: 'coverage',
    expression: /(?:^|\/)coverage(?:\/|$)/u,
  },
  {
    id: 'turbo-cache',
    expression: /(?:^|\/)\.turbo(?:\/|$)/u,
  },
  {
    id: 'test-directory',
    expression: /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u,
  },
  {
    id: 'test-file',
    expression: /\.(?:test|spec)\.[^/]+$/u,
  },
  {
    id: 'development-artifact',
    expression: /\.(?:log|map|tsbuildinfo)$/u,
  },
  {
    id: 'workspace-source',
    expression: /^node_modules\/@e-agent\/[^/]+\/src(?:\/|$)/u,
  },
  {
    id: 'sensitive-file',
    expression:
      /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:db(?:-.+)?|enc|jks|key|keystore|pem|pfx|sqlite(?:-.+)?|sqlite3(?:-.+)?))$/iu,
  },
];

/** 将 ASAR 平台路径规范化为稳定的 POSIX 相对路径。 */
export function normalizeAsarEntry(entry) {
  if (typeof entry !== 'string') {
    throw new TypeError('ASAR 条目必须是字符串。');
  }
  return entry.replace(/^[/\\]+/u, '').replaceAll('\\', '/');
}

/**
 * 拒绝把测试、覆盖率、源码映射、工作区源码或敏感文件打入生产 ASAR。
 *
 * @returns {string[]} 规范化后的条目
 */
export function validateDesktopAsarEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('桌面 app.asar 为空或无法读取。');
  }
  const normalizedEntries = entries.map(normalizeAsarEntry);
  const violations = [];
  for (const entry of normalizedEntries) {
    for (const rule of forbiddenEntryRules) {
      if (rule.expression.test(entry)) {
        violations.push(`${entry} [${rule.id}]`);
        break;
      }
    }
  }
  if (violations.length > 0) {
    const preview = violations.slice(0, 12).join('\n- ');
    throw new Error(
      `桌面 app.asar 包含 ${violations.length} 个禁止的开发或敏感条目：\n- ${preview}`,
    );
  }
  return normalizedEntries;
}

async function findAsarFiles(directory) {
  const results = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === 'app.asar' &&
        path.basename(path.dirname(entryPath)).toLocaleLowerCase('en-US') === 'resources'
      ) {
        results.push(entryPath);
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

/** 对一个已生成的 app.asar 做路径与密钥只读校验。 */
export async function verifyDesktopAsar(asarPath) {
  await access(asarPath);
  const rawEntries = listPackage(asarPath);
  const normalizedEntries = validateDesktopAsarEntries(rawEntries);
  const directoryEntries = new Set();
  for (const entry of normalizedEntries) {
    const segments = entry.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directoryEntries.add(segments.slice(0, index).join('/'));
    }
  }
  const secretFindings = [];
  for (let index = 0; index < normalizedEntries.length; index += 1) {
    const normalizedEntry = normalizedEntries[index];
    const rawEntry = rawEntries[index];
    if (
      normalizedEntry === undefined ||
      rawEntry === undefined ||
      directoryEntries.has(normalizedEntry) ||
      !textExtensions.has(path.extname(normalizedEntry).toLocaleLowerCase('en-US'))
    ) {
      continue;
    }
    const extractionPath = rawEntry.replace(/^[/\\]+/u, '');
    const contents = extractFile(asarPath, extractionPath);
    if (contents.length > 5 * 1024 * 1024) continue;
    secretFindings.push(...scanText(contents.toString('utf8'), normalizedEntry));
  }
  if (secretFindings.length > 0) {
    const preview = secretFindings
      .slice(0, 12)
      .map((finding) => `${finding.file}:${finding.line} [${finding.rule}]`)
      .join('\n- ');
    throw new Error(`桌面 app.asar 包含 ${secretFindings.length} 个疑似明文密钥：\n- ${preview}`);
  }
  return {
    asarPath,
    entryCount: normalizedEntries.length,
  };
}

export async function main(argumentsList = process.argv.slice(2)) {
  const argumentsMap = parseArguments(argumentsList);
  const allowedArguments = new Set(['asar', 'directory']);
  for (const name of argumentsMap.keys()) {
    if (!allowedArguments.has(name)) throw new Error(`无法识别的参数：--${name}`);
  }
  if (argumentsMap.has('asar') && argumentsMap.has('directory')) {
    throw new Error('--asar 与 --directory 不能同时使用。');
  }
  const asarArgument = argumentsMap.get('asar');
  const asarFiles =
    typeof asarArgument === 'string'
      ? [resolveWorkspacePath(asarArgument, '')]
      : await findAsarFiles(resolveWorkspacePath(argumentsMap.get('directory'), 'release'));
  if (asarFiles.length === 0) {
    throw new Error('未找到已生成的 resources/app.asar。');
  }
  for (const asarPath of asarFiles) {
    const result = await verifyDesktopAsar(asarPath);
    console.log(
      `桌面生产包只读验证通过：${path.relative(process.cwd(), result.asarPath)} (${result.entryCount} entries)`,
    );
  }
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
