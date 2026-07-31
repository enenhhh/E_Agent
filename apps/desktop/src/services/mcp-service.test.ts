import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  McpChatTool,
  McpManagedTool,
  McpServerStatus,
  McpToolResult,
} from '@e-agent/mcp-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLogger } from './logger.js';
import { DesktopMcpService } from './mcp-service.js';
import { DesktopSecretStore } from './secret-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createService(options: { encrypted?: boolean; initialize?: boolean } = {}): Promise<{
  directory: string;
  stateFile: string;
  service: DesktopMcpService;
  logger: AppLogger;
  secrets: DesktopSecretStore | undefined;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-mcp-'));
  temporaryDirectories.push(directory);
  const logger = new AppLogger(join(directory, 'logs'));
  await logger.initialize();
  const stateFile = join(directory, 'mcp', 'servers.json');
  const secrets =
    options.encrypted === true
      ? new DesktopSecretStore({
          directory: join(directory, 'secrets'),
          developmentMode: false,
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from(`safe:${value}`, 'utf8'),
            decryptString: (value) => value.toString('utf8').slice('safe:'.length),
          },
        })
      : undefined;
  const service = new DesktopMcpService({
    stateFile,
    logger,
    clientVersion: 'test',
    ...(secrets === undefined ? {} : { secrets }),
  });
  if (options.initialize !== false) await service.initialize();
  return { directory, stateFile, service, logger, secrets };
}

interface ManagerHandle {
  initialize(): Promise<readonly McpServerStatus[]>;
  connect(id: string): Promise<McpServerStatus>;
  refreshTools(id?: string): Promise<readonly McpManagedTool[]>;
  listTools(): Promise<readonly McpManagedTool[]>;
  listChatTools(): Promise<readonly McpChatTool[]>;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpToolResult>;
  getServerStatuses(): readonly McpServerStatus[];
  shutdown(): Promise<void>;
}

function managerOf(service: DesktopMcpService): ManagerHandle {
  return (service as unknown as { manager: ManagerHandle }).manager;
}

