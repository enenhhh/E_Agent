import { join } from 'node:path';

import type { PluginRuntime, PluginStatus } from '@e-agent/plugin-runtime';
import type { JsonValue } from '@e-agent/plugin-sdk';
import { SkillRegistry } from '@e-agent/skills';
import { dialog, ipcMain, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import type { z } from 'zod';

import { DesktopError, serializeDesktopError } from './services/errors.js';
import type { AppLogger } from './services/logger.js';
import type { NotificationService } from './services/notifications.js';
import type { SelfCheckReport } from './services/self-check.js';
import type { UpdateService } from './services/updater.js';
import { isSafeExternalUrl } from './services/url-policy.js';
import type { WorkspaceService } from './services/workspace.js';
import {
  applicationInvokeChannels,
  applicationInvokeSchemas,
  streamAbortSchema,
  streamStartSchema,
  type ApplicationInvokeChannel,
  type ApplicationStreamChannel,
} from './shared/application-ipc.js';
import { desktopInvokeSchemas, type DesktopInvokeChannel, type IpcResult } from './shared/ipc.js';
import type { WindowManager } from './window-manager.js';

export type ApplicationHandlers = Partial<
  Record<ApplicationInvokeChannel, (input: unknown) => unknown | Promise<unknown>>
>;

export type ApplicationStreamHandlers = Partial<
  Record<
    ApplicationStreamChannel,
    (
      input: unknown,
      signal: AbortSignal,
    ) => AsyncIterable<JsonValue> | Promise<AsyncIterable<JsonValue>>
  >
>;

export interface IpcServices {
  windows: WindowManager;
  workspace: WorkspaceService;
  plugins: PluginRuntime;
  notifications: NotificationService;
  updates: UpdateService;
  logger: AppLogger;
  getSelfCheck: () => Promise<SelfCheckReport>;
  applicationHandlers?: ApplicationHandlers;
  applicationStreamHandlers?: ApplicationStreamHandlers;
}

type ChannelInput<C extends DesktopInvokeChannel> = z.output<(typeof desktopInvokeSchemas)[C]>;

/**
 * 注册所有采用输入 schema、发送者校验和统一错误封装的 IPC handler。
 */
export function registerIpcHandlers(services: IpcServices): () => void {
  const registered: DesktopInvokeChannel[] = [];
  const registeredNames = new Set<string>();

  const register = <C extends DesktopInvokeChannel, T>(
    channel: C,
    handler: (event: IpcMainInvokeEvent, input: ChannelInput<C>) => T | Promise<T>,
  ): void => {
    if (registeredNames.has(channel)) {
      throw new Error(`IPC handler 重复注册：${channel}`);
    }
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResult<T>> => {
        if (!services.windows.isTrustedSender(event.sender)) {
          services.logger.warn('拒绝不可信 IPC 发送者', { channel });
          return {
            ok: false,
            error: { code: 'UNTRUSTED_SENDER', message: '不可信的调用来源' },
          };
        }
        try {
          const input = desktopInvokeSchemas[channel].parse(payload ?? {}) as ChannelInput<C>;
          return { ok: true, data: await handler(event, input) };
        } catch (error) {
          const serialized = serializeDesktopError(error);
          services.logger.warn('IPC 操作失败', {
            channel,
            code: serialized.code,
          });
          return { ok: false, error: serialized };
        }
      },
    );
    registered.push(channel);
    registeredNames.add(channel);
  };

  register('system:self-check', () => services.getSelfCheck());
  register('system:notify', (_event, input) =>
    services.notifications.show(input.title, input.body),
  );
  register('system:open-external', async (_event, input) => {
    if (!isSafeExternalUrl(input.url)) {
      throw new Error('仅允许在系统浏览器打开 HTTP(S) 地址');
    }
    await shell.openExternal(input.url);
  });
  register('window:minimize', () => services.windows.get()?.minimize());
  register('window:toggle-maximize', () => {
    const window = services.windows.get();
    if (window?.isMaximized()) {
      window.unmaximize();
    } else {
      window?.maximize();
    }
  });
  register('window:close', () => services.windows.get()?.close());

  register('workspace:choose', async () => {
    await assertOwnerOrAdmin(services);
    const window = services.windows.get();
    const options: OpenDialogOptions = {
      title: '选择 E Agent 工作区',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result =
      window === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) {
      return services.workspace.getBinding() ?? null;
    }
    const binding = await services.workspace.bind(selected);
    await services.plugins.setWorkspaceRoot(binding.root);
    services.windows.emit('workspace:changed', {
      type: 'binding',
      binding,
    });
    return binding;
  });
  register('workspace:get-binding', async () => {
    await assertCanAccessWorkspace(services);
    return services.workspace.getBinding() ?? null;
  });
  register('workspace:list', async (_event, input) => {
    await assertCanAccessWorkspace(services);
    return services.workspace.list(input.path, input.depth);
  });
  register('workspace:read', async (_event, input) => {
    await assertCanAccessWorkspace(services);
    return services.workspace.read(input.path, input.maximumBytes);
  });
  register('workspace:propose-write', async (_event, input) => {
    await assertCanAccessWorkspace(services);
    return services.workspace.proposeWrite(input.path, input.content, input.expectedHash);
  });
  register('workspace:list-proposals', async () => {
    await assertCanAccessWorkspace(services);
    return services.workspace.listProposals();
  });
  register('workspace:apply-proposal', async (_event, input) => {
    await assertCanAccessWorkspace(services);
    return services.workspace.applyProposal(input.proposalId, input.acceptedChangeIds);
  });
  register('workspace:reject-proposal', async (_event, input) => {
    await assertCanAccessWorkspace(services);
    return services.workspace.rejectProposal(input.proposalId);
  });

  register('plugins:list', async () => {
    await sessionRole(services);
    return Promise.all((await services.plugins.list()).map(mapPluginStatus));
  });
  register('plugins:install', async (_event, input) => {
    await assertOwner(services);
    const source =
      'source' in input
        ? input.source.startsWith('https://')
          ? { type: 'git' as const, url: input.source }
          : { type: 'directory' as const, path: input.source }
        : input.type === 'directory'
          ? { type: 'directory' as const, path: input.path }
          : {
              type: 'git' as const,
              url: input.url,
              ...(input.ref === undefined ? {} : { ref: input.ref }),
            };
    const result = await services.plugins.install(source);
    services.windows.emit('plugins:changed', { type: 'installed' });
    return mapPluginStatus(result);
  });
  register('plugins:approve', async (_event, input) => {
    await assertOwner(services);
    await services.plugins.approve(input.pluginId);
    services.windows.emit('plugins:changed', { type: 'approved' });
  });
  register('plugins:revoke', async (_event, input) => {
    await assertOwnerOrAdmin(services);
    await services.plugins.revoke(input.pluginId);
    services.windows.emit('plugins:changed', { type: 'revoked' });
  });
  register('plugins:enable', async (_event, input) => {
    await assertOwnerOrAdmin(services);
    await services.plugins.enable(input.pluginId);
    services.windows.emit('plugins:changed', { type: 'enabled' });
  });
  register('plugins:disable', async (_event, input) => {
    await assertOwnerOrAdmin(services);
    await services.plugins.disable(input.pluginId);
    services.windows.emit('plugins:changed', { type: 'disabled' });
  });
  register('plugins:uninstall', async (_event, input) => {
    await assertOwner(services);
    const pluginId = 'pluginId' in input ? input.pluginId : input.id;
    const recoveryPath = await services.plugins.uninstall(pluginId);
    services.windows.emit('plugins:changed', { type: 'uninstalled' });
    return { recoveryPath };
  });
  register('plugins:invoke', async (_event, input) => {
    await assertOwner(services);
    return services.plugins.invoke(
      input.pluginId,
      input.target,
      input.id,
      input.input as JsonValue,
    );
  });

  registerApplicationHandler(services, registeredNames, 'plugins:set-enabled', async (input) => {
    await assertOwnerOrAdmin(services);
    const parsed = applicationInvokeSchemas['plugins:set-enabled'].parse(input);
    if (parsed.enabled) {
      await services.plugins.enable(parsed.id);
    } else {
      await services.plugins.disable(parsed.id);
    }
    services.windows.emit('plugins:changed', {
      type: parsed.enabled ? 'enabled' : 'disabled',
    });
    const status = (await services.plugins.list()).find(
      (plugin) => plugin.manifest.id === parsed.id,
    );
    if (status === undefined) {
      throw new DesktopError('PLUGIN_NOT_FOUND', '插件不存在');
    }
    return mapPluginStatus(status);
  });
  registerApplicationHandler(services, registeredNames, 'skills:list', async () =>
    mapSkills(await services.plugins.list(), services.plugins),
  );
  registerApplicationHandler(services, registeredNames, 'skills:set-enabled', async (input) => {
    await assertOwnerOrAdmin(services);
    const parsed = applicationInvokeSchemas['skills:set-enabled'].parse(input);
    const statuses = await services.plugins.list();
    const owner = statuses.find((status) =>
      status.manifest.contributes.skills?.some((skill) => skill.id === parsed.id),
    );
    if (owner === undefined) {
      throw new DesktopError('SKILL_NOT_FOUND', 'Skill 不存在');
    }
    if (parsed.enabled && !owner.enabled) {
      await services.plugins.enable(owner.manifest.id);
    }
    await services.plugins.setSkillEnabled(parsed.id, parsed.enabled);
    const refreshed = await services.plugins.list();
    const skill = (await mapSkills(refreshed, services.plugins)).find(
      (entry) => entry.id === parsed.id,
    );
    if (skill === undefined) {
      throw new DesktopError('SKILL_NOT_FOUND', 'Skill 不存在');
    }
    return skill;
  });
  registerApplicationHandler(services, registeredNames, 'skills:install', async (input) => {
    await assertOwner(services);
    const parsed = applicationInvokeSchemas['skills:install'].parse(input);
    const source = parsed.source.startsWith('https://')
      ? { type: 'git' as const, url: parsed.source }
      : { type: 'directory' as const, path: parsed.source };
    const installed = await services.plugins.install(source);
    const skill = (await mapSkills([installed], services.plugins))[0];
    if (skill === undefined) {
      throw new DesktopError('INSTALL_INVALID', '安装内容没有声明任何 Skill');
    }
    return skill;
  });
  registerApplicationHandler(services, registeredNames, 'system:check', async () => {
    const report = await services.getSelfCheck();
    return report.items.map((item) => ({
      name: item.label,
      ok: item.status !== 'error',
      message: item.message,
    }));
  });

  for (const channel of applicationInvokeChannels) {
    if (registeredNames.has(channel)) {
      continue;
    }
    registerApplicationHandler(
      services,
      registeredNames,
      channel,
      services.applicationHandlers?.[channel] ??
        (() => {
          throw new DesktopError('NOT_READY', `业务能力尚未初始化：${channel}`);
        }),
    );
  }

  const activeStreams = new Map<string, AbortController>();
  const streamStartListener = (event: Electron.IpcMainEvent, rawInput: unknown): void => {
    if (!services.windows.isTrustedSender(event.sender)) {
      services.logger.warn('拒绝不可信流式 IPC 发送者');
      return;
    }
    const parsed = streamStartSchema.safeParse(rawInput);
    if (!parsed.success) {
      event.reply('application:stream-event', {
        streamId: extractStreamId(rawInput),
        type: 'error',
        error: { code: 'INVALID_INPUT', message: '流式请求参数无效' },
      });
      return;
    }
    const key = `${event.sender.id}:${parsed.data.streamId}`;
    if (activeStreams.has(key)) {
      return;
    }
    const controller = new AbortController();
    activeStreams.set(key, controller);
    const onDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onDestroyed);
    void (async () => {
      try {
        const handler = services.applicationStreamHandlers?.[parsed.data.channel];
        if (handler === undefined) {
          throw new DesktopError('NOT_READY', `流式能力尚未初始化：${parsed.data.channel}`);
        }
        const iterable = await handler(parsed.data.payload, controller.signal);
        for await (const item of iterable) {
          if (controller.signal.aborted || event.sender.isDestroyed()) {
            break;
          }
          event.reply('application:stream-event', {
            streamId: parsed.data.streamId,
            type: 'event',
            data: item,
          });
        }
        if (!event.sender.isDestroyed()) {
          event.reply('application:stream-event', {
            streamId: parsed.data.streamId,
            type: 'complete',
          });
        }
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          if (controller.signal.aborted) {
            event.reply('application:stream-event', {
              streamId: parsed.data.streamId,
              type: 'complete',
            });
          } else {
            event.reply('application:stream-event', {
              streamId: parsed.data.streamId,
              type: 'error',
              error: serializeDesktopError(error),
            });
          }
        }
      } finally {
        activeStreams.delete(key);
        event.sender.removeListener('destroyed', onDestroyed);
      }
    })();
  };
  const streamAbortListener = (event: Electron.IpcMainEvent, rawInput: unknown): void => {
    if (!services.windows.isTrustedSender(event.sender)) {
      return;
    }
    const parsed = streamAbortSchema.safeParse(rawInput);
    if (parsed.success) {
      activeStreams.get(`${event.sender.id}:${parsed.data.streamId}`)?.abort();
    }
  };
  ipcMain.on('application:stream-start', streamStartListener);
  ipcMain.on('application:stream-abort', streamAbortListener);

  register('updates:check', async () => {
    await sessionRole(services);
    return services.updates.check();
  });
  register('updates:download', async () => {
    await assertOwnerOrAdmin(services);
    return services.updates.download();
  });
  register('updates:install', async () => {
    await assertOwnerOrAdmin(services);
    return services.updates.installAndRestart();
  });

  return () => {
    for (const channel of registered) {
      ipcMain.removeHandler(channel);
    }
    for (const channel of applicationInvokeChannels) {
      if (!registered.includes(channel as DesktopInvokeChannel)) {
        ipcMain.removeHandler(channel);
      }
    }
    ipcMain.removeListener('application:stream-start', streamStartListener);
    ipcMain.removeListener('application:stream-abort', streamAbortListener);
    for (const controller of activeStreams.values()) {
      controller.abort();
    }
  };
}

