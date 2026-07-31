import { McpRuntimeError, toSafeMcpError } from './errors.js';
import {
  initializeResultSchema,
  isJsonRpcNotification,
  isJsonRpcRequest,
  listToolsResultSchema,
  mcpToolResultSchema,
  preferredMcpProtocolVersion,
  supportedMcpProtocolVersions,
  type JsonRpcFailure,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type McpInitializeResult,
  type McpTool,
  type McpToolResult,
  type SupportedMcpProtocolVersion,
} from './protocol.js';
import { redactMcpValue } from './redaction.js';
import type { McpRequestOptions, McpRuntimeLogger, McpTransport } from './transport.js';

export interface McpClientOptions {
  serverId: string;
  displayName: string;
  transport: McpTransport;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  clientInfo?: {
    name: string;
    version: string;
  };
  protocolVersion?: SupportedMcpProtocolVersion;
  logger?: McpRuntimeLogger;
}

export type McpClientState = 'connected' | 'connecting' | 'disconnected';

/** 完成 MCP 握手、分页工具发现、调用及服务器通知处理。 */
export class McpClient {
  private stateValue: McpClientState = 'disconnected';
  private requestSequence = 0;
  private initializeResultValue: McpInitializeResult | undefined;
  private toolsCache: readonly McpTool[] | undefined;
  private unsubscribeTransport: (() => void) | undefined;
  private readonly toolsChangedListeners = new Set<() => void>();

  public constructor(private readonly options: McpClientOptions) {}

  public get state(): McpClientState {
    return this.stateValue;
  }

  public get initializeResult(): McpInitializeResult | undefined {
    return this.initializeResultValue;
  }

