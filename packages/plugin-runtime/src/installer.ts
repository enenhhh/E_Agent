import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { parsePluginManifest, type PluginManifest } from '@e-agent/plugin-sdk';

import { PluginRuntimeError, toSafeErrorMessage } from './errors.js';

export type PluginInstallSource =
  | { type: 'directory'; path: string }
  | { type: 'git'; url: string; ref?: string };

export interface InstalledPlugin {
  root: string;
  manifest: PluginManifest;
  integrity: string;
}

export interface PluginInstallerOptions {
  pluginsDirectory: string;
  maximumFiles?: number;
  maximumBytes?: number;
}

/**
 * 对本地目录或 HTTPS Git 仓库执行校验后原子安装。
 */
export class PluginInstaller {
  private readonly operations = new Map<string, Promise<InstalledPlugin>>();
  private readonly maximumFiles: number;
  private readonly maximumBytes: number;

  public constructor(private readonly options: PluginInstallerOptions) {
    this.maximumFiles = options.maximumFiles ?? 10_000;
    this.maximumBytes = options.maximumBytes ?? 100 * 1024 * 1024;
  }

  /**
   * 安装插件。相同源的并发请求会合并为同一操作。
   */
  public async install(source: PluginInstallSource): Promise<InstalledPlugin> {
    const key = source.type === 'directory' ? resolve(source.path) : source.url;
    const existing = this.operations.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const operation = this.performInstall(source).finally(() => {
      this.operations.delete(key);
    });
    this.operations.set(key, operation);
    return operation;
  }

  /**
   * 枚举全部已安装且清单有效的插件。
   */
  public async list(): Promise<readonly InstalledPlugin[]> {
    await mkdir(this.options.pluginsDirectory, { recursive: true });
    const entries = await readdir(this.options.pluginsDirectory, {
      withFileTypes: true,
    });
    const results: InstalledPlugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      try {
        results.push(await this.inspect(join(this.options.pluginsDirectory, entry.name)));
      } catch {
        // 单个损坏插件不阻断管理器启动。
      }
    }
    return results;
  }

  /**
   * 读取并重新校验一个已安装插件。
   */
  public async inspect(pluginRoot: string): Promise<InstalledPlugin> {
    const canonicalRoot = resolve(pluginRoot);
    const manifestPath = join(canonicalRoot, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = parsePluginManifest(JSON.parse(raw) as unknown);
    const entry = resolve(canonicalRoot, manifest.entry);
    if (!isWithin(canonicalRoot, entry)) {
      throw new PluginRuntimeError('INSTALL_INVALID', '插件入口逃逸插件目录');
    }
    const entryStats = await stat(entry);
    if (!entryStats.isFile()) {
      throw new PluginRuntimeError('INSTALL_INVALID', '插件入口不是普通文件');
    }
    const integrity = await validateTree(canonicalRoot, this.maximumFiles, this.maximumBytes);
    return { root: canonicalRoot, manifest, integrity };
  }

  /**
   * 将插件移动到可恢复的回收目录，而不是直接删除。
   */
  public async uninstall(pluginId: string): Promise<string> {
    const source = resolve(this.options.pluginsDirectory, pluginId);
    if (!isWithin(resolve(this.options.pluginsDirectory), source)) {
      throw new PluginRuntimeError('INSTALL_INVALID', '非法插件标识');
    }
    const trashDirectory = resolve(this.options.pluginsDirectory, '.trash');
    await mkdir(trashDirectory, { recursive: true });
    const destination = join(
      trashDirectory,
      `${pluginId}-${new Date().toISOString().replaceAll(':', '-')}`,
    );
    await rename(source, destination);
    return destination;
  }

  private async performInstall(source: PluginInstallSource): Promise<InstalledPlugin> {
    await mkdir(this.options.pluginsDirectory, { recursive: true });
    const stagingRoot = resolve(this.options.pluginsDirectory, `.staging-${randomUUID()}`);
    const backupRoot = resolve(this.options.pluginsDirectory, `.backup-${randomUUID()}`);
    let destination: string | undefined;
    let hasBackup = false;

    try {
      if (source.type === 'directory') {
        const sourceRoot = resolve(source.path);
        if (
          sourceRoot === resolve(this.options.pluginsDirectory) ||
          isWithin(sourceRoot, resolve(this.options.pluginsDirectory))
        ) {
          throw new PluginRuntimeError('INSTALL_INVALID', '插件源目录不能包含插件安装目录');
        }
        await validateTree(sourceRoot, this.maximumFiles, this.maximumBytes);
        await cp(sourceRoot, stagingRoot, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (path) => !containsIgnoredDirectory(sourceRoot, path),
        });
      } else {
        validateGitUrl(source.url);
        await cloneRepository(source, stagingRoot);
      }

      const staged = await this.inspect(stagingRoot);
      destination = resolve(this.options.pluginsDirectory, staged.manifest.id);
      if (!isWithin(resolve(this.options.pluginsDirectory), destination)) {
        throw new PluginRuntimeError('INSTALL_INVALID', '非法插件标识');
      }
      try {
        await rename(destination, backupRoot);
        hasBackup = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await rename(stagingRoot, destination);
      if (hasBackup) {
        await rm(backupRoot, { recursive: true, force: true });
      }
      return this.inspect(destination);
    } catch (error) {
      if (destination !== undefined && hasBackup) {
        try {
          await rm(destination, { recursive: true, force: true });
          await rename(backupRoot, destination);
        } catch {
          // 保留原始错误；备份目录仍可由启动自检恢复。
        }
      }
      throw error instanceof PluginRuntimeError
        ? error
        : new PluginRuntimeError('INSTALL_INVALID', `插件安装失败：${toSafeErrorMessage(error)}`);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
      if (!hasBackup) {
        await rm(backupRoot, { recursive: true, force: true });
      }
    }
  }
}