function registerApplicationHandler(
  services: IpcServices,
  registeredNames: Set<string>,
  channel: ApplicationInvokeChannel,
  handler: (input: unknown) => unknown | Promise<unknown>,
): void {
  if (registeredNames.has(channel)) {
    throw new Error(`IPC handler 重复注册：${channel}`);
  }
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResult<unknown>> => {
      if (!services.windows.isTrustedSender(event.sender)) {
        return {
          ok: false,
          error: { code: 'UNTRUSTED_SENDER', message: '不可信的调用来源' },
        };
      }
      try {
        if (!publicApplicationChannels.has(channel)) {
          await sessionRole(services);
        }
        const parsed = applicationInvokeSchemas[channel].parse(payload ?? {});
        return { ok: true, data: await handler(parsed) };
      } catch (error) {
        const serialized = serializeDesktopError(error);
        services.logger.warn('业务 IPC 操作失败', {
          channel,
          code: serialized.code,
        });
        return { ok: false, error: serialized };
      }
    },
  );
  registeredNames.add(channel);
}

const publicApplicationChannels = new Set<ApplicationInvokeChannel>([
  'auth:get-session',
  'auth:setup',
  'auth:login',
  'auth:logout',
]);

async function sessionRole(
  services: IpcServices,
): Promise<'admin' | 'member' | 'owner' | 'viewer'> {
  const getSession = services.applicationHandlers?.['auth:get-session'];
  if (getSession === undefined) {
    throw new DesktopError('NOT_READY', '身份与权限服务尚未初始化');
  }
  const session = await getSession({});
  const role =
    session !== null &&
    typeof session === 'object' &&
    'user' in session &&
    session.user !== null &&
    typeof session.user === 'object' &&
    'role' in session.user &&
    typeof session.user.role === 'string'
      ? session.user.role
      : undefined;
  if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') {
    throw new DesktopError('FORBIDDEN', '当前会话没有有效的用户角色');
  }
  return role;
}

