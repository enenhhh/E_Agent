import { createHash } from 'node:crypto';

import { McpClient } from './client.js';
import { parseMcpServerConfig, parseMcpServerConfigs, type McpServerConfig } from './config.js';
import { McpRuntimeError, toSafeMcpError, type McpErrorCode } from './errors.js';
import { StreamableHttpMcpTransport } from './http-transport.js';
import type { McpTool, McpToolResult } from './protocol.js';
import { redactMcpValue } from './redaction.js';
import { StdioMcpTransport } from './stdio-transport.js';
import type { McpRequestOptions, McpRuntimeLogger } from './transport.js';

export interface McpManagedTool {
  name: string;
  originalName: string;
  serverId: string;
  serverName: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** 与 E Agent/OpenAI function tool 结构兼容，避免 MCP 基础层反向依赖业务包。 */
export interface McpChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface McpServerStatus {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpServerConfig['transport']['type'];
  state: 'connected' | 'connecting' | 'disconnected' | 'error';
  toolCount: number;
  connectedAt?: string;
  serverInfo?: {
    name: string;
    version: string;
    title?: string;
  };
  error?: {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type McpManagerEvent =
  | { type: 'server-status'; server: McpServerStatus }
  | { type: 'tools-changed'; serverId: string }
  | {
      type: 'server-error';
      serverId: string;
      error: { code: McpErrorCode; message: string; retryable: boolean };
    };

export interface McpManagerOptions {
  servers?: readonly unknown[];
  logger?: McpRuntimeLogger;
  clientInfo?: { name: string; version: string };
  clientFactory?: (config: McpServerConfig) => McpClient;
}

interface ServerRuntime {
  config: McpServerConfig;
  client?: McpClient;
  connectPromise?: Promise<McpServerStatus>;
  connectedAt?: string;
  state: McpServerStatus['state'];
  lastError?: McpRuntimeError;
  unsubscribeTools?: () => void;
  limiter: CallLimiter;
}

/** 管理多个 MCP 服务，提供稳定的命名空间、生命周期与并发隔离。 */
export class McpManager {
  private readonly servers = new Map<string, ServerRuntime>();
  private readonly toolsByServer = new Map<string, readonly McpManagedTool[]>();
  private readonly routes = new Map<string, McpManagedTool>();
  private readonly listeners = new Set<(event: McpManagerEvent) => void>();

  public constructor(private readonly options: McpManagerOptions = {}) {
    for (const config of parseMcpServerConfigs(options.servers ?? [])) {
      this.servers.set(config.id, this.createRuntime(config));
    }
  }

  /** 启动全部已启用服务；单个服务失败不会阻断其他服务。 */
  public async initialize(): Promise<readonly McpServerStatus[]> {
    const serverIds = [...this.servers.values()]
      .filter((runtime) => runtime.config.enabled)
      .map((runtime) => runtime.config.id);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < serverIds.length) {
        const serverId = serverIds[nextIndex];
        nextIndex += 1;
        if (serverId !== undefined) await this.connect(serverId).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, serverIds.length) }, async () => worker()));
    return this.getServerStatuses();
  }

  public async connect(serverId: string): Promise<McpServerStatus> {
    const runtime = this.requireRuntime(serverId);
    if (!runtime.config.enabled) {
      throw new McpRuntimeError('SERVER_DISABLED', `MCP 服务已停用：${serverId}`, {
        serverId,
      });
    }
    if (runtime.client?.state === 'connected') return this.status(runtime);
    if (runtime.connectPromise !== undefined) return runtime.connectPromise;
    const task = this.connectRuntime(runtime).finally(() => {
      if (runtime.connectPromise === task) runtime.connectPromise = undefined;
    });
    runtime.connectPromise = task;
    return task;
  }

  private async connectRuntime(runtime: ServerRuntime): Promise<McpServerStatus> {
    const serverId = runtime.config.id;
    runtime.state = 'connecting';
    runtime.lastError = undefined;
    this.emitStatus(runtime);
    const client =
      this.options.clientFactory?.(runtime.config) ?? this.createClient(runtime.config);
    runtime.client = client;
    runtime.unsubscribeTools?.();
    runtime.unsubscribeTools = client.onToolsChanged(() => {
      this.toolsByServer.delete(serverId);
      this.rebuildRoutes();
      this.emit({ type: 'tools-changed', serverId });
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      this.toolsByServer.set(serverId, this.mapTools(runtime.config, tools));
      this.rebuildRoutes();
      runtime.connectedAt = new Date().toISOString();
      runtime.state = 'connected';
      this.emitStatus(runtime);
      return this.status(runtime);
    } catch (error) {
      const safe = toSafeMcpError(error, 'CONNECT_FAILED', serverId);
      runtime.lastError = safe;
      runtime.state = 'error';
      this.toolsByServer.delete(serverId);
      this.rebuildRoutes();
      await client.close().catch(() => undefined);
      this.emit({
        type: 'server-error',
        serverId,
        error: { code: safe.code, message: safe.message, retryable: safe.retryable },
      });
      this.emitStatus(runtime);
      throw safe;
    }
  }

  public async disconnect(serverId: string): Promise<void> {
    const runtime = this.requireRuntime(serverId);
    await runtime.connectPromise?.catch(() => undefined);
    runtime.unsubscribeTools?.();
    runtime.unsubscribeTools = undefined;
    await runtime.client?.close().catch(() => undefined);
    runtime.client = undefined;
    runtime.connectedAt = undefined;
    runtime.state = 'disconnected';
    this.toolsByServer.delete(serverId);
    this.rebuildRoutes();
    this.emitStatus(runtime);
  }

  public async reconnect(serverId: string): Promise<McpServerStatus> {
    await this.disconnect(serverId);
    return this.connect(serverId);
  }

  /** 新增或替换服务；替换时先关闭旧连接，防止遗留子进程和 HTTP 会话。 */
  public async upsertServer(
    value: unknown,
    options: { connect?: boolean } = {},
  ): Promise<McpServerStatus> {
    const config = parseMcpServerConfig(value);
    if (this.servers.has(config.id)) await this.disconnect(config.id);
    const runtime = this.createRuntime(config);
    this.servers.set(config.id, runtime);
    if (config.enabled && options.connect !== false) return this.connect(config.id);
    this.emitStatus(runtime);
    return this.status(runtime);
  }

  public async removeServer(serverId: string): Promise<void> {
    this.requireRuntime(serverId);
    await this.disconnect(serverId);
    this.servers.delete(serverId);
  }

  public async setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerStatus> {
    const runtime = this.requireRuntime(serverId);
    runtime.config = { ...runtime.config, enabled };
    if (!enabled) {
      await this.disconnect(serverId);
      return this.status(runtime);
    }
    return this.connect(serverId);
  }

  public async refreshTools(serverId?: string): Promise<readonly McpManagedTool[]> {
    const runtimes =
      serverId === undefined ? [...this.servers.values()] : [this.requireRuntime(serverId)];
    for (const runtime of runtimes) {
      if (!runtime.config.enabled) continue;
      if (runtime.client?.state !== 'connected') {
        try {
          await this.connect(runtime.config.id);
        } catch {
          continue;
        }
      } else {
        try {
          const tools = await runtime.client.listTools({ refresh: true });
          this.toolsByServer.set(runtime.config.id, this.mapTools(runtime.config, tools));
          runtime.lastError = undefined;
        } catch (error) {
          const safe = toSafeMcpError(error, 'TRANSPORT_ERROR', runtime.config.id);
          runtime.lastError = safe;
          this.emit({
            type: 'server-error',
            serverId: runtime.config.id,
            error: { code: safe.code, message: safe.message, retryable: safe.retryable },
          });
        }
      }
    }
    this.rebuildRoutes();
    return this.currentTools();
  }

  public async listTools(options: { refresh?: boolean } = {}): Promise<readonly McpManagedTool[]> {
    if (options.refresh === true) return this.refreshTools();
    return this.currentTools();
  }

  /** 转换为 E Agent 模型请求可直接消费的 function tool 格式。 */
  public async listChatTools(options: { refresh?: boolean } = {}): Promise<readonly McpChatTool[]> {
    return (await this.listTools(options)).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description:
          `[MCP · ${tool.serverName}] ${tool.description ?? tool.title ?? tool.originalName}`.slice(
            0,
            2_048,
          ),
        parameters: tool.inputSchema,
      },
    }));
  }

  public async callTool(
    exposedName: string,
    argumentsValue: Readonly<Record<string, unknown>> = {},
    options: McpRequestOptions = {},
  ): Promise<McpToolResult> {
    let route = this.routes.get(exposedName);
    if (route === undefined) {
      await this.refreshTools();
      route = this.routes.get(exposedName);
    }
    if (route === undefined) {
      throw new McpRuntimeError('TOOL_NOT_FOUND', `MCP 工具不存在：${exposedName}`);
    }
    const runtime = this.requireRuntime(route.serverId);
    if (!runtime.config.enabled) {
      throw new McpRuntimeError('SERVER_DISABLED', `MCP 服务已停用：${route.serverId}`, {
        serverId: route.serverId,
      });
    }
    if (runtime.client?.state !== 'connected') await this.connect(route.serverId);
    const release = await runtime.limiter.acquire(options.signal);
    try {
      return await runtime.client!.callTool(route.originalName, argumentsValue, options);
    } catch (error) {
      const safe = toSafeMcpError(error, 'SERVER_ERROR', route.serverId);
      runtime.lastError = safe;
      this.emit({
        type: 'server-error',
        serverId: route.serverId,
        error: { code: safe.code, message: safe.message, retryable: safe.retryable },
      });
      throw safe;
    } finally {
      release();
    }
  }

  public getServerStatuses(): readonly McpServerStatus[] {
    return [...this.servers.values()]
      .map((runtime) => this.status(runtime))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  public subscribe(listener: (event: McpManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async shutdown(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((serverId) => this.disconnect(serverId)));
    this.listeners.clear();
  }

  private createRuntime(config: McpServerConfig): ServerRuntime {
    return {
      config,
      state: 'disconnected',
      limiter: new CallLimiter(config.maxConcurrentCalls),
    };
  }

  private createClient(config: McpServerConfig): McpClient {
    const shared = {
      serverId: config.id,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      maxMessageBytes: config.maxMessageBytes,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    };
    const transport =
      config.transport.type === 'stdio'
        ? new StdioMcpTransport({ ...shared, config: config.transport })
        : new StreamableHttpMcpTransport({ ...shared, config: config.transport });
    return new McpClient({
      serverId: config.id,
      displayName: config.displayName,
      transport,
      connectTimeoutMs: config.connectTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(this.options.clientInfo === undefined ? {} : { clientInfo: this.options.clientInfo }),
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    });
  }

  private mapTools(config: McpServerConfig, tools: readonly McpTool[]): readonly McpManagedTool[] {
    return tools
      .filter((tool) => isToolAllowed(config, tool.name))
      .map((tool) => ({
        name: createMcpToolName(config.id, tool.name),
        originalName: tool.name,
        serverId: config.id,
        serverName: config.displayName,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      }));
  }

  private rebuildRoutes(): void {
    this.routes.clear();
    for (const tools of this.toolsByServer.values()) {
      for (const tool of tools) {
        let name = tool.name;
        const existing = this.routes.get(name);
        if (
          existing !== undefined &&
          (existing.serverId !== tool.serverId || existing.originalName !== tool.originalName)
        ) {
          name = withStableSuffix(name, `${tool.serverId}:${tool.originalName}`);
        }
        this.routes.set(name, name === tool.name ? tool : { ...tool, name });
      }
    }
  }

  private currentTools(): readonly McpManagedTool[] {
    return [...this.routes.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private requireRuntime(serverId: string): ServerRuntime {
    const runtime = this.servers.get(serverId);
    if (runtime === undefined) {
      throw new McpRuntimeError('SERVER_NOT_FOUND', `MCP 服务不存在：${serverId}`, { serverId });
    }
    return runtime;
  }

  private status(runtime: ServerRuntime): McpServerStatus {
    const info = runtime.client?.initializeResult?.serverInfo;
    return {
      id: runtime.config.id,
      displayName: runtime.config.displayName,
      enabled: runtime.config.enabled,
      transport: runtime.config.transport.type,
      state: runtime.state,
      toolCount: this.toolsByServer.get(runtime.config.id)?.length ?? 0,
      ...(runtime.connectedAt === undefined ? {} : { connectedAt: runtime.connectedAt }),
      ...(info === undefined
        ? {}
        : {
            serverInfo: {
              name: info.name,
              version: info.version,
              ...(info.title === undefined ? {} : { title: info.title }),
            },
          }),
      ...(runtime.lastError === undefined
        ? {}
        : {
            error: {
              code: runtime.lastError.code,
              message: runtime.lastError.message,
              retryable: runtime.lastError.retryable,
            },
          }),
    };
  }

  private emitStatus(runtime: ServerRuntime): void {
    this.emit({ type: 'server-status', server: this.status(runtime) });
  }

  private emit(event: McpManagerEvent): void {
    for (const listener of this.listeners) listener(redactMcpValue(event));
  }
}

/** 生成兼容主流 OpenAI 兼容接口的 64 字符 function 名称。 */
export function createMcpToolName(serverId: string, toolName: string): string {
  const server = normalizeToolSegment(serverId);
  const tool = normalizeToolSegment(toolName);
  const name = `mcp_${server}_${tool}`;
  return name.length <= 64 ? name : withStableSuffix(name.slice(0, 64), `${serverId}:${toolName}`);
}

function normalizeToolSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/_+/gu, '_');
  return normalized.replace(/^_+|_+$/gu, '') || 'tool';
}

function withStableSuffix(value: string, identity: string): string {
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return `${value.slice(0, 64 - suffix.length - 1).replace(/_+$/u, '')}_${suffix}`;
}

function isToolAllowed(config: McpServerConfig, name: string): boolean {
  const policy = config.toolPolicy;
  if (policy?.allow !== undefined)
    return policy.allow.some((pattern) => globMatches(pattern, name));
  if (policy?.deny !== undefined) return !policy.deny.some((pattern) => globMatches(pattern, name));
  return true;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}

class CallLimiter {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  public constructor(private readonly maximum: number) {}

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      throw new McpRuntimeError('REQUEST_ABORTED', 'MCP 工具调用已取消。');
    }
    if (this.active < this.maximum) {
      this.active += 1;
      return this.releaseFactory();
    }
    if (this.queue.length >= 256) {
      throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP 工具调用队列已满。', {
        retryable: true,
      });
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: {
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        abort?: () => void;
      } = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        entry.abort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new McpRuntimeError('REQUEST_ABORTED', 'MCP 工具调用已取消。'));
        };
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next === undefined) {
        this.active -= 1;
        return;
      }
      if (next.abort !== undefined) next.signal?.removeEventListener('abort', next.abort);
      next.resolve(this.releaseFactory());
    };
  }
}