async function validateTree(
  root: string,
  maximumFiles: number,
  maximumBytes: number,
): Promise<string> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new PluginRuntimeError('INSTALL_INVALID', '插件源必须是普通目录且不能是符号链接');
  }
  let files = 0;
  let bytes = 0;
  const hashes: Array<{ path: string; digest: string }> = [];
  const pending = [resolve(root)];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (['.git', 'coverage', 'node_modules'].includes(entry.name)) {
        continue;
      }
      const absolutePath = join(current, entry.name);
      const entryStats = await lstat(absolutePath);
      if (entryStats.isSymbolicLink()) {
        throw new PluginRuntimeError(
          'INSTALL_INVALID',
          `插件包含不允许的符号链接：${relative(root, absolutePath)}`,
        );
      }
      if (entryStats.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entryStats.isFile()) {
        throw new PluginRuntimeError(
          'INSTALL_INVALID',
          `插件包含不支持的文件类型：${relative(root, absolutePath)}`,
        );
      }
      files += 1;
      bytes += entryStats.size;
      if (files > maximumFiles || bytes > maximumBytes) {
        throw new PluginRuntimeError('INSTALL_INVALID', '插件超过安装文件数量或大小限制');
      }
      const handle = await open(absolutePath, 'r');
      try {
        const content = await handle.readFile();
        hashes.push({
          path: relative(root, absolutePath).replaceAll('\\', '/'),
          digest: createHash('sha256').update(content).digest('hex'),
        });
      } finally {
        await handle.close();
      }
    }
  }

  hashes.sort((left, right) => left.path.localeCompare(right.path));
  return createHash('sha256')
    .update(hashes.map(({ path, digest }) => `${path}\0${digest}\n`).join(''))
    .digest('hex');
}

function validateGitUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new PluginRuntimeError('INSTALL_INVALID', '仅允许不含凭据的 HTTPS Git 地址');
  }
}

async function cloneRepository(
  source: Extract<PluginInstallSource, { type: 'git' }>,
  destination: string,
): Promise<void> {
  const args = ['clone', '--depth', '1'];
  if (source.ref !== undefined) {
    args.push('--branch', source.ref);
  }
  args.push('--', source.url, destination);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_000) {
        stderr += chunk;
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`git clone 失败（${code ?? 'unknown'}）：${stderr}`));
      }
    });
  });
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function containsIgnoredDirectory(root: string, path: string): boolean {
  return relative(root, path)
    .split(/[\\/]/)
    .some((segment) => ['.git', 'coverage', 'node_modules'].includes(segment));
}