async function assertOwnerOrAdmin(services: IpcServices): Promise<void> {
  const role = await sessionRole(services);
  if (role !== 'owner' && role !== 'admin') {
    throw new DesktopError('FORBIDDEN', '仅 Owner/Admin 可管理或直接调用插件与 Skill');
  }
}

async function assertCanAccessWorkspace(services: IpcServices): Promise<void> {
  if ((await sessionRole(services)) === 'viewer') {
    throw new DesktopError('FORBIDDEN', 'Viewer 角色不能直接访问本机工作区');
  }
}

async function assertOwner(services: IpcServices): Promise<void> {
  if ((await sessionRole(services)) !== 'owner') {
    throw new DesktopError('FORBIDDEN', '仅 Owner 可安装、授权、卸载或直接调用插件与 Skill');
  }
}

function mapPluginStatus(status: PluginStatus): {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  approved: boolean;
  source: string;
  types: PluginStatus['manifest']['types'];
  permissions: string[];
} {
  return {
    id: status.manifest.id,
    name: status.manifest.name,
    description: status.manifest.description,
    version: status.manifest.version,
    enabled: status.enabled,
    approved: status.approved,
    source: status.manifest.publisher,
    types: status.manifest.types,
    permissions: Object.entries(status.manifest.permissions)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([permission]) => permission),
  };
}

