import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  type Disposable,
  type HostEvent,
  type HostRequest,
  type JsonValue,
  type NetworkRequest,
  type NetworkResponse,
  parseHostRequest,
  type PluginContext,
  type PluginHandler,
  type PluginHookName,
  type PluginManifest,
  type PluginModule,
} from '@e-agent/plugin-sdk';

interface PendingCapability {
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PluginHostOptions {
  pluginEntryPath: string;
  send: (event: HostEvent) => void;
  importPlugin?: (entryPath: string) => Promise<unknown>;
  hardenGlobals?: boolean;
}

/**
 * 在子进程内管理插件生命周期和本地处理器注册表。
 */
export class PluginHost {
  private plugin: PluginModule | undefined;
  private readonly commands = new Map<string, PluginHandler>();
  private readonly hooks = new Map<string, PluginHandler>();
  private readonly providers = new Map<string, PluginHandler>();
  private readonly pendingCapabilities = new Map<string, PendingCapability>();
  private readonly disposables = new Set<Disposable>();

  public constructor(private readonly options: PluginHostOptions) {}

  /**
   * 校验并处理父进程消息。
   */
  public async handle(message: unknown): Promise<void> {
    let request: HostRequest;
    try {
      request = parseHostRequest(message);
    } catch (error) {
      this.sendResponse(
        extractRequestId(message),
        false,
        undefined,
        error instanceof Error ? error.message : '无效 IPC 消息',
      );
      return;
    }

    if (request.type === 'capability-result') {
      this.completeCapability(request);
      return;
    }

    try {
      switch (request.type) {
        case 'initialize':
          await this.initialize(request.manifest, request.dataDirectory);
          this.sendResponse(request.requestId, true);
          return;
        case 'invoke': {
          const result = await this.invoke(request.target, request.id, request.input as JsonValue);
          this.sendResponse(request.requestId, true, result);
          return;
        }
        case 'deactivate':
          await this.deactivate();
          this.sendResponse(request.requestId, true);
          return;
      }
    } catch (error) {
      this.sendResponse(
        request.requestId,
        false,
        undefined,
        error instanceof Error ? error.message : '插件调用失败',
      );
    }
  }

  private async initialize(manifest: PluginManifest, dataDirectory: string): Promise<void> {
    if (this.plugin !== undefined) {
      throw new Error('插件已经初始化');
    }
    if (this.options.hardenGlobals !== false) {
      hardenGlobals();
    }
    const imported = await (
      this.options.importPlugin ?? ((entryPath: string) => import(pathToFileURL(entryPath).href))
    )(this.options.pluginEntryPath);
    const module = resolvePluginModule(imported);
    this.plugin = module;
    await module.activate(this.createContext(manifest, dataDirectory));
  }

  private async invoke(
    target: 'command' | 'hook' | 'provider',
    id: string,
    input: JsonValue,
  ): Promise<JsonValue | undefined> {
    const registry =
      target === 'command' ? this.commands : target === 'hook' ? this.hooks : this.providers;
    const handler = registry.get(id);
    if (handler === undefined) {
      throw new Error(`未注册 ${target}:${id}`);
    }
    const output = await handler(input);
    return output;
  }

  private async deactivate(): Promise<void> {
    await this.plugin?.deactivate?.();
    await Promise.allSettled([...this.disposables].map((disposable) => disposable.dispose()));
    this.disposables.clear();
    this.commands.clear();
    this.hooks.clear();
    this.providers.clear();
    this.plugin = undefined;
  }

  private createContext(manifest: PluginManifest, dataDirectory: string): PluginContext {
    return {
      manifest,
      dataDirectory,
      capabilities: {
        network: {
          request: async (input: NetworkRequest) =>
            (await this.requestCapability(
              'network.request',
              input as unknown as JsonValue,
            )) as unknown as NetworkResponse,
        },
        fileSystem: {
          readText: async (path: string) =>
            (await this.requestCapability('fileSystem.readText', {
              path,
            })) as string,
          writeText: async (path: string, content: string) => {
            await this.requestCapability('fileSystem.writeText', {
              path,
              content,
            });
          },
          list: async (path: string) => {
            const result = await this.requestCapability('fileSystem.list', {
              path,
            });
            if (!Array.isArray(result)) {
              throw new Error('文件列表响应无效');
            }
            return result.map((entry) => String(entry));
          },
        },
        env: {
          get: async (name: string) =>
            (await this.requestCapability('env.get', { name })) as string | undefined,
        },
        notifications: {
          show: async (title: string, body: string) => {
            await this.requestCapability('notifications.show', { title, body });
          },
        },
      },
      registerCommand: (id, handler) => this.register('command', id, handler, manifest),
      registerHook: (name, handler) => this.register('hook', name, handler, manifest),
      registerProvider: (id, handler) => this.register('provider', id, handler, manifest),
      log: (level, message, fields) => {
        this.options.send({
          type: 'log',
          level,
          message: message.slice(0, 5_000),
          ...(fields === undefined ? {} : { fields: { ...fields } }),
        });
      },
    };
  }