function createManagedTool(
  serverId = 'project-memory',
  overrides: Partial<McpManagedTool> = {},
): McpManagedTool {
  return {
    name: `mcp_${serverId.replaceAll('-', '_')}_read-file`,
    originalName: 'read-file',
    serverId,
    serverName: 'Project Memory',
    description: '读取项目文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('DesktopMcpService', () => {
  it('持久化停用的 stdio Server，并以脱敏摘要返回配置', async () => {
    const { service, stateFile } = await createService();

    const saved = await service.save({
      displayName: 'Project Memory',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });

    expect(saved).toMatchObject({
      id: 'project-memory',
      displayName: 'Project Memory',
      enabled: false,
      endpoint: 'node',
      state: 'disabled',
      toolCount: 0,
    });
    expect(await service.list()).toEqual([saved]);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
      schemaVersion: number;
      servers: Array<{ transport: { type: string; env: Record<string, string> } }>;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.servers[0]?.transport).toMatchObject({
      type: 'stdio',
      env: {},
    });
    await service.shutdown();
  });

  it('HTTP 摘要不会把查询参数中的敏感值返回给渲染进程，并可移除配置', async () => {
    const { service } = await createService();
    const saved = await service.save({
      displayName: 'Remote Search',
      enabled: false,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/tools?token=secret-value',
    });

    expect(saved.endpoint).toBe('https://mcp.example.com/tools');
    expect(saved.endpoint).not.toContain('secret-value');
    await service.remove(saved.id);
    expect(await service.list()).toEqual([]);
    await service.shutdown();
  });

  it('配置损坏时 fail closed 使用空目录，不阻断桌面应用启动', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-mcp-'));
    temporaryDirectories.push(directory);
    const logger = new AppLogger(join(directory, 'logs'));
    await logger.initialize();
    const stateFile = join(directory, 'servers.json');
    await writeFile(stateFile, '{"schemaVersion":1,"servers":"invalid"}', 'utf8');
    const service = new DesktopMcpService({ stateFile, logger });

    await expect(service.initialize()).resolves.toBeUndefined();
    await expect(service.list()).resolves.toEqual([]);
    await service.shutdown();
  });

  it('使用系统密钥环加密保存 MCP Headers，摘要和旧明文文件均不泄露凭据', async () => {
    const { directory, service, stateFile } = await createService({ encrypted: true });
    const saved = await service.save({
      displayName: 'Private Search',
      enabled: false,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/tools',
      headers: { Authorization: 'Bearer mcp-secret-value' },
    });

    expect(saved).toMatchObject({
      hasCredentials: true,
      endpoint: 'https://mcp.example.com/tools',
    });
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const encrypted = await readFile(join(directory, 'secrets', 'mcp-servers.enc'), 'utf8');
    expect(encrypted).not.toContain('mcp-secret-value');
    expect(JSON.stringify(await service.list())).not.toContain('mcp-secret-value');
    await service.shutdown();
  });

  it('串行化并发保存与移除，磁盘和运行时不会复活已删除 Server', async () => {
    const { service, stateFile } = await createService();
    const save = service.save({
      displayName: 'Concurrent',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const remove = service.remove('concurrent');
    await Promise.all([save, remove]);

    expect(await service.list()).toEqual([]);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
      servers: unknown[];
    };
    expect(persisted.servers).toEqual([]);
    await service.shutdown();
  });

  it('在初始化完成前拒绝所有需要运行时状态的操作', async () => {
    const { service } = await createService({ initialize: false });

    expect(() => service.activate()).toThrowError(
      expect.objectContaining({ code: 'MCP_NOT_READY' }),
    );
    await expect(service.list()).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
    await expect(
      service.save({
        displayName: 'Not Ready',
        enabled: false,
        transport: 'stdio',
        command: 'node',
      }),
    ).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
    await expect(service.setEnabled('missing', true)).rejects.toMatchObject({
      code: 'MCP_NOT_READY',
    });
    await expect(service.refresh('missing')).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
    await expect(service.remove('missing')).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
    await expect(service.describeTool('missing')).rejects.toMatchObject({
      code: 'MCP_NOT_READY',
    });
    await expect(service.callTool('missing', {})).rejects.toMatchObject({
      code: 'MCP_NOT_READY',
    });
    await expect(service.listChatTools()).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
    await service.shutdown();
  });

  it('映射服务器状态、排序工具名称并隐藏 HTTP 查询参数和凭据', async () => {
    const { service } = await createService({ encrypted: true });
    const local = await service.save({
      displayName: 'Local',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const remote = await service.save({
      displayName: 'Remote',
      enabled: false,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/api/tools?access_token=secret#private',
      headers: { Authorization: 'Bearer secret' },
    });
    const manager = managerOf(service);
    vi.spyOn(manager, 'listTools').mockResolvedValue([
      createManagedTool(local.id, {
        name: 'mcp_local_zeta',
        originalName: 'zeta',
        serverName: 'Local',
      }),
      createManagedTool(local.id, {
        name: 'mcp_local_alpha',
        originalName: 'alpha',
        serverName: 'Local',
      }),
      createManagedTool(remote.id, {
        name: 'mcp_remote_search',
        originalName: 'search',
        serverName: 'Remote',
      }),
    ]);
    vi.spyOn(manager, 'getServerStatuses').mockReturnValue([
      {
        id: local.id,
        displayName: 'Local',
        enabled: true,
        transport: 'stdio',
        state: 'error',
        toolCount: 2,
        error: { code: 'CONNECT_FAILED', message: 'connection unavailable', retryable: true },
      },
      {
        id: remote.id,
        displayName: 'Remote',
        enabled: false,
        transport: 'streamable-http',
        state: 'connected',
        toolCount: 1,
        connectedAt: '2026-07-29T12:00:00.000Z',
      },
    ]);

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: local.id,
        state: 'error',
        tools: ['alpha', 'zeta'],
        lastError: 'connection unavailable',
        hasCredentials: false,
      }),
      expect.objectContaining({
        id: remote.id,
        endpoint: 'https://mcp.example.com/api/tools',
        state: 'disabled',
        tools: ['search'],
        updatedAt: '2026-07-29T12:00:00.000Z',
        hasCredentials: true,
      }),
    ]);
    expect(JSON.stringify(await service.list())).not.toContain('access_token');
    expect(JSON.stringify(await service.list())).not.toContain('Bearer secret');
    await service.shutdown();
  });

  it('工具缓存读取失败时仍返回无工具的服务器摘要', async () => {
    const { service } = await createService();
    const saved = await service.save({
      displayName: 'Offline Cache',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    vi.spyOn(managerOf(service), 'listTools').mockRejectedValue(new Error('cache failed'));

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: saved.id, toolCount: 0, tools: [] }),
    ]);
    await service.shutdown();
  });

  it('仅启动一次后台连接，并让等待中的写操作优先于后续读取', async () => {
    const { service } = await createService();
    await service.save({
      displayName: 'Existing',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const manager = managerOf(service);
    const connection = deferred<readonly McpServerStatus[]>();
    const initialize = vi.spyOn(manager, 'initialize').mockReturnValue(connection.promise);
    const chatTools: McpChatTool[] = [
      {
        type: 'function',
        function: { name: 'mcp_existing_read', parameters: { type: 'object' } },
      },
    ];
    vi.spyOn(manager, 'listChatTools').mockResolvedValue(chatTools);

    service.activate();
    service.activate();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));

    const save = service.save({
      displayName: 'Queued Writer',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const list = service.list();
    let listSettled = false;
    void list.finally(() => {
      listSettled = true;
    });
    await Promise.resolve();
    expect(listSettled).toBe(false);

    connection.resolve([]);
    await expect(save).resolves.toMatchObject({ id: 'queued-writer' });
    await expect(list).resolves.toHaveLength(2);
    await expect(service.listChatTools()).resolves.toEqual(chatTools);
    expect(initialize).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('后台连接失败仅记录警告，后续工具列表仍可读取', async () => {
    const { service, logger } = await createService();
    const manager = managerOf(service);
    vi.spyOn(manager, 'initialize').mockRejectedValue(new Error('startup failed'));
    vi.spyOn(manager, 'listChatTools').mockResolvedValue([]);
    const warning = vi.spyOn(logger, 'warn');

    await expect(service.listChatTools()).resolves.toEqual([]);
    await expect(service.listChatTools()).resolves.toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('MCP'),
      expect.objectContaining({ message: 'startup failed' }),
    );
    await service.shutdown();
  });

  it('没有安全存储时拒绝保存 stdio 环境变量和 HTTP Headers', async () => {
    const { service } = await createService();

    await expect(
      service.save({
        displayName: 'Private Process',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        env: { API_TOKEN: 'secret' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_STORAGE_UNAVAILABLE' });
    await expect(
      service.save({
        displayName: 'Private HTTP',
        enabled: false,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/tools',
        headers: { Authorization: 'Bearer secret' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_STORAGE_UNAVAILABLE' });
    expect(await service.list()).toEqual([]);
    await service.shutdown();
  });

  it('加密保存 stdio 环境变量、安全继承列表和允许的 HTTP 配置', async () => {
    const { service, secrets } = await createService({ encrypted: true });
    const processServer = await service.save({
      displayName: 'Private Process',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      cwd: 'C:\\workspace',
      env: { API_TOKEN: 'secret' },
      inheritEnv: true,
    });
    const httpServer = await service.save({
      displayName: 'Development HTTP',
      enabled: false,
      transport: 'streamable-http',
      url: 'http://example.test/mcp?ignored=yes',
      headers: { 'X-API-Key': 'secret' },
      allowInsecureHttp: true,
    });

    expect(processServer).toMatchObject({ hasCredentials: true, endpoint: 'node' });
    expect(httpServer).toMatchObject({
      hasCredentials: true,
      endpoint: 'http://example.test/mcp',
    });
    const payload = await secrets?.readJson<{
      servers: Array<{
        id: string;
        transport: { type: string; inheritEnv?: string[]; headers?: Record<string, string> };
      }>;
    }>('mcp-servers');
    const persistedProcess = payload?.servers.find((server) => server.id === processServer.id);
    const persistedHttp = payload?.servers.find((server) => server.id === httpServer.id);
    expect(persistedProcess?.transport.inheritEnv).toContain('PATH');
    expect(persistedHttp?.transport.headers).toEqual({ 'X-API-Key': 'secret' });
    await service.shutdown();
  });

  it('启用连接失败不会撤销配置，并支持停用、刷新和未知服务器错误', async () => {
    const { service } = await createService();
    const manager = managerOf(service);
    const connect = vi.spyOn(manager, 'connect').mockRejectedValue(new Error('offline'));

    const saved = await service.save({
      displayName: 'Enabled Later',
      enabled: true,
      transport: 'stdio',
      command: 'missing-command',
    });
    expect(saved).toMatchObject({ enabled: true, state: 'disconnected' });
    expect(connect).toHaveBeenCalledWith(saved.id);

    await expect(service.setEnabled(saved.id, false)).resolves.toMatchObject({
      enabled: false,
      state: 'disabled',
    });
    await expect(service.setEnabled(saved.id, true)).resolves.toMatchObject({
      enabled: true,
      state: 'disconnected',
    });
    vi.spyOn(manager, 'refreshTools').mockResolvedValue([]);
    await expect(service.refresh(saved.id)).resolves.toMatchObject({ id: saved.id });

    await expect(service.setEnabled('missing', true)).rejects.toMatchObject({
      code: 'MCP_SERVER_NOT_FOUND',
    });
    await expect(service.refresh('missing')).rejects.toMatchObject({
      code: 'MCP_SERVER_NOT_FOUND',
    });
    await expect(service.remove('missing')).rejects.toMatchObject({
      code: 'MCP_SERVER_NOT_FOUND',
    });
    await service.shutdown();
  });

  it('生成稳定的工具审批描述，并拒绝过期绑定后再透传有效调用选项', async () => {
    const { service } = await createService();
    const saved = await service.save({
      displayName: 'Project Memory',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const manager = managerOf(service);
    const tool = createManagedTool(saved.id);
    vi.spyOn(manager, 'listTools').mockResolvedValue([tool]);
    vi.spyOn(manager, 'refreshTools').mockResolvedValue([tool]);
    const call = vi.spyOn(manager, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    });

    const first = await service.describeTool(tool.name);
    expect(first).toMatchObject({
      originalName: 'read-file',
      serverId: saved.id,
      endpoint: 'node',
      annotations: { readOnlyHint: true },
    });
    expect(first?.approvalIdentity).toMatch(/^[a-f0-9]{64}$/u);
    await expect(service.describeTool('missing')).resolves.toBeUndefined();
    await expect(service.callTool('missing', {})).rejects.toMatchObject({
      code: 'MCP_TOOL_NOT_FOUND',
    });

    await service.refresh(saved.id);
    const refreshed = await service.describeTool(tool.name);
    expect(refreshed?.bindingRevision).not.toBe(first?.bindingRevision);
    expect(refreshed?.approvalIdentity).not.toBe(first?.approvalIdentity);
    await expect(
      service.callTool(
        tool.name,
        { path: 'README.md' },
        { expectedApprovalIdentity: first?.approvalIdentity },
      ),
    ).rejects.toMatchObject({ code: 'MCP_TOOL_BINDING_CHANGED' });
    expect(call).not.toHaveBeenCalled();

    const controller = new AbortController();
    await expect(
      service.callTool(
        tool.name,
        { path: 'README.md' },
        {
          expectedApprovalIdentity: refreshed?.approvalIdentity,
          signal: controller.signal,
          timeoutMs: 1_234,
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(call).toHaveBeenCalledWith(
      tool.name,
      { path: 'README.md' },
      { signal: controller.signal, timeoutMs: 1_234 },
    );
    await expect(service.callTool(tool.name, {})).resolves.toMatchObject({ isError: false });
    await service.shutdown();
  });

  it('写入失败时回滚新增、启用和删除操作', async () => {
    const { service, secrets } = await createService({ encrypted: true });
    if (secrets === undefined) throw new Error('test setup failed');
    const writeJson = vi.spyOn(secrets, 'writeJson');
    writeJson.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      service.save({
        displayName: 'Rollback New',
        enabled: false,
        transport: 'stdio',
        command: 'node',
      }),
    ).rejects.toThrow('disk full');
    expect(await service.list()).toEqual([]);

    const saved = await service.save({
      displayName: 'Rollback Existing',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    writeJson.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.setEnabled(saved.id, true)).rejects.toThrow('disk full');
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: saved.id, enabled: false }),
    ]);

    writeJson.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.remove(saved.id)).rejects.toThrow('disk full');
    await expect(service.list()).resolves.toEqual([expect.objectContaining({ id: saved.id })]);
    await service.shutdown();
  });

  it('明文旧配置会迁移到加密存储，并可在下一次启动直接恢复', async () => {
    const fixture = await createService({ encrypted: true, initialize: false });
    await mkdir(join(fixture.directory, 'mcp'), { recursive: true });
    await writeFile(
      fixture.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: 'legacy-server',
            displayName: 'Legacy Server',
            enabled: false,
            transport: { type: 'stdio', command: 'node' },
          },
        ],
      }),
      'utf8',
    );

    await fixture.service.initialize();
    await fixture.service.initialize();
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({ id: 'legacy-server', state: 'disabled' }),
    ]);
    await expect(stat(fixture.stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(join(fixture.directory, 'secrets', 'mcp-servers.enc')),
    ).resolves.toBeDefined();
    await fixture.service.shutdown();

    if (fixture.secrets === undefined) throw new Error('test setup failed');
    const restored = new DesktopMcpService({
      stateFile: fixture.stateFile,
      logger: fixture.logger,
      secrets: fixture.secrets,
    });
    await restored.initialize();
    await expect(restored.list()).resolves.toEqual([
      expect.objectContaining({ id: 'legacy-server', displayName: 'Legacy Server' }),
    ]);
    await restored.shutdown();
  });

  it('加密配置存在时仍会清理崩溃恢复后残留的旧版明文文件', async () => {
    const fixture = await createService({ encrypted: true });
    await fixture.service.save({
      displayName: 'Encrypted Source',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    await fixture.service.shutdown();
    await mkdir(join(fixture.directory, 'mcp'), { recursive: true });
    await writeFile(
      fixture.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: 'stale-plaintext',
            displayName: 'Stale Plaintext',
            enabled: false,
            transport: {
              type: 'streamable-http',
              url: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer must-be-removed' },
            },
          },
        ],
      }),
      'utf8',
    );

    if (fixture.secrets === undefined) throw new Error('test setup failed');
    const restored = new DesktopMcpService({
      stateFile: fixture.stateFile,
      logger: fixture.logger,
      secrets: fixture.secrets,
    });
    await restored.initialize();

    await expect(restored.list()).resolves.toEqual([
      expect.objectContaining({ id: 'encrypted-source' }),
    ]);
    await expect(stat(fixture.stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await restored.shutdown();
  });

  it('旧版明文文件无法删除时阻止启动，避免误报迁移成功', async () => {
    const fixture = await createService({ encrypted: true });
    await fixture.service.save({
      displayName: 'Encrypted Source',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    await fixture.service.shutdown();
    await mkdir(fixture.stateFile, { recursive: true });

    if (fixture.secrets === undefined) throw new Error('test setup failed');
    const restored = new DesktopMcpService({
      stateFile: fixture.stateFile,
      logger: fixture.logger,
      secrets: fixture.secrets,
    });

    await expect(restored.initialize()).rejects.toMatchObject({
      code: 'MCP_LEGACY_CONFIG_DELETE_FAILED',
    });
  });

  it('拒绝加密存储中的无效版本，并隔离过大的旧配置文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-mcp-'));
    temporaryDirectories.push(directory);
    const logger = new AppLogger(join(directory, 'logs'));
    await logger.initialize();
    const invalidEncrypted = new DesktopMcpService({
      stateFile: join(directory, 'unused.json'),
      logger,
      secrets: {
        readJson: vi.fn().mockResolvedValue({ schemaVersion: 2, servers: [] }),
        writeJson: vi.fn(),
      },
    });
    await expect(invalidEncrypted.initialize()).rejects.toMatchObject({
      code: 'MCP_CONFIG_INVALID',
    });

    const stateFile = join(directory, 'oversized.json');
    await writeFile(stateFile, 'x'.repeat(2 * 1_024 * 1_024 + 1), 'utf8');
    const oversized = new DesktopMcpService({ stateFile, logger });
    await expect(oversized.initialize()).resolves.toBeUndefined();
    await expect(oversized.list()).resolves.toEqual([]);
    await oversized.shutdown();
  });

  it('为无法规范化的重复名称生成唯一服务器 ID，并校验显式非法 ID', async () => {
    const { service } = await createService();
    const first = await service.save({
      displayName: '中文服务',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });
    const second = await service.save({
      displayName: '中文服务',
      enabled: false,
      transport: 'stdio',
      command: 'node',
    });

    expect(first.id).toBe('server');
    expect(second.id).toMatch(/^server-[a-f0-9]{8}$/u);
    expect(second.id).not.toBe(first.id);
    await expect(
      service.save({
        id: 'Invalid ID',
        displayName: 'Invalid',
        enabled: false,
        transport: 'stdio',
        command: 'node',
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await service.shutdown();
  });

  it('关闭时等待后台连接完成，并将服务恢复为未初始化状态', async () => {
    const { service } = await createService();
    const manager = managerOf(service);
    const connection = deferred<readonly McpServerStatus[]>();
    vi.spyOn(manager, 'initialize').mockReturnValue(connection.promise);
    const shutdown = vi.spyOn(manager, 'shutdown');
    service.activate();
    await vi.waitFor(() => expect(manager.initialize).toHaveBeenCalledOnce());

    const closing = service.shutdown();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    connection.resolve([]);
    await closing;
    expect(shutdown).toHaveBeenCalledOnce();
    await expect(service.list()).rejects.toMatchObject({ code: 'MCP_NOT_READY' });
  });
});
