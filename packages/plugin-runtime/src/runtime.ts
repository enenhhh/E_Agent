import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { JsonValue, PluginManifest } from '@e-agent/plugin-sdk';
import { z } from 'zod';

import { CapabilityBroker } from './capability-broker.js';
import { PluginRuntimeError } from './errors.js';
import { PluginHostClient } from './host-client.js';
import { PluginInstaller, type InstalledPlugin, type PluginInstallSource } from './installer.js';
import {
  normalizeWorkspaceRoot,
  PermissionStore,
  usesWorkspacePermission,
} from './permission-store.js';

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.array(z.string().min(1)),
    disabledSkills: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface PluginRuntimeOptions {
  pluginsDirectory: string;
  dataDirectory: string;
  hostEntryPath: string;
  workspaceRoot?: string;
  developmentMode?: boolean;
  notify?: (title: string, body: string) => Promise<void>;
  log?: (
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, JsonValue>>,
  ) => void;
}

export interface PluginStatus {
  manifest: PluginManifest;
  integrity: string;
  enabled: boolean;
  approved: boolean;
}

/**
 * 协调插件安装、授权、独立宿主进程、调用和开发态热加载。
 */
export class PluginRuntime {
  private readonly installer: PluginInstaller;
  private readonly permissionStore: PermissionStore;
  private readonly hosts = new Map<string, PluginHostClient>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly enabled = new Set<string>();
  private readonly disabledSkills = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;

  public constructor(private readonly options: PluginRuntimeOptions) {
    this.installer = new PluginInstaller({
      pluginsDirectory: options.pluginsDirectory,
    });
    this.permissionStore = new PermissionStore(
      join(options.dataDirectory, 'plugin-permissions.json'),
    );
  }

  /**
   * 加载持久化状态并启动此前启用的插件。
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.options.dataDirectory, { recursive: true });
    if (this.options.workspaceRoot !== undefined) {
      try {
        this.options.workspaceRoot = await normalizeWorkspaceRoot(this.options.workspaceRoot);
      } catch {
        delete this.options.workspaceRoot;
        this.options.log?.('warn', '插件工作区根目录无效，已按未绑定状态启动');
      }
    }
    await this.permissionStore.load();
    const state = await this.readState();
    let stateChanged = false;
    for (const skillId of state.disabledSkills) {
      this.disabledSkills.add(skillId);
    }
    for (const pluginId of state.enabled) {
      this.enabled.add(pluginId);
      try {
        const plugin = await this.getInstalled(pluginId);
        if (
          usesWorkspacePermission(plugin.manifest) &&
          !(await this.permissionStore.isApproved(plugin.manifest, this.options.workspaceRoot))
        ) {
          this.enabled.delete(pluginId);
          stateChanged = true;
          this.options.log?.('warn', '插件工作区授权已失效，插件保持停用', {
            pluginId,
          });
          continue;
        }
        await this.startHost(pluginId);
      } catch (error) {
        this.options.log?.('error', '插件启动失败', {
          pluginId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    if (stateChanged) {
      await this.persistState();
    }
    this.initialized = true;
  }

  /**
   * 安装插件并返回校验后的状态；安装不会隐式批准权限或启用插件。
   */
  public async install(source: PluginInstallSource): Promise<PluginStatus> {
    return this.runExclusive(async () => {
      const plugin = await this.installer.install(source);
      if (this.hosts.has(plugin.manifest.id)) {
        await this.restart(plugin.manifest.id);
      }
      return this.toStatus(plugin);
    });
  }

  /**
   * 枚举插件状态。
   */
  public async list(): Promise<readonly PluginStatus[]> {
    const plugins = await this.installer.list();
    return Promise.all(plugins.map((plugin) => this.toStatus(plugin)));
  }

  /**
   * 仅供可信主进程适配器解析插件内资源，不应直接暴露给渲染进程或远程 API。
   */
  public async getPluginRoot(pluginId: string): Promise<string> {
    return (await this.getInstalled(pluginId)).root;
  }

  /**
   * 返回单个 Skill 的独立启用状态；插件级停用仍由 PluginStatus.enabled 表达。
   */
  public isSkillEnabled(skillId: string): boolean {
    return !this.disabledSkills.has(skillId);
  }