  private register(
    target: 'command' | 'hook' | 'provider',
    id: string,
    handler: PluginHandler,
    manifest: PluginManifest,
  ): Disposable {
    if (!isContributionDeclared(manifest, target, id)) {
      throw new Error(`清单未声明 ${target}:${id}`);
    }
    const registry =
      target === 'command' ? this.commands : target === 'hook' ? this.hooks : this.providers;
    if (registry.has(id)) {
      throw new Error(`重复注册 ${target}:${id}`);
    }
    registry.set(id, handler);
    this.options.send({ type: 'registration', target, id });
    const disposable: Disposable = {
      dispose: () => {
        registry.delete(id);
        this.disposables.delete(disposable);
      },
    };
    this.disposables.add(disposable);
    return disposable;
  }

  private async requestCapability(
    capability: Extract<HostEvent, { type: 'capability-request' }>['capability'],
    input: JsonValue,
  ): Promise<JsonValue | undefined> {
    const capabilityRequestId = randomUUID();
    return new Promise<JsonValue | undefined>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingCapabilities.delete(capabilityRequestId);
        reject(new Error(`能力请求超时：${capability}`));
      }, 30_000);
      this.pendingCapabilities.set(capabilityRequestId, {
        resolve: resolvePromise,
        reject,
        timer,
      });
      this.options.send({
        type: 'capability-request',
        capabilityRequestId,
        capability,
        input,
      });
    });
  }

  private completeCapability(request: Extract<HostRequest, { type: 'capability-result' }>): void {
    const pending = this.pendingCapabilities.get(request.capabilityRequestId);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCapabilities.delete(request.capabilityRequestId);
    if (request.ok) {
      pending.resolve(request.value as JsonValue | undefined);
    } else {
      pending.reject(new Error(request.error ?? '能力请求被拒绝'));
    }
  }

  private sendResponse(requestId: string, ok: boolean, value?: JsonValue, error?: string): void {
    this.options.send({
      type: 'response',
      requestId,
      ok,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error: error.slice(0, 2_000) }),
    });
  }
}

/**
 * 检查注册项是否已在 manifest 中声明。
 */
export function isContributionDeclared(
  manifest: PluginManifest,
  target: 'command' | 'hook' | 'provider',
  id: string,
): boolean {
  if (target === 'command') {
    return manifest.contributes.commands?.some((command) => command.id === id) ?? false;
  }
  if (target === 'hook') {
    return manifest.contributes.hooks?.includes(id as PluginHookName) ?? false;
  }
  return manifest.contributes.providers?.some((provider) => provider.id === id) ?? false;
}

function resolvePluginModule(imported: unknown): PluginModule {
  if (imported === null || typeof imported !== 'object') {
    throw new Error('插件入口必须导出插件对象');
  }
  const exports = imported as Record<string, unknown>;
  const candidate = exports['default'] ?? exports['plugin'];
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof (candidate as { activate?: unknown }).activate !== 'function'
  ) {
    throw new Error('插件入口缺少 activate 函数');
  }
  return candidate as PluginModule;
}

function extractRequestId(message: unknown): string {
  if (
    message !== null &&
    typeof message === 'object' &&
    'requestId' in message &&
    typeof message.requestId === 'string'
  ) {
    return message.requestId.slice(0, 128);
  }
  return 'invalid';
}

function hardenGlobals(): void {
  for (const name of ['fetch', 'WebSocket', 'EventSource'] as const) {
    if (name in globalThis) {
      try {
        Object.defineProperty(globalThis, name, {
          configurable: false,
          enumerable: false,
          value: undefined,
          writable: false,
        });
      } catch {
        // 宿主版本不允许重定义时由加载器继续提供纵深防御。
      }
    }
  }
  try {
    Object.defineProperty(process, 'getBuiltinModule', {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  } catch {
    // 旧版 Node 没有该 API。
  }
}
