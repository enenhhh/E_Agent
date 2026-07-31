import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { PluginManifest } from '@e-agent/plugin-sdk';
import { z } from 'zod';

import { PluginRuntimeError } from './errors.js';

const approvalSchema = z
  .object({
    pluginId: z.string().min(1),
    version: z.string().min(1),
    permissionDigest: z.string().length(64),
    workspaceBindingDigest: z.string().length(64).optional(),
    approvedAt: z.string().datetime(),
  })
  .strict();

const approvalFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvals: z.array(approvalSchema),
  })
  .strict();

type Approval = z.infer<typeof approvalSchema>;

/**
 * 持久化用户对特定插件版本、权限集合及工作区边界的批准。
 *
 * 授权文件只保存规范化工作区根目录的 SHA-256 绑定，不保存工作区明文路径。
 * Manifest、版本或工作区变化后，旧批准都不会被继承。
 */
export class PermissionStore {
  private readonly approvals = new Map<string, Approval>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  /**
   * 从磁盘读取批准记录；文件不存在时使用空记录。
   */
  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loadPromise ??= this.loadFromDisk();
    await this.loadPromise;
  }

  /**
   * 记录用户对当前插件 Manifest 与工作区边界的明确批准。
   */
  public async approve(manifest: PluginManifest, workspaceRoot?: string): Promise<void> {
    const workspaceBindingDigest = await resolveWorkspaceBindingDigest(
      manifest,
      workspaceRoot,
      true,
    );
    await this.mutate((approvals) => {
      approvals.set(manifest.id, {
        pluginId: manifest.id,
        version: manifest.version,
        permissionDigest: permissionDigest(manifest),
        ...(workspaceBindingDigest === undefined ? {} : { workspaceBindingDigest }),
        approvedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * 撤销插件的全部能力批准。
   */
  public async revoke(pluginId: string): Promise<void> {
    await this.revokeMany([pluginId]);
  }

  /**
   * 在一次原子文件替换中撤销一组插件，供工作区切换时 fail-closed 地失效旧授权。
   */
  public async revokeMany(pluginIds: readonly string[]): Promise<void> {
    const uniquePluginIds = [...new Set(pluginIds)];
    if (uniquePluginIds.length === 0) {
      return;
    }
    await this.mutate((approvals) => {
      for (const pluginId of uniquePluginIds) {
        approvals.delete(pluginId);
      }
    });
  }

  /**
   * 判断版本、权限集合和工作区绑定是否仍与批准时完全一致。
   */
  public async isApproved(manifest: PluginManifest, workspaceRoot?: string): Promise<boolean> {
    await this.load();
    const workspaceBindingDigest = await resolveWorkspaceBindingDigest(
      manifest,
      workspaceRoot,
      false,
    );
    if (usesWorkspacePermission(manifest) && workspaceBindingDigest === undefined) {
      return false;
    }
    return this.runSerialized(() => {
      const approval = this.approvals.get(manifest.id);
      return (
        approval?.version === manifest.version &&
        approval.permissionDigest === permissionDigest(manifest) &&
        approval.workspaceBindingDigest === workspaceBindingDigest
      );
    });
  }

  /**
   * 在能力代理执行前强制检查批准状态与工作区绑定。
   */
  public async assertApproved(manifest: PluginManifest, workspaceRoot?: string): Promise<void> {
    if (!(await this.isApproved(manifest, workspaceRoot))) {
      throw new PluginRuntimeError(
        'CAPABILITY_DENIED',
        `插件 ${manifest.name} 的权限尚未批准，或其版本、权限、工作区已变化`,
      );
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = approvalFileSchema.parse(JSON.parse(raw) as unknown);
      for (const approval of parsed.approvals) {
        this.approvals.set(approval.pluginId, approval);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
    this.loaded = true;
  }

  private async mutate(mutator: (approvals: Map<string, Approval>) => void): Promise<void> {
    await this.runSerialized(async () => {
      await this.load();
      const nextApprovals = new Map(this.approvals);
      mutator(nextApprovals);
      await this.persist(nextApprovals);
      this.approvals.clear();
      for (const [pluginId, approval] of nextApprovals) {
        this.approvals.set(pluginId, approval);
      }
    });
  }

  private runSerialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const current = this.mutationTail.then(operation, operation);
    this.mutationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async persist(approvals: ReadonlyMap<string, Approval>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const body = JSON.stringify(
      {
        schemaVersion: 1,
        approvals: [...approvals.values()],
      },
      null,
      2,
    );
    await writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

/**
 * 计算稳定的权限摘要，避免插件更新后沿用旧授权。
 */
export function permissionDigest(manifest: PluginManifest): string {
  const normalized = stableStringify(manifest.permissions);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 判断插件是否声明了随工作区变化的文件能力。
 */
export function usesWorkspacePermission(manifest: PluginManifest): boolean {
  const fileSystem = manifest.permissions.fileSystem;
  return [...(fileSystem?.read ?? []), ...(fileSystem?.write ?? [])].some((scope) => {
    const normalizedScope = scope.replaceAll('\\', '/');
    return normalizedScope === '${workspace}' || normalizedScope.startsWith('${workspace}/');
  });
}

/**
 * 将工作区根目录解析为稳定的真实路径；Windows 上忽略路径大小写差异。
 */
export async function normalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  return process.platform === 'win32' ? canonicalRoot.toLocaleLowerCase('en-US') : canonicalRoot;
}

async function resolveWorkspaceBindingDigest(
  manifest: PluginManifest,
  workspaceRoot: string | undefined,
  required: boolean,
): Promise<string | undefined> {
  if (!usesWorkspacePermission(manifest)) {
    return undefined;
  }
  if (workspaceRoot === undefined) {
    if (required) {
      throw new PluginRuntimeError(
        'CAPABILITY_DENIED',
        '插件声明了 ${workspace} 权限，请先选择工作区再授权',
      );
    }
    return undefined;
  }
  try {
    const normalizedRoot = await normalizeWorkspaceRoot(workspaceRoot);
    return createHash('sha256')
      .update('e-agent:workspace-binding:v1\0')
      .update(normalizedRoot)
      .digest('hex');
  } catch {
    if (required) {
      throw new PluginRuntimeError('CAPABILITY_DENIED', '工作区目录无法规范化，插件授权未保存');
    }
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