  /**
   * 独立启停一个 Skill，不影响同一插件贡献的其他 Skill。
   */
  public async setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
    await this.runExclusive(async () => {
      const owner = (await this.installer.list()).find((plugin) =>
        plugin.manifest.contributes.skills?.some((skill) => skill.id === skillId),
      );
      if (owner === undefined) {
        throw new PluginRuntimeError('PLUGIN_NOT_FOUND', 'Skill 不存在');
      }
      if (enabled) {
        this.disabledSkills.delete(skillId);
      } else {
        this.disabledSkills.add(skillId);
      }
      await this.persistState();
    });
  }

  /**
   * 记录用户批准当前插件清单声明的全部权限。
   */
  public async approve(pluginId: string): Promise<void> {
    await this.runExclusive(async () => {
      const plugin = await this.getInstalled(pluginId);
      await this.permissionStore.approve(plugin.manifest, this.options.workspaceRoot);
    });
  }

  /**
   * 撤销插件权限；运行中的插件继续存在，但后续能力调用会被拒绝。
   */
  public async revoke(pluginId: string): Promise<void> {
    await this.runExclusive(() => this.permissionStore.revoke(pluginId));
  }

  /**
   * 启用插件并启动独立宿主。
   */
  public async enable(pluginId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.startHost(pluginId);
      this.enabled.add(pluginId);
      await this.persistState();
    });
  }

  /**
   * 停用插件并终止宿主。
   */
  public async disable(pluginId: string): Promise<void> {
    await this.runExclusive(() => this.disableUnlocked(pluginId));
  }

  /**
   * 停用后将插件移动到回收目录。
   */
  public async uninstall(pluginId: string): Promise<string> {
    return this.runExclusive(async () => {
      const plugin = await this.getInstalled(pluginId);
      await this.disableUnlocked(pluginId);
      await this.permissionStore.revoke(pluginId);
      for (const skill of plugin.manifest.contributes.skills ?? []) {
        this.disabledSkills.delete(skill.id);
      }
      await this.persistState();
      return this.installer.uninstall(pluginId);
    });
  }

  /**
   * 调用插件注册项。
   */
  public async invoke(
    pluginId: string,
    target: 'command' | 'hook' | 'provider',
    id: string,
    input: JsonValue,
  ): Promise<JsonValue | undefined> {
    const host = this.hosts.get(pluginId);
    if (host === undefined) {
      throw new PluginRuntimeError('PLUGIN_DISABLED', `插件 ${pluginId} 未启用`);
    }
    return host.invoke(target, id, input);
  }

  /**
   * 关闭全部插件宿主和文件监听器。
   */
  public async shutdown(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    await Promise.allSettled([...this.hosts.values()].map((host) => host.stop()));
    this.hosts.clear();
  }

  /**
   * 更新工作区根目录；所有引用 ${workspace} 的插件会先撤权再停用并要求重新批准。
   */
  public async setWorkspaceRoot(root: string | undefined): Promise<void> {
    await this.runExclusive(async () => {
      const normalizedRoot = root === undefined ? undefined : await normalizeWorkspaceRoot(root);
      if (normalizedRoot === this.options.workspaceRoot) {
        return;
      }

      const workspacePlugins = (await this.installer.list()).filter((plugin) =>
        usesWorkspacePermission(plugin.manifest),
      );
      const workspacePluginIds = workspacePlugins.map((plugin) => plugin.manifest.id);

      // 先原子撤权，使仍在退出中的旧 host 也会被能力代理拒绝。
      await this.permissionStore.revokeMany(workspacePluginIds);

      const stopResults = await Promise.allSettled(
        workspacePluginIds.map(async (pluginId) => {
          this.watchers.get(pluginId)?.close();
          this.watchers.delete(pluginId);
          const host = this.hosts.get(pluginId);
          this.hosts.delete(pluginId);
          this.enabled.delete(pluginId);
          await host?.stop();
        }),
      );

      if (normalizedRoot === undefined) {
        delete this.options.workspaceRoot;
      } else {
        this.options.workspaceRoot = normalizedRoot;
      }
      await this.persistState();

      const failedStops = stopResults.filter((result) => result.status === 'rejected');
      if (failedStops.length > 0) {
        this.options.log?.('error', '工作区切换时部分插件 host 未正常退出，授权已安全撤销', {
          failures: failedStops.length,
        });
        throw new PluginRuntimeError(
          'HOST_CRASHED',
          '工作区已切换且旧插件授权已撤销，但部分插件进程未正常退出',
        );
      }
    });
  }

  private async disableUnlocked(pluginId: string): Promise<void> {
    this.watchers.get(pluginId)?.close();
    this.watchers.delete(pluginId);
    const host = this.hosts.get(pluginId);
    await host?.stop();
    this.hosts.delete(pluginId);
    this.enabled.delete(pluginId);
    await this.persistState();
  }

  private async startHost(pluginId: string): Promise<void> {
    if (this.hosts.has(pluginId)) {
      return;
    }
    const plugin = await this.getInstalled(pluginId);
    const dataDirectory = resolve(this.options.dataDirectory, pluginId);
    await mkdir(dataDirectory, { recursive: true });
    const brokerOptions = {
      manifest: plugin.manifest,
      pluginRoot: plugin.root,
      pluginDataRoot: dataDirectory,
      permissionStore: this.permissionStore,
      ...(this.options.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: this.options.workspaceRoot }),
      ...(this.options.notify === undefined ? {} : { notify: this.options.notify }),
    };
    const broker = new CapabilityBroker(brokerOptions);
    const host = new PluginHostClient({
      hostEntryPath: this.options.hostEntryPath,
      pluginEntryPath: resolve(plugin.root, plugin.manifest.entry),
      pluginRoot: plugin.root,
      dataDirectory,
      manifest: plugin.manifest,
      onCapabilityRequest: (event) => broker.handle(event),
      ...(this.options.log === undefined ? {} : { onLog: this.options.log }),
    });
    await host.start();
    this.hosts.set(pluginId, host);
    if (this.options.developmentMode === true) {
      this.watchPlugin(plugin);
    }
  }

  private watchPlugin(plugin: InstalledPlugin): void {
    this.watchers.get(plugin.manifest.id)?.close();
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(plugin.root, { recursive: true }, () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void this.restart(plugin.manifest.id).catch((error: unknown) => {
          this.options.log?.('error', '插件热加载失败', {
            pluginId: plugin.manifest.id,
            error: error instanceof Error ? error.message : 'unknown',
          });
        });
      }, 300);
    });
    this.watchers.set(plugin.manifest.id, watcher);
  }

  private async restart(pluginId: string): Promise<void> {
    const wasEnabled = this.enabled.has(pluginId) || this.hosts.has(pluginId);
    this.watchers.get(pluginId)?.close();
    this.watchers.delete(pluginId);
    await this.hosts.get(pluginId)?.stop();
    this.hosts.delete(pluginId);
    if (wasEnabled) {
      await this.startHost(pluginId);
    }
  }

  private async getInstalled(pluginId: string): Promise<InstalledPlugin> {
    const root = resolve(this.options.pluginsDirectory, pluginId);
    try {
      return await this.installer.inspect(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginRuntimeError('PLUGIN_NOT_FOUND', `未找到插件 ${pluginId}`);
      }
      throw error;
    }
  }

  private async toStatus(plugin: InstalledPlugin): Promise<PluginStatus> {
    return {
      manifest: plugin.manifest,
      integrity: plugin.integrity,
      enabled: this.enabled.has(plugin.manifest.id),
      approved: await this.permissionStore.isApproved(plugin.manifest, this.options.workspaceRoot),
    };
  }

  private async readState(): Promise<z.infer<typeof stateSchema>> {
    try {
      const raw = await readFile(join(this.options.dataDirectory, 'plugin-state.json'), 'utf8');
      return stateSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.log?.('warn', '插件状态文件无效，已使用安全默认值');
      }
      return { schemaVersion: 1, enabled: [], disabledSkills: [] };
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true });
    const path = join(this.options.dataDirectory, 'plugin-state.json');
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          enabled: [...this.enabled].sort(),
          disabledSkills: [...this.disabledSkills].sort(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationTail.then(operation, operation);
    this.operationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
