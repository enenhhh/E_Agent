import { describe, expect, it, vi } from 'vitest';

import {
  McpClient,
  McpManager,
  McpRuntimeError,
  createMcpToolName,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
  type McpTransportMessageListener,
  type SupportedMcpProtocolVersion,
} from '../src/index.js';

class FakeTransport implements McpTransport {
  public readonly kind = 'stdio' as const;
  public connected = false;
  public notifications: JsonRpcNotification[] = [];
  public calls: JsonRpcRequest[] = [];
  public protocolVersion: string | undefined;
  private readonly listeners = new Set<McpTransportMessageListener>();

  public constructor(
    private readonly handler: (request: JsonRpcRequest) => unknown | Promise<unknown> = (
      request,
    ) => {
      if (request.method === 'initialize') {
        return {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake', version: '1.0.0' },
        };
      }
      if (request.method === 'tools/list') {
        const cursor = request.params?.['cursor'];
        return cursor === undefined
          ? {
              tools: [
                {
                  name: 'read-file',
                  description: 'Read',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
              nextCursor: 'page-2',
            }
          : {
              tools: [
                {
                  name: 'write_file',
                  description: 'Write',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            };
      }
      if (request.method === 'tools/call') {
        return { content: [{ type: 'text', text: 'done' }], isError: false };
      }
      return {};
    },
  ) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async request(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.calls.push(request);
    const value = await this.handler(request);
    if (
      value !== null &&
      typeof value === 'object' &&
      'error' in value &&
      typeof value.error === 'object'
    ) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        ...(value as { error: { code: number; message: string; data?: unknown } }),
      };
    }
    return { jsonrpc: '2.0', id: request.id, result: value };
  }

  public async notify(notification: JsonRpcNotification): Promise<void> {
    this.notifications.push(notification);
  }

  public async respond(
    _id: JsonRpcId,
    _result: unknown,
    _error?: { code: number; message: string },
  ): Promise<void> {}

  public setProtocolVersion(version: SupportedMcpProtocolVersion): void {
    this.protocolVersion = version;
  }

  public subscribe(listener: McpTransportMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.connected = false;
  }

  public async emit(message: JsonRpcMessage): Promise<void> {
    for (const listener of this.listeners) await listener(message);
  }
}

describe('McpClient', () => {
  it('完成握手、分页发现、缓存、失效通知和工具调用', async () => {
    const transport = new FakeTransport();
    const client = new McpClient({
      serverId: 'fake.server',
      displayName: 'Fake',
      transport,
    });
    const changed = vi.fn();
    client.onToolsChanged(changed);

    await expect(client.connect()).resolves.toMatchObject({
      protocolVersion: '2025-11-25',
    });
    expect(transport.protocolVersion).toBe('2025-11-25');
    expect(transport.notifications).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    await expect(client.listTools()).resolves.toHaveLength(2);
    await client.listTools();
    expect(transport.calls.filter((call) => call.method === 'tools/list')).toHaveLength(2);

    await transport.emit({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    expect(changed).toHaveBeenCalledOnce();
    await client.listTools();
    expect(transport.calls.filter((call) => call.method === 'tools/list')).toHaveLength(4);

    await expect(client.callTool('read-file', { path: 'README.md' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    });
    await expect(client.callTool('unknown')).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
    await client.close();
  });

  it('拒绝未知协议并净化服务端错误', async () => {
    const unsupported = new McpClient({
      serverId: 'future.server',
      displayName: 'Future',
      transport: new FakeTransport((request) =>
        request.method === 'initialize'
          ? {
              protocolVersion: '2099-01-01',
              capabilities: {},
              serverInfo: { name: 'future', version: '1' },
            }
          : {},
      ),
    });
    await expect(unsupported.connect()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });

    const secret = 'sk-test-never-expose-123456789';
    const failed = new McpClient({
      serverId: 'error.server',
      displayName: 'Error',
      transport: new FakeTransport((request) =>
        request.method === 'initialize'
          ? {
              error: { code: -32_000, message: `Authorization: Bearer ${secret}` },
            }
          : {},
      ),
    });
    const error = await failed.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpRuntimeError);
    expect((error as Error).message).not.toContain(secret);
  });
});

describe('McpManager', () => {
  it('建立稳定命名空间、应用工具策略并输出 ChatTool', async () => {
    const transports = new Map<string, FakeTransport>();
    const manager = new McpManager({
      servers: [
        {
          id: 'local.files',
          displayName: 'Local Files',
          transport: { type: 'stdio', command: 'fake' },
          toolPolicy: { deny: ['write_*'] },
        },
      ],
      clientFactory: (config) => {
        const transport = new FakeTransport();
        transports.set(config.id, transport);
        return new McpClient({
          serverId: config.id,
          displayName: config.displayName,
          transport,
        });
      },
    });

    await manager.initialize();
    const tools = await manager.listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'mcp_local_files_read-file',
        originalName: 'read-file',
        serverId: 'local.files',
      }),
    ]);
    expect(await manager.listChatTools()).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'mcp_local_files_read-file' }),
      }),
    ]);
    await expect(
      manager.callTool('mcp_local_files_read-file', { path: 'README.md' }),
    ).resolves.toMatchObject({ isError: false });
    expect(manager.getServerStatuses()[0]).toMatchObject({
      state: 'connected',
      toolCount: 1,
    });
    await manager.shutdown();
  });

  it('工具名不超过 64 字符且长名称保持稳定', () => {
    const value = createMcpToolName(
      'very.long.server.identifier.with.many.parts',
      'a-tool-name-that-is-deliberately-much-longer-than-provider-function-name-limits',
    );
    expect(value.length).toBeLessThanOrEqual(64);
    expect(value).toBe(
      createMcpToolName(
        'very.long.server.identifier.with.many.parts',
        'a-tool-name-that-is-deliberately-much-longer-than-provider-function-name-limits',
      ),
    );
  });

  it('缓存读取不隐式联网，并覆盖服务增删、启停、重连和事件', async () => {
    const factory = vi.fn((config) => {
      const transport = new FakeTransport();
      return new McpClient({
        serverId: config.id,
        displayName: config.displayName,
        transport,
      });
    });
    const manager = new McpManager({
      servers: [
        {
          id: 'disabled.server',
          displayName: 'Disabled',
          enabled: false,
          transport: { type: 'stdio', command: 'fake' },
        },
      ],
      clientFactory: factory,
    });
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event.type));

    await expect(manager.listTools()).resolves.toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    await expect(manager.connect('disabled.server')).rejects.toMatchObject({
      code: 'SERVER_DISABLED',
    });
    await expect(manager.setServerEnabled('disabled.server', true)).resolves.toMatchObject({
      state: 'connected',
    });
    await expect(manager.reconnect('disabled.server')).resolves.toMatchObject({
      state: 'connected',
    });
    await expect(manager.refreshTools('disabled.server')).resolves.toHaveLength(2);
    await expect(manager.setServerEnabled('disabled.server', false)).resolves.toMatchObject({
      state: 'disconnected',
      enabled: false,
    });

    await manager.upsertServer(
      {
        id: 'new.server',
        displayName: 'New',
        enabled: false,
        transport: { type: 'stdio', command: 'fake' },
      },
      { connect: false },
    );
    await manager.removeServer('new.server');
    await expect(manager.disconnect('missing.server')).rejects.toMatchObject({
      code: 'SERVER_NOT_FOUND',
    });
    expect(events).toContain('server-status');
    unsubscribe();
    await manager.shutdown();
  });

  it('隔离连接错误、工具错误和排队取消', async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const transport = new FakeTransport(async (request) => {
      if (request.method === 'initialize') {
        return {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'queue', version: '1.0.0', title: 'Queue tools' },
        };
      }
      if (request.method === 'tools/list') {
        return {
          tools: [
            {
              name: 'slow',
              title: 'Slow',
              description: 'Wait',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      }
      if (request.method === 'tools/call') {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (calls === 2) {
          return { error: { code: -32_000, message: 'tool failed' } };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      }
      return {};
    });
    const manager = new McpManager({
      servers: [
        {
          id: 'queue.server',
          displayName: 'Queue',
          maxConcurrentCalls: 1,
          transport: { type: 'stdio', command: 'fake' },
        },
      ],
      clientFactory: (config) =>
        new McpClient({
          serverId: config.id,
          displayName: config.displayName,
          transport,
        }),
    });
    const errors: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'server-error') errors.push(event.error.code);
    });
    await manager.initialize();
    expect(await manager.listTools()).toEqual([
      expect.objectContaining({
        title: 'Slow',
        outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      }),
    ]);

    const first = manager.callTool('mcp_queue_server_slow');
    const controller = new AbortController();
    const second = manager.callTool('mcp_queue_server_slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ isError: false });
    await expect(manager.callTool('mcp_queue_server_slow')).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });
    await expect(manager.callTool('missing_tool')).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
    expect(errors).toContain('SERVER_ERROR');
    await manager.shutdown();
  });

  it('initialize 保留单服务失败状态而不阻断其他服务', async () => {
    const manager = new McpManager({
      servers: [
        {
          id: 'broken.server',
          displayName: 'Broken',
          transport: { type: 'stdio', command: 'fake' },
        },
      ],
      clientFactory: (config) =>
        new McpClient({
          serverId: config.id,
          displayName: config.displayName,
          transport: new FakeTransport(() => {
            throw new Error('sk-test-private-connect-error-123456');
          }),
        }),
    });
    await expect(manager.initialize()).resolves.toEqual([
      expect.objectContaining({
        state: 'error',
        error: expect.objectContaining({ code: 'CONNECT_FAILED' }),
      }),
    ]);
    expect(manager.getServerStatuses()[0]?.error?.message).not.toContain(
      'sk-test-private-connect-error-123456',
    );
    await manager.shutdown();
  });

  it('合并同一 Server 的并发连接，不创建重复 Client', async () => {
    let clientCount = 0;
    let releaseInitialize: (() => void) | undefined;
    const manager = new McpManager({
      servers: [
        {
          id: 'shared.server',
          displayName: 'Shared',
          transport: { type: 'stdio', command: 'fake' },
        },
      ],
      clientFactory: (config) => {
        clientCount += 1;
        return new McpClient({
          serverId: config.id,
          displayName: config.displayName,
          transport: new FakeTransport(async (request) => {
            if (request.method === 'initialize') {
              await new Promise<void>((resolve) => {
                releaseInitialize = resolve;
              });
              return {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'shared', version: '1.0.0' },
              };
            }
            if (request.method === 'tools/list') return { tools: [] };
            return {};
          }),
        });
      },
    });

    const first = manager.connect('shared.server');
    const second = manager.connect('shared.server');
    await vi.waitFor(() => expect(clientCount).toBe(1));
    releaseInitialize?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(clientCount).toBe(1);
    await manager.shutdown();
  });
});