interface MappedSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'builtin' | 'local';
  enabled: boolean;
  command: string;
  permissions: string[];
  variables: Array<{
    name: string;
    description: string;
    required: boolean;
    maximumLength: number;
  }>;
}

async function mapSkills(
  statuses: readonly PluginStatus[],
  plugins: PluginRuntime,
): Promise<MappedSkill[]> {
  const result: MappedSkill[] = [];
  for (const status of statuses) {
    let pluginRoot: string;
    try {
      pluginRoot = await plugins.getPluginRoot(status.manifest.id);
    } catch {
      continue;
    }
    for (const skill of status.manifest.contributes.skills ?? []) {
      try {
        const registered = await new SkillRegistry().load(join(pluginRoot, skill.definition));
        const command = status.manifest.contributes.commands?.find(
          (entry) => entry.skill === skill.id,
        );
        result.push({
          id: skill.id,
          name: registered.definition.name['zh-CN'] ?? command?.title ?? status.manifest.name,
          description:
            registered.definition.description['zh-CN'] ??
            command?.description ??
            status.manifest.description,
          version: status.manifest.version,
          source:
            status.manifest.id === 'com.eagent.code-review' ||
            status.manifest.id === 'com.eagent.builtin-skills'
              ? ('builtin' as const)
              : ('local' as const),
          enabled: status.enabled && status.approved && plugins.isSkillEnabled(skill.id),
          command: registered.definition.command,
          permissions: Object.keys(status.manifest.permissions),
          variables: registered.definition.variables,
        });
      } catch {
        // 一个损坏的 Skill 定义不会阻断其他插件或 Skill 的列表。
      }
    }
  }
  return result;
}

function extractStreamId(input: unknown): string {
  if (
    input !== null &&
    typeof input === 'object' &&
    'streamId' in input &&
    typeof input.streamId === 'string'
  ) {
    return input.streamId;
  }
  return '00000000-0000-4000-8000-000000000000';
}