  public async connect(): Promise<McpInitializeResult> {
    if (this.stateValue === 'connected' && this.initializeResultValue !== undefined) {
      return this.initializeResultValue;
    }
    if (this.stateValue === 'connecting') {
      throw new McpRuntimeError('CONNECT_FAILED', 'MCP 服务正在连接。', {
        serverId: this.options.serverId,
        retryable: true,
      });
    }
    this.stateValue = 'connecting';
    this.unsubscribeTransport = this.options.transport.subscribe((message) =>
      this.handleServerMessage(message),
    );
    try {
      await this.options.transport.connect({
        timeoutMs: this.options.connectTimeoutMs ?? 10_000,
      });
      const preferred = this.options.protocolVersion ?? preferredMcpProtocolVersion;
      const raw = await this.request(
        'initialize',
        {
          protocolVersion: preferred,
          capabilities: {},
          clientInfo: this.options.clientInfo ?? { name: 'E Agent', version: '0.1.0' },
        },
        { timeoutMs: this.options.connectTimeoutMs ?? 10_000 },
      );
      const initialized = initializeResultSchema.safeParse(raw);
      if (!initialized.success) {
        throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP initialize 响应结构无效。', {
          serverId: this.options.serverId,
        });
      }
      if (
        !supportedMcpProtocolVersions.includes(
          initialized.data.protocolVersion as SupportedMcpProtocolVersion,
        )
      ) {
        throw new McpRuntimeError(
          'PROTOCOL_INVALID',
          `MCP 服务选择了不支持的协议版本：${initialized.data.protocolVersion}`,
          { serverId: this.options.serverId },
        );
      }
      this.options.transport.setProtocolVersion(
        initialized.data.protocolVersion as SupportedMcpProtocolVersion,
      );
      this.initializeResultValue = initialized.data;
      await this.options.transport.notify(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { timeoutMs: this.options.connectTimeoutMs ?? 10_000 },
      );
      this.stateValue = 'connected';
      await this.options.transport.startServerStream?.({
        timeoutMs: this.options.connectTimeoutMs ?? 10_000,
      });
      this.log('info', 'MCP 服务连接成功', {
        serverId: this.options.serverId,
        protocolVersion: initialized.data.protocolVersion,
        serverName: initialized.data.serverInfo.name,
        serverVersion: initialized.data.serverInfo.version,
      });
      return initialized.data;
    } catch (error) {
      this.stateValue = 'disconnected';
      this.initializeResultValue = undefined;
      this.unsubscribeTransport?.();
      this.unsubscribeTransport = undefined;
      await this.options.transport.close().catch(() => undefined);
      throw toSafeMcpError(error, 'CONNECT_FAILED', this.options.serverId);
    }
  }

  public async listTools(options: { refresh?: boolean } = {}): Promise<readonly McpTool[]> {
    this.assertConnected();
    if (!options.refresh && this.toolsCache !== undefined) return this.toolsCache;
    if (this.initializeResultValue?.capabilities['tools'] === undefined) {
      this.toolsCache = [];
      return this.toolsCache;
    }
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const raw = await this.request('tools/list', cursor === undefined ? {} : { cursor }, {
        timeoutMs: this.options.requestTimeoutMs ?? 30_000,
      });
      const parsed = listToolsResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP tools/list 响应结构无效。', {
          serverId: this.options.serverId,
        });
      }
      for (const tool of parsed.data.tools) {
        if (names.has(tool.name)) {
          throw new McpRuntimeError('PROTOCOL_INVALID', `MCP 服务返回了重复工具：${tool.name}`, {
            serverId: this.options.serverId,
          });
        }
        names.add(tool.name);
        tools.push(tool);
        if (tools.length > 2_048) {
          throw new McpRuntimeError('LIMIT_EXCEEDED', '单个 MCP 服务的工具数量超过限制。', {
            serverId: this.options.serverId,
          });
        }
      }
      cursor = parsed.data.nextCursor;
      if (cursor === undefined) {
        this.toolsCache = Object.freeze(tools);
        return this.toolsCache;
      }
      if (cursors.has(cursor)) {
        throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP 工具分页游标发生循环。', {
          serverId: this.options.serverId,
        });
      }
      cursors.add(cursor);
    }
    throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP 工具分页超过 100 页。', {
      serverId: this.options.serverId,
    });
  }

  public async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>> = {},
    options: McpRequestOptions = {},
  ): Promise<McpToolResult> {
    this.assertConnected();
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) {
      throw new McpRuntimeError('TOOL_NOT_FOUND', `MCP 工具不存在：${name}`, {
        serverId: this.options.serverId,
      });
    }
    const raw = await this.request(
      'tools/call',
      { name, arguments: argumentsValue },
      { timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000, ...options },
    );
    const parsed = mcpToolResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP tools/call 响应结构无效。', {
        serverId: this.options.serverId,
      });
    }
    return parsed.data;
  }

  public onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => this.toolsChangedListeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.stateValue = 'disconnected';
    this.initializeResultValue = undefined;
    this.toolsCache = undefined;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    await this.options.transport.close();
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestSequence,
      method,
      params,
    };
    const response = await this.options.transport.request(request, options);
    if ('error' in response) {
      throw this.serverError(response);
    }
    return response.result;
  }

  private serverError(response: JsonRpcFailure): McpRuntimeError {
    return new McpRuntimeError(
      'SERVER_ERROR',
      `MCP 服务错误 ${response.error.code}：${response.error.message}`,
      {
        serverId: this.options.serverId,
        retryable: response.error.code === -32_001 || response.error.code === -32_002,
      },
    );
  }

  private async handleServerMessage(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcNotification(message)) {
      if (message.method === 'notifications/tools/list_changed') {
        this.toolsCache = undefined;
        for (const listener of this.toolsChangedListeners) listener();
      } else if (message.method === 'notifications/message') {
        this.log('debug', '收到 MCP 服务日志通知', {
          serverId: this.options.serverId,
          level:
            typeof message.params?.['level'] === 'string'
              ? message.params['level'].slice(0, 20)
              : 'unknown',
        });
      }
      return;
    }
    if (!isJsonRpcRequest(message)) return;
    if (message.method === 'ping') {
      await this.options.transport.respond(message.id, {});
      return;
    }
    await this.options.transport.respond(message.id, undefined, {
      code: -32_601,
      message: 'Method not supported by E Agent MCP client',
    });
  }

  private assertConnected(): void {
    if (this.stateValue !== 'connected') {
      throw new McpRuntimeError('CONNECTION_CLOSED', 'MCP 客户端尚未连接。', {
        serverId: this.options.serverId,
      });
    }
  }

  private log(
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.options.logger?.(level, message, redactMcpValue(fields ?? {}));
  }
}
