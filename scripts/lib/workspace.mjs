import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const workspaceRoot = path.resolve(currentDirectory, '..', '..');

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  'artifacts',
  'blob-report',
  'coverage',
  'data',
  'dist',
  'logs',
  'node_modules',
  'out',
  'playwright-report',
  'release',
  'test-results',
]);

/**
 * 递归枚举目录中的普通文件，并跳过构建产物与依赖缓存。
 *
 * @param {string} rootDirectory 枚举起点
 * @param {{ ignoredDirectories?: Set<string> }} options 枚举选项
 * @returns {Promise<string[]>} 绝对文件路径
 */
export async function listFiles(rootDirectory, options = {}) {
  const ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await visit(rootDirectory);
  return files;
}

/**
 * 计算文件的 SHA-256 摘要。
 *
 * @param {string} filePath 文件路径
 * @returns {Promise<string>} 小写十六进制摘要
 */
export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 将任意平台路径转换为发布清单使用的 POSIX 相对路径。
 *
 * @param {string} baseDirectory 基准目录
 * @param {string} filePath 文件路径
 * @returns {string} POSIX 相对路径
 */
export function toPortableRelativePath(baseDirectory, filePath) {
  return path.relative(baseDirectory, filePath).split(path.sep).join('/');
}

/**
 * 判断候选路径是否严格位于指定目录内，防止路径穿越。
 *
 * @param {string} baseDirectory 基准目录
 * @param {string} candidatePath 候选路径
 * @returns {boolean} 是否安全
 */
export function isPathInside(baseDirectory, candidatePath) {
  const relativePath = path.relative(path.resolve(baseDirectory), path.resolve(candidatePath));
  return (
    relativePath !== '' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}

/**
 * 获取文件大小；非普通文件会抛出错误。
 *
 * @param {string} filePath 文件路径
 * @returns {Promise<number>} 字节数
 */
export async function fileSize(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`不是普通文件：${filePath}`);
  }
  return fileStat.size;
}

/**
 * 读取简单的 --name value 或 --flag 命令行参数。
 *
 * @param {string[]} argumentsList 参数列表
 * @returns {Map<string, string | true>} 参数映射
 */
export function parseArguments(argumentsList) {
  const parsed = new Map();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument?.startsWith('--')) {
      throw new Error(`无法识别的参数：${argument}`);
    }
    const separatorIndex = argument.indexOf('=');
    if (separatorIndex > 2) {
      parsed.set(argument.slice(2, separatorIndex), argument.slice(separatorIndex + 1));
      continue;
    }
    const name = argument.slice(2);
    const nextArgument = argumentsList[index + 1];
    if (nextArgument && !nextArgument.startsWith('--')) {
      parsed.set(name, nextArgument);
      index += 1;
    } else {
      parsed.set(name, true);
    }
  }
  return parsed;
}

/**
 * 将命令行路径解析为绝对路径。
 *
 * @param {string | true | undefined} value 参数值
 * @param {string} fallback 相对工作区的默认路径
 * @returns {string} 绝对路径
 */
export function resolveWorkspacePath(value, fallback) {
  const selectedValue = typeof value === 'string' ? value : fallback;
  return path.resolve(workspaceRoot, selectedValue);
}
