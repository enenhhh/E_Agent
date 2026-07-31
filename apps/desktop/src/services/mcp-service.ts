import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  McpManager,
  parseMcpServerConfigs,
  type McpManagedTool,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolResult,
} from '@e-agent/mcp-runtime';

import { DesktopError } from './errors.js';
import type { AppLogger } from './logger.js';
import type { DesktopSecretStore } from './secret-store.js';

const maximumConfigBytes = 2 * 1_024 * 1_024;
const encryptedStateName = 'mcp-servers';

export type DesktopMcpServerInput =
  | {
      id?: string;
      displayName: string;
      enabled?: boolean;
      transport: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      inheritEnv?: boolean;
    }
  | {
      id?: string;
      displayName: string;
      enabled?: boolean;
      transport: 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      allowInsecureHttp?: boolean;
    };

export interface DesktopMcpServerSummary {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: 'stdio' | 'streamable-http';
  endpoint: string;
  state: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';
  toolCount: number;
  tools: string[];
  lastError?: string;
  updatedAt?: string;
  hasCredentials: boolean;
}

export interface DesktopMcpToolDescriptor extends McpManagedTool {
  approvalIdentity: string;
  bindingRevision: string;
  endpoint: string;
}

interface PersistedMcpServers {
  schemaVersion: 1;
  servers: McpServerConfig[];
}

/**
 * 管理桌面端 MCP 配置持久化，并将运行时状态映射为不含凭据的渲染层摘要。
 */
export class DesktopMcpService {
  private readonly manager: McpManager;
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly bindingRevisions = new Map<string, string>();
  private readonly lock = new AsyncReadWriteLock();
  private connectionTask: Promise<void> | undefined;
  private connectionsStarted = false;
  private initialized = false;
  private legacyMigrationPending = false;

  public constructor(
    private readonly options: {
      stateFile: string;
      logger: AppLogger;
      clientVersion?: string;
      secrets?: Pick<DesktopSecretStore, 'readJson' | 'writeJson'>;
    },
  ) {
    this.manager = new McpManager({
      clientInfo: {
        name: 'E Agent',
        version: options.clientVersion ?? '0.1.2',
      },
      logger: (level, message, fields) => options.logger[level](message, fields),
    });
  }

  public async initialize(): Promise<void> {
    await this.lock.withWrite(async () => {
      if (this.initialized) return;
      const configs = await this.readPersistedConfigs();
      for (const config of configs) {
        this.configs.set(config.id, config);
        this.bindingRevisions.set(config.id, randomUUID());
        await this.manager.upsertServer(config, { connect: false });
      }
      if (this.legacyMigrationPending && this.options.secrets !== undefined) {
        await this.persist();
        await this.removeLegacyPlaintext();
        this.legacyMigrationPending = false;
      }
      this.initialized = true;
    });
  }

  public async list(): Promise<DesktopMcpServerSummary[]> {
    return this.lock.withRead(async () => {
      this.assertInitialized();
      return this.mapSummaries();
    });
  }

  public activate(): void {
    this.assertInitialized();
    void this.startConnections();
  }

