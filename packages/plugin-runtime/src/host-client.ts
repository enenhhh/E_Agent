import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import {
  parseHostEvent,
  type HostEvent,
  type HostRequest,
  type JsonValue,
  type PluginManifest,
} from '@e-agent/plugin-sdk';

import { PluginRuntimeError, toSafeErrorMessage } from './errors.js';

interface PendingRequest {
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PluginHostClientOptions {
  hostEntryPath: string;
  pluginEntryPath: string;
  pluginRoot: string;
  dataDirectory: string;
  manifest: PluginManifest;
  requestTimeoutMs?: number;
  onCapabilityRequest: (
    event: Extract<HostEvent, { type: 'capability-request' }>,
  ) => Promise<JsonValue | undefined>;
  onLog?: (
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, JsonValue>>,
  ) => void;
}

/**
 * 管理单个插件宿主子进程及经过校验的 IPC 协议。
 */
export class PluginHostClient {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly registrations = {
    command: new Set<string>(),
    hook: new Set<string>(),
    provider: new Set<string>(),
  };
  private stopping = false;

  public constructor(private readonly options: PluginHostClientOptions) {}

  /**
   * 启动子进程并激活插件。
   */
  public async start(): Promise<void> {
    if (this.child !== undefined) {
      return;
    }
    this.stopping = false;
    const hostPath = resolve(this.options.hostEntryPath);
    const pluginEntry = resolve(this.options.pluginEntryPath);
    const permissionArgs = [
      '--permission',
      `--allow-fs-read=${dirname(hostPath)}`,
      `--allow-fs-read=${this.options.pluginRoot}`,
    ];
    const child = fork(hostPath, [pluginEntry], {
      cwd: this.options.pluginRoot,
      env: minimalEnvironment(this.options.pluginRoot),
      execArgv: permissionArgs,
      serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    child.on('message', (message: unknown) => {
      void this.handleMessage(message);
    });
    child.once('error', (error) => {
      this.handleExit(error);
    });
    child.once('exit', (code, signal) => {
      if (!this.stopping) {
        this.handleExit(
          new PluginRuntimeError(
            'HOST_CRASHED',
            `插件宿主异常退出（code=${String(code)}, signal=${String(signal)}）`,
          ),
        );
      }
      this.child = undefined;
    });
    child.stdout?.on('data', () => {
      // 插件标准输出不直接进入主进程日志，避免敏感信息泄漏。
    });
    child.stderr?.on('data', () => {
      // 仅结构化 log 事件进入应用日志。
    });

    await this.sendRequest({
      type: 'initialize',
      requestId: randomUUID(),
      manifest: this.options.manifest,
      dataDirectory: this.options.dataDirectory,
    });
  }

  /**
   * 调用插件已注册的命令、Hook 或 Provider。
   */
  public async invoke(
    target: 'command' | 'hook' | 'provider',
    id: string,
    input: JsonValue,
  ): Promise<JsonValue | undefined> {
    if (!this.registrations[target].has(id)) {
      throw new PluginRuntimeError('PROTOCOL_INVALID', `插件未注册 ${target}:${id}`);
    }
    return this.sendRequest({
      type: 'invoke',
      requestId: randomUUID(),
      target,
      id,
      input,
    });
  }

  /**
   * 请求插件释放资源并终止宿主。
   */
  public async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    this.stopping = true;
    try {
      await this.sendRequest({
        type: 'deactivate',
        requestId: randomUUID(),
      });
    } catch {
      // 关闭流程继续强制终止。
    }
    child.kill();
    this.child = undefined;
    this.rejectPending(new PluginRuntimeError('PLUGIN_DISABLED', '插件已停用'));
  }

  private async sendRequest(
    request: Exclude<HostRequest, { type: 'capability-result' }>,
  ): Promise<JsonValue | undefined> {
    const child = this.child;
    if (child?.connected !== true) {
      throw new PluginRuntimeError('HOST_CRASHED', '插件宿主未运行');
    }
    return new Promise<JsonValue | undefined>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new PluginRuntimeError('REQUEST_TIMEOUT', `插件请求超时：${request.type}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(request.requestId, {
        resolve: resolvePromise,
        reject,
        timer,
      });
      child.send(request, (error) => {
        if (error !== null) {
          clearTimeout(timer);
          this.pending.delete(request.requestId);
          reject(error);
        }
      });
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    let event: HostEvent;
    try {
      event = parseHostEvent(message);
    } catch {
      this.handleExit(new PluginRuntimeError('PROTOCOL_INVALID', '插件宿主发送了无效 IPC 消息'));
      this.child?.kill();
      return;
    }

    if (event.type === 'response') {
      const pending = this.pending.get(event.requestId);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(event.requestId);
      if (event.ok) {
        pending.resolve(event.value as JsonValue | undefined);
      } else {
        pending.reject(new PluginRuntimeError('PROTOCOL_INVALID', event.error ?? '插件调用失败'));
      }
      return;
    }

    if (event.type === 'registration') {
      if (!isDeclaredRegistration(this.options.manifest, event)) {
        this.handleExit(
          new PluginRuntimeError(
            'PROTOCOL_INVALID',
            `插件注册了清单未声明的 ${event.target}:${event.id}`,
          ),
        );
        this.child?.kill();
        return;
      }
      this.registrations[event.target].add(event.id);
      return;
    }

    if (event.type === 'log') {
      this.options.onLog?.(
        event.level,
        event.message,
        event.fields as Readonly<Record<string, JsonValue>> | undefined,
      );
      return;
    }

    const child = this.child;
    if (child?.connected !== true) {
      return;
    }
    try {
      const value = await this.options.onCapabilityRequest(event);
      const response: HostRequest = {
        type: 'capability-result',
        requestId: randomUUID(),
        capabilityRequestId: event.capabilityRequestId,
        ok: true,
        ...(value === undefined ? {} : { value }),
      };
      child.send(response);
    } catch (error) {
      const response: HostRequest = {
        type: 'capability-result',
        requestId: randomUUID(),
        capabilityRequestId: event.capabilityRequestId,
        ok: false,
        error: toSafeErrorMessage(error),
      };
      child.send(response);
    }
  }

  private handleExit(error: Error): void {
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function minimalEnvironment(pluginRoot: string): NodeJS.ProcessEnv {
  const allowed = [
    'COMSPEC',
    'LANG',
    'NODE_ENV',
    'PATH',
    'PATHEXT',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'WINDIR',
  ] as const;
  return {
    ...Object.fromEntries(
      allowed.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    E_AGENT_PLUGIN_ROOT: resolve(pluginRoot),
    ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
  };
}

function isDeclaredRegistration(
  manifest: PluginManifest,
  event: Extract<HostEvent, { type: 'registration' }>,
): boolean {
  if (event.target === 'command') {
    return manifest.contributes.commands?.some((command) => command.id === event.id) ?? false;
  }
  if (event.target === 'hook') {
    return (
      manifest.contributes.hooks?.includes(
        event.id as NonNullable<PluginManifest['contributes']['hooks']>[number],
      ) ?? false
    );
  }
  return manifest.contributes.providers?.some((provider) => provider.id === event.id) ?? false;
}