  public async save(input: DesktopMcpServerInput): Promise<DesktopMcpServerSummary> {
    return this.lock.withWrite(async () => {
      this.assertInitialized();
      const id = input.id ?? this.createServerId(input.displayName);
      const existing = this.configs.get(id);
      const config: McpServerConfig =
        input.transport === 'stdio'
          ? {
              id,
              displayName: input.displayName,
              enabled: input.enabled ?? existing?.enabled ?? true,
              transport: {
                type: 'stdio',
                command: input.command,
                args: input.args ?? [],
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                env: input.env ?? {},
                inheritEnv: input.inheritEnv === true ? safeInheritedEnvironmentNames() : [],
                shutdownGraceMs: 1_000,
              },
              connectTimeoutMs: existing?.connectTimeoutMs ?? 10_000,
              requestTimeoutMs: existing?.requestTimeoutMs ?? 30_000,
              maxMessageBytes: existing?.maxMessageBytes ?? 4 * 1_024 * 1_024,
              maxConcurrentCalls: existing?.maxConcurrentCalls ?? 4,
              ...(existing?.toolPolicy === undefined ? {} : { toolPolicy: existing.toolPolicy }),
            }
          : {
              id,
              displayName: input.displayName,
              enabled: input.enabled ?? existing?.enabled ?? true,
              transport: {
                type: 'streamable-http',
                url: input.url,
                headers: input.headers ?? {},
                allowInsecureHttp: input.allowInsecureHttp ?? false,
                openEventStream: true,
              },
              connectTimeoutMs: existing?.connectTimeoutMs ?? 10_000,
              requestTimeoutMs: existing?.requestTimeoutMs ?? 30_000,
              maxMessageBytes: existing?.maxMessageBytes ?? 4 * 1_024 * 1_024,
              maxConcurrentCalls: existing?.maxConcurrentCalls ?? 4,
              ...(existing?.toolPolicy === undefined ? {} : { toolPolicy: existing.toolPolicy }),
            };
      const parsed = parseMcpServerConfigs([config])[0];
      if (parsed === undefined) {
        throw new DesktopError('MCP_CONFIG_INVALID', 'MCP Server 配置无效');
      }
      if (containsCredentials(parsed) && this.options.secrets === undefined) {
        throw new DesktopError(
          'MCP_SECRET_STORAGE_UNAVAILABLE',
          '系统安全存储不可用，不能保存 MCP 凭据',
        );
      }
      this.configs.set(id, parsed);
      const previousRevision = this.bindingRevisions.get(id);
      this.bindingRevisions.set(id, randomUUID());
      try {
        await this.persist();
      } catch (error) {
        if (existing === undefined) this.configs.delete(id);
        else this.configs.set(id, existing);
        if (previousRevision === undefined) this.bindingRevisions.delete(id);
        else this.bindingRevisions.set(id, previousRevision);
        throw error;
      }
      await this.manager.upsertServer(parsed, { connect: false });
      if (parsed.enabled) {
        await this.manager.connect(id).catch((error: unknown) => {
          this.options.logger.warn('MCP Server 保存后连接失败', {
            serverId: id,
            message: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
      return this.requireSummary(id);
    });
  }

  public async setEnabled(id: string, enabled: boolean): Promise<DesktopMcpServerSummary> {
    return this.lock.withWrite(async () => {
      this.assertInitialized();
      const current = this.requireConfig(id);
      const next = { ...current, enabled };
      const previousRevision = this.bindingRevisions.get(id);
      this.configs.set(id, next);
      this.bindingRevisions.set(id, randomUUID());
      try {
        await this.persist();
      } catch (error) {
        this.configs.set(id, current);
        if (previousRevision !== undefined) this.bindingRevisions.set(id, previousRevision);
        throw error;
      }
      await this.manager.upsertServer(next, { connect: false });
      if (enabled) {
        await this.manager.connect(id).catch((error: unknown) => {
          this.options.logger.warn('MCP Server 启用后连接失败', {
            serverId: id,
            message: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
      return this.requireSummary(id);
    });
  }

  public async refresh(id: string): Promise<DesktopMcpServerSummary> {
    return this.lock.withWrite(async () => {
      this.assertInitialized();
      this.requireConfig(id);
      await this.manager.refreshTools(id);
      this.bindingRevisions.set(id, randomUUID());
      return this.requireSummary(id);
    });
  }

  public async remove(id: string): Promise<void> {
    await this.lock.withWrite(async () => {
      this.assertInitialized();
      const current = this.requireConfig(id);
      const previousRevision = this.bindingRevisions.get(id);
      this.configs.delete(id);
      this.bindingRevisions.delete(id);
      try {
        await this.persist();
      } catch (error) {
        this.configs.set(id, current);
        if (previousRevision !== undefined) this.bindingRevisions.set(id, previousRevision);
        throw error;
      }
      await this.manager.removeServer(id);
    });
  }

  public async listChatTools() {
    await this.startConnections();
    return this.lock.withRead(async () => {
      this.assertInitialized();
      return this.manager.listChatTools();
    });
  }

  public async describeTool(name: string): Promise<DesktopMcpToolDescriptor | undefined> {
    return this.lock.withRead(async () => {
      this.assertInitialized();
      return this.describeToolUnsafe(name);
    });
  }

  public async callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: {
      expectedApprovalIdentity?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<McpToolResult> {
    return this.lock.withRead(async () => {
      this.assertInitialized();
      const descriptor = await this.describeToolUnsafe(name);
      if (descriptor === undefined) {
        throw new DesktopError('MCP_TOOL_NOT_FOUND', 'MCP 工具不存在或所属 Server 未连接');
      }
      if (
        options.expectedApprovalIdentity !== undefined &&
        descriptor.approvalIdentity !== options.expectedApprovalIdentity
      ) {
        throw new DesktopError(
          'MCP_TOOL_BINDING_CHANGED',
          'MCP Server 或工具定义在审批后发生变化，请重新发起调用',
        );
      }
      return this.manager.callTool(name, input, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    });
  }

  public async shutdown(): Promise<void> {
    await this.connectionTask?.catch(() => undefined);
    await this.lock.withWrite(async () => {
      await this.manager.shutdown();
      this.initialized = false;
    });
  }

  /**
   * 首次登录后的列表或聊天请求才启动已启用 Server，避免第三方进程阻塞首屏或在登录前运行。
   */
  private async startConnections(): Promise<void> {
    this.assertInitialized();
    if (this.connectionsStarted) {
      await this.connectionTask;
      return;
    }
    this.connectionsStarted = true;
    const task = this.lock
      .withRead(async () => {
        await this.manager.initialize();
      })
      .catch((error: unknown) => {
        this.options.logger.warn('MCP Server 后台连接失败', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    const settled = task.finally(() => {
      if (this.connectionTask === settled) this.connectionTask = undefined;
    });
    this.connectionTask = settled;
    await this.connectionTask;
  }

  private async describeToolUnsafe(name: string): Promise<DesktopMcpToolDescriptor | undefined> {
    const tool = (await this.manager.listTools()).find((candidate) => candidate.name === name);
    if (tool === undefined) return undefined;
    const config = this.requireConfig(tool.serverId);
    const bindingRevision = this.bindingRevisions.get(tool.serverId);
    if (bindingRevision === undefined) return undefined;
    const endpoint =
      config.transport.type === 'stdio'
        ? config.transport.command
        : publicHttpEndpoint(config.transport.url);
    const approvalIdentity = createHash('sha256')
      .update(
        stableSerialize({
          bindingRevision,
          endpoint,
          exposedName: tool.name,
          originalName: tool.originalName,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations ?? {},
        }),
      )
      .digest('hex');
    return {
      ...tool,
      approvalIdentity,
      bindingRevision,
      endpoint,
    };
  }

  private async mapSummaries(): Promise<DesktopMcpServerSummary[]> {
    const tools = await this.manager.listTools().catch(() => []);
    const toolsByServer = new Map<string, string[]>();
    for (const tool of tools) {
      const names = toolsByServer.get(tool.serverId) ?? [];
      names.push(tool.originalName);
      toolsByServer.set(tool.serverId, names);
    }
    return this.manager
      .getServerStatuses()
      .map((status) => this.mapSummary(status, toolsByServer.get(status.id) ?? []));
  }

  private async requireSummary(id: string): Promise<DesktopMcpServerSummary> {
    const summary = (await this.mapSummaries()).find((candidate) => candidate.id === id);
    if (summary === undefined) {
      throw new DesktopError('MCP_SERVER_NOT_FOUND', 'MCP Server 不存在');
    }
    return summary;
  }

  private mapSummary(status: McpServerStatus, tools: string[]): DesktopMcpServerSummary {
    const config = this.requireConfig(status.id);
    return {
      id: status.id,
      displayName: status.displayName,
      enabled: status.enabled,
      transport: status.transport,
      endpoint:
        config.transport.type === 'stdio'
          ? config.transport.command
          : publicHttpEndpoint(config.transport.url),
      state: status.enabled ? status.state : 'disabled',
      toolCount: tools.length,
      tools: [...tools].sort((left, right) => left.localeCompare(right)),
      hasCredentials: containsCredentials(config),
      ...(status.error === undefined ? {} : { lastError: status.error.message }),
      ...(status.connectedAt === undefined ? {} : { updatedAt: status.connectedAt }),
    };
  }

  private requireConfig(id: string): McpServerConfig {
    const config = this.configs.get(id);
    if (config === undefined) {
      throw new DesktopError('MCP_SERVER_NOT_FOUND', 'MCP Server 不存在');
    }
    return config;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new DesktopError('MCP_NOT_READY', 'MCP 运行时尚未初始化');
    }
  }

  private createServerId(displayName: string): string {
    const base = displayName
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48);
    const stem = /^[a-z]/u.test(base) && base.length >= 2 ? base : 'server';
    let id = stem;
    while (this.configs.has(id)) {
      id = `${stem.slice(0, 48)}-${randomUUID().slice(0, 8)}`;
    }
    return id;
  }

  private async readPersistedConfigs(): Promise<McpServerConfig[]> {
    if (this.options.secrets !== undefined) {
      const encrypted = await this.options.secrets.readJson<unknown>(encryptedStateName);
      if (encrypted !== undefined) {
        this.legacyMigrationPending = await this.legacyStateFileExists();
        return parsePersistedPayload(encrypted);
      }
    }
    try {
      const metadata = await stat(this.options.stateFile);
      if (metadata.size > maximumConfigBytes) {
        throw new DesktopError('MCP_CONFIG_TOO_LARGE', 'MCP 配置文件超过安全大小上限');
      }
      const decoded: unknown = JSON.parse(await readFile(this.options.stateFile, 'utf8'));
      const configs = parsePersistedPayload(decoded);
      this.legacyMigrationPending = this.options.secrets !== undefined;
      return configs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.options.logger.error('MCP 配置读取失败，已使用空配置启动', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return [];
    }
  }

  /**
   * 检查旧版明文配置是否仍然存在。无法确认文件状态时必须阻止启动，
   * 避免将残留凭据误判为已经安全迁移。
   */
  private async legacyStateFileExists(): Promise<boolean> {
    try {
      await stat(this.options.stateFile);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new DesktopError(
        'MCP_LEGACY_CONFIG_CHECK_FAILED',
        '无法确认旧版 MCP 明文配置状态，请检查文件权限后重试',
      );
    }
  }

  /**
   * 加密副本写入成功后同步删除旧版明文文件，并再次验证删除结果。
   * 删除失败时保持迁移待处理状态并阻止应用继续启动。
   */
  private async removeLegacyPlaintext(): Promise<void> {
    try {
      await rm(this.options.stateFile, { force: true });
    } catch {
      throw new DesktopError(
        'MCP_LEGACY_CONFIG_DELETE_FAILED',
        'MCP 配置已加密，但旧版明文文件无法删除，请检查文件权限后重试',
      );
    }
    if (await this.legacyStateFileExists()) {
      throw new DesktopError(
        'MCP_LEGACY_CONFIG_DELETE_FAILED',
        'MCP 配置已加密，但旧版明文文件仍然存在，请手动移除后重试',
      );
    }
  }

  private async persist(): Promise<void> {
    const payload: PersistedMcpServers = {
      schemaVersion: 1,
      servers: [...this.configs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (this.options.secrets !== undefined) {
      await this.options.secrets.writeJson(encryptedStateName, payload);
      return;
    }
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    const temporary = `${this.options.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, this.options.stateFile);
      await chmod(this.options.stateFile, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new DesktopError(
        'MCP_CONFIG_WRITE_FAILED',
        error instanceof Error ? error.message : 'MCP 配置保存失败',
      );
    }
  }
}

function publicHttpEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function parsePersistedPayload(value: unknown): McpServerConfig[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as Record<string, unknown>)['schemaVersion'] !== 1
  ) {
    throw new DesktopError('MCP_CONFIG_INVALID', 'MCP 配置文件版本无效');
  }
  return parseMcpServerConfigs((value as Record<string, unknown>)['servers']);
}

function containsCredentials(config: McpServerConfig): boolean {
  return config.transport.type === 'stdio'
    ? Object.keys(config.transport.env).length > 0
    : Object.keys(config.transport.headers).length > 0;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeInheritedEnvironmentNames(): string[] {
  return process.platform === 'win32'
    ? ['COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE']
    : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR'];
}

class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly waitingReaders: Array<(release: () => void) => void> = [];
  private readonly waitingWriters: Array<(release: () => void) => void> = [];

  public async withRead<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireRead();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireWrite();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireRead(): Promise<() => void> {
    if (!this.writerActive && this.waitingWriters.length === 0) {
      this.activeReaders += 1;
      return Promise.resolve(this.createReadRelease());
    }
    return new Promise((resolve) => this.waitingReaders.push(resolve));
  }

  private acquireWrite(): Promise<() => void> {
    if (!this.writerActive && this.activeReaders === 0) {
      this.writerActive = true;
      return Promise.resolve(this.createWriteRelease());
    }
    return new Promise((resolve) => this.waitingWriters.push(resolve));
  }

  private createReadRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReaders -= 1;
      this.drain();
    };
  }

  private createWriteRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writerActive = false;
      this.drain();
    };
  }

  private drain(): void {
    if (this.writerActive || this.activeReaders > 0) return;
    const writer = this.waitingWriters.shift();
    if (writer !== undefined) {
      this.writerActive = true;
      writer(this.createWriteRelease());
      return;
    }
    const readers = this.waitingReaders.splice(0);
    this.activeReaders += readers.length;
    for (const reader of readers) reader(this.createReadRelease());
  }
}
