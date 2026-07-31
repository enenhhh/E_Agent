import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpTransport } from './http-transport';
import type { CredentialInput } from './transport';
import { TransportError } from './transport';

const now = '2026-07-28T12:00:00.000Z';
const user = {
  id: 'user-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'owner' as const,
  active: true,
  createdAt: now,
  updatedAt: now,
};
const auth = {
  accessToken: 'fixture-access-token',
  expiresAt: '2026-07-29T12:00:00.000Z',
  user,
};
const provider = {
  id: 'provider-1',
  type: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://example.test/v1',
  enabled: true,
  keyStrategy: 'round-robin' as const,
};
const key = {
  id: 'key-1',
  providerId: provider.id,
  label: 'Primary',
  maskedKey: 'test••••cdef',
  priority: 10,
  health: 'healthy' as const,
  enabled: true,
  dailyLimit: 10,
  monthlyLimit: 100,
  quotaUnit: 'usd' as const,
  todayUsed: 1,
  monthUsed: 5,
  proxyConfigured: false,
  lastCheckedAt: now,
};
const conversation = {
  id: 'conversation-1',
  projectId: null,
  parentConversationId: null,
  title: 'Conversation',
  pinned: false,
  archived: false,
  messageCount: 2,
  updatedAt: now,
};

function stubRequest(
  transport: HttpTransport,
  handler: (path: string, init: RequestInit) => unknown | Promise<unknown>,
) {
  const request = vi.fn(async (path: string, init: RequestInit = {}) => handler(path, init));
  Object.defineProperty(transport, 'request', {
    configurable: true,
    value: request,
  });
  return request;
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('HttpTransport extended behavior', () => {
  it('覆盖认证、成员、模型和工作区入口', async () => {
    const transport = new HttpTransport('http://127.0.0.1:4318///');
    const request = stubRequest(transport, (path, init) => {
      if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login') return auth;
      if (path === '/api/v1/auth/me') return user;
      if (path === '/api/v1/auth/logout') return null;
      if (path === '/api/v1/users' && init.method === 'POST') return user;
      if (path === '/api/v1/users') return [user];
      if (path.startsWith('/api/v1/users/')) return init.method === 'DELETE' ? null : user;
      if (path === '/api/v1/models/discover') {
        return {
          results: [{ providerId: provider.id, discovered: 1, error: null }],
        };
      }
      if (path === '/api/v1/models') {
        return {
          models: [
            {
              id: 'model-1',
              providerId: provider.id,
              provider: provider.name,
              remoteId: 'deepseek-v4-flash',
              displayName: 'DeepSeek V4 Flash',
              capabilities: ['chat', 'unknown'],
              contextWindow: null,
              inputPricePerMillion: null,
              outputPricePerMillion: null,
              enabled: false,
            },
          ],
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    await expect(
      transport.setup({ name: 'Owner', email: user.email, password: 'valid-password' }),
    ).resolves.toMatchObject({ user: { name: 'Owner', active: true } });
    await expect(transport.getSession()).resolves.toMatchObject({ user: { id: user.id } });
    await expect(
      transport.login({ email: user.email, password: 'valid-password' }),
    ).resolves.toMatchObject({ expiresAt: auth.expiresAt });
    await expect(transport.listUsers()).resolves.toMatchObject([{ name: 'Owner' }]);
    await expect(
      transport.createUser({
        name: 'Member',
        email: 'member@example.com',
        password: 'valid-password',
        role: 'member',
      }),
    ).resolves.toMatchObject({ role: 'owner' });
    await expect(
      transport.updateUser(user.id, { name: 'Renamed', role: 'admin', active: false }),
    ).resolves.toMatchObject({ email: user.email });
    await expect(transport.deleteUser(user.id)).resolves.toBeUndefined();
    await expect(transport.getWorkspaceBinding()).resolves.toBeNull();
    await expect(transport.chooseWorkspace()).rejects.toMatchObject({
      code: 'WORKSPACE_DESKTOP_ONLY',
    });

    await expect(transport.discoverModels(provider.id)).resolves.toMatchObject([
      {
        id: 'model-1',
        contextWindow: 0,
        capabilities: ['chat'],
        available: false,
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      '/api/v1/models/discover',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ force: true, providerId: provider.id }),
      }),
    );
    await expect(transport.logout()).resolves.toBeUndefined();
    expect(window.sessionStorage.getItem('e-agent-access-token')).toBeNull();
  });

  it('定向模型发现失败时返回可识别错误且不读取旧模型缓存', async () => {
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const request = stubRequest(transport, (path) => {
      if (path === '/api/v1/models/discover') {
        return {
          results: [{ providerId: provider.id, discovered: 0, error: 'invalid key' }],
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    await expect(transport.discoverModels(provider.id)).rejects.toMatchObject({
      code: 'MODEL_DISCOVERY_FAILED',
      message: 'invalid key',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('映射全部 Key 健康状态并完成凭据生命周期', async () => {
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const providers = [
      provider,
      {
        ...provider,
        id: 'provider-ollama',
        type: 'ollama',
        name: 'Ollama',
      },
    ];
    const keys = [
      { ...key, id: 'healthy', todayUsed: 9 },
      { ...key, id: 'warning', health: 'warning' as const },
      { ...key, id: 'paused', health: 'paused' as const },
      { ...key, id: 'unhealthy', health: 'unhealthy' as const },
      {
        ...key,
        id: 'unknown',
        providerId: 'missing-provider',
        health: 'unknown' as const,
        dailyLimit: null,
        monthlyLimit: null,
        lastCheckedAt: null,
      },
      {
        ...key,
        id: 'ollama',
        providerId: 'provider-ollama',
        health: 'healthy' as const,
      },
    ];
    stubRequest(transport, (path) => {
      if (path === '/api/v1/keys') return { providers, keys };
      if (path.includes('/check')) return { id: key.id };
      if (path === '/api/v1/keys/check-all') return { results: [] };
      if (path.startsWith('/api/v1/keys/')) return key;
      return null;
    });

    await expect(transport.listCredentials()).resolves.toMatchObject([
      { id: 'healthy', status: 'warning' },
      { id: 'warning', status: 'warning' },
      { id: 'paused', status: 'warning' },
      { id: 'unhealthy', status: 'error' },
      { id: 'unknown', provider: '未知厂商', status: 'unknown' },
      { id: 'ollama', proxyMode: 'local' },
    ]);
    await expect(
      transport.updateCredential(key.id, {
        name: 'Backup',
        apiKey: 'updated-test-key',
        priority: 2,
        dailyLimit: 2,
        monthlyLimit: 20,
        quotaUnit: 'tokens',
        proxyUrl: '',
        enabled: false,
      }),
    ).resolves.toMatchObject({ id: key.id });
    await expect(transport.deleteCredential(key.id)).resolves.toBeUndefined();
    await expect(transport.checkCredential('healthy')).resolves.toMatchObject({ id: 'healthy' });
    await expect(transport.checkAllCredentials()).resolves.toHaveLength(6);
  });

  it('独立管理 Provider，并在 Key 编辑时让空密钥与空代理保持原值', async () => {
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const updatedProvider = {
      ...provider,
      name: 'DeepSeek Updated',
      enabled: false,
      modelDiscoveryError: 'discovery unavailable',
    };
    const request = stubRequest(transport, (path, init) => {
      if (path === '/api/v1/providers' && init.method !== 'POST') {
        return { providers: [provider] };
      }
      if (path === '/api/v1/providers' && init.method === 'POST') return provider;
      if (path === `/api/v1/providers/${provider.id}`) return updatedProvider;
      if (path === `/api/v1/keys/${key.id}`) return key;
      throw new Error(`unexpected request ${path}`);
    });

    await expect(transport.listProviders()).resolves.toMatchObject([
      { id: provider.id, name: provider.name },
    ]);
    await expect(
      transport.createProvider({
        type: 'deepseek',
        name: provider.name,
        baseUrl: provider.baseUrl,
        keyStrategy: 'round-robin',
      }),
    ).resolves.toMatchObject({ id: provider.id });
    await expect(
      transport.updateProvider(provider.id, {
        name: updatedProvider.name,
        enabled: false,
      }),
    ).resolves.toMatchObject({
      name: updatedProvider.name,
      enabled: false,
      modelDiscoveryError: updatedProvider.modelDiscoveryError,
    });
    await transport.updateCredential(key.id, {
      name: 'Renamed',
      apiKey: '',
      proxyUrl: '',
      dailyLimit: undefined,
    });

    const keyPatchCall = request.mock.calls.find(([path]) => path === `/api/v1/keys/${key.id}`);
    expect(JSON.parse(String(keyPatchCall?.[1]?.body))).toEqual({ label: 'Renamed' });
  });

  it('自动创建各类 Provider 并使用安全默认地址', async () => {
    const cases = [
      ['OpenAI Compatible', 'custom'],
      ['OpenAI', 'openai'],
      ['Anthropic', 'anthropic'],
      ['DeepSeek', 'deepseek'],
      ['Groq', 'groq'],
      ['Google', 'google'],
      ['Ollama', 'ollama'],
      ['Private Vendor', 'custom'],
    ] as const;

    for (const [name, expectedType] of cases) {
      const transport = new HttpTransport('http://127.0.0.1:4318');
      let createdProvider: {
        id: string;
        type: string;
        name: string;
        baseUrl: string;
        enabled: boolean;
        keyStrategy: 'round-robin' | 'priority';
      } = provider;
      const request = stubRequest(transport, (path, init) => {
        if (path === '/api/v1/providers' && init.method !== 'POST') return { providers: [] };
        if (path === '/api/v1/providers') {
          const body = JSON.parse(String(init.body)) as {
            type: string;
            name: string;
            baseUrl: string;
            keyStrategy: string;
          };
          expect(body.type).toBe(expectedType);
          expect(body.baseUrl).toMatch(/^https?:\/\//);
          createdProvider = {
            ...provider,
            id: `provider-${expectedType}`,
            type: body.type,
            name: body.name,
            baseUrl: body.baseUrl,
            keyStrategy: body.keyStrategy === 'round-robin' ? 'round-robin' : 'priority',
          };
          return createdProvider;
        }
        if (path === '/api/v1/keys') {
          return {
            ...key,
            id: `key-${expectedType}`,
            providerId: createdProvider.id,
          };
        }
        throw new Error(`unexpected request ${path}`);
      });
      const input: CredentialInput = {
        name: `${name} Key`,
        provider: name,
        apiKey: name === 'Ollama' ? '' : 'test-provider-key',
        strategy: name === 'Groq' ? 'priority' : 'round-robin',
        priority: 1,
      };
      await expect(transport.createCredential(input)).resolves.toMatchObject({
        provider: name,
      });
      expect(request).toHaveBeenCalled();
    }
  });

  it('完成会话、消息、快照、分支和上下文生命周期', async () => {
    const child = {
      ...conversation,
      id: 'conversation-child',
      parentConversationId: conversation.id,
    };
    const message = {
      id: 'message-1',
      conversationId: conversation.id,
      role: 'assistant' as const,
      content: 'hello',
      model: null,
      inputTokens: 2,
      outputTokens: 3,
      createdAt: now,
      toolCalls: [
        {
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    };
    const snapshot = {
      id: 'snapshot-1',
      conversationId: conversation.id,
      messageCount: 1,
      createdAt: now,
    };
    const transport = new HttpTransport('http://127.0.0.1:4318');
    stubRequest(transport, (path, init) => {
      if (path === '/api/v1/conversations' && init.method === 'POST') return conversation;
      if (path.endsWith('/branch')) return child;
      if (path.endsWith('/snapshots') && init.method === 'POST') return snapshot;
      if (path.endsWith('/snapshots')) return [snapshot];
      if (path.includes('/snapshots/') && path.endsWith('/restore')) return conversation;
      if (path.endsWith('/context')) {
        return {
          breakdown: {
            totalTokens: 120,
            contextWindow: 1_000,
            compressed: true,
            sources: [
              { source: 'system', tokens: 10 },
              { source: 'history', tokens: 20 },
              { source: 'memory', tokens: 30 },
              { source: 'file', tokens: 20 },
              { source: 'folder', tokens: 20 },
              { source: 'web', tokens: 20 },
            ],
          },
        };
      }
      if (path.includes('/file-changes/')) return null;
      if (path === `/api/v1/conversations/${conversation.id}` && init.method === 'DELETE') {
        return null;
      }
      if (path === `/api/v1/conversations/${conversation.id}`) return { messages: [message] };
      return conversation;
    });

    await expect(transport.createConversation()).resolves.toMatchObject({
      title: conversation.title,
      branchCount: 0,
    });
    await expect(transport.branchConversation(conversation.id, message.id)).resolves.toMatchObject({
      id: child.id,
    });
    await expect(transport.createSnapshot(conversation.id)).resolves.toEqual(snapshot);
    await expect(transport.listSnapshots(conversation.id)).resolves.toEqual([snapshot]);
    await expect(transport.restoreSnapshot(conversation.id, snapshot.id)).resolves.toMatchObject({
      id: conversation.id,
    });
    await expect(transport.listMessages(conversation.id)).resolves.toMatchObject([
      {
        id: message.id,
        model: undefined,
        toolCalls: [{ name: 'read_file', status: 'pending' }],
      },
    ]);
    await expect(transport.getContext(conversation.id)).resolves.toMatchObject({
      usedTokens: 120,
      compressed: true,
      sources: [
        { label: '系统提示', removable: false },
        { label: '历史消息', removable: false },
        { label: '项目记忆', removable: true },
        { label: '文件', removable: true },
        { label: '目录', removable: true },
        { label: '网页', removable: true },
      ],
    });
    await expect(
      transport.decideFileChange(conversation.id, 'change-1', 'accept', [1, 2]),
    ).resolves.toBeUndefined();
    await expect(transport.deleteConversation(child.id)).resolves.toBeUndefined();
    await expect(transport.deleteConversation(conversation.id)).resolves.toBeUndefined();
  });

  it('上下文端点不存在时使用消息估算回退', async () => {
    const transport = new HttpTransport('http://127.0.0.1:4318');
    stubRequest(transport, (path) => {
      if (path.endsWith('/context')) {
        throw new TransportError('missing', { status: 404 });
      }
      if (path === `/api/v1/conversations/${conversation.id}`) {
        return {
          messages: [
            {
              id: 'message-1',
              conversationId: conversation.id,
              role: 'user',
              content: 'estimate me',
              model: 'test-model',
              inputTokens: 1,
              outputTokens: 0,
              createdAt: now,
              toolCalls: [],
            },
          ],
        };
      }
      if (path === '/api/v1/context/estimate') {
        return {
          breakdown: {
            totalTokens: 3,
            contextWindow: 64_000,
            compressed: false,
            sources: [{ source: 'history', tokens: 3 }],
          },
        };
      }
      throw new Error(`unexpected request ${path}`);
    });
    await expect(transport.getContext(conversation.id)).resolves.toMatchObject({
      usedTokens: 3,
      sources: [{ type: 'history' }],
    });
  });

  it('映射用量、Skill、插件、设置、审计、队列和启动检查', async () => {
    const skill = {
      id: 'com.eagent.doc-gen',
      command: '@doc-gen',
      name: { 'zh-CN': '文档生成', 'en-US': 'Documentation' },
      version: '1.0.0',
      description: { 'zh-CN': '生成文档', 'en-US': 'Generate docs' },
      executor: { pluginId: 'com.eagent.skills', commandId: 'doc-gen' },
      variables: [],
      enabled: true,
    };
    const plugin = {
      manifest: {
        id: 'com.eagent.plugin',
        name: 'Plugin',
        description: 'Description',
        version: '1.0.0',
        types: ['tool', 'hook'],
        permissions: {
          network: { hosts: ['example.com'] },
          fileSystem: { read: ['src/**'], write: ['generated/**'] },
          env: ['SAFE_NAME'],
          notifications: true,
        },
      },
      integrity: 'sha256:fixture',
      enabled: true,
      approved: false,
    };
    const settings = {
      language: 'system' as const,
      theme: 'dark',
      maxConcurrentRequests: 5,
      dailyCostAlertUsd: 5,
      contextCompressionThreshold: 0.7,
      contextCompressionModelId: null,
      desktopNotifications: true,
      autoSnapshotInterval: 50,
      defaultModels: { code: null, chat: null, embedding: null, vision: null },
    };
    window.localStorage.setItem('e-agent-local-settings', '{invalid');
    const transport = new HttpTransport('http://127.0.0.1:4318');
    let systemCall = 0;
    stubRequest(transport, (path) => {
      if (path.includes('/usage/summary')) {
        const model = path.includes('groupBy=model');
        return {
          totals: {
            totalTokens: 100,
            estimatedCostUsd: 0.5,
            requestCount: 2,
            cachedTokens: 25,
          },
          buckets: [
            {
              key: model ? 'model-a' : '2026-07-28',
              totalTokens: 100,
              estimatedCostUsd: 0.5,
              requestCount: 2,
              cachedTokens: 25,
            },
          ],
          costAlert: { thresholdUsd: 5, currentUsd: 0.5 },
        };
      }
      if (path.includes('/usage/records')) {
        return {
          records: [
            {
              id: 'usage-1',
              occurredAt: now,
              model: 'model-a',
              projectId: null,
              inputTokens: 2,
              outputTokens: 3,
              estimatedCostUsd: 0.1,
              durationMs: 42,
              cacheHit: true,
            },
          ],
        };
      }
      if (path === '/api/v1/skills/install') return { skill, enabled: true };
      if (path === '/api/v1/skills') return { skills: [skill] };
      if (path.startsWith('/api/v1/skills/')) return null;
      if (path === '/api/v1/plugins/install') return { manifest: plugin.manifest };
      if (path === '/api/v1/plugins') return { plugins: [plugin] };
      if (path.startsWith('/api/v1/plugins/')) return null;
      if (path === '/api/v1/settings') return settings;
      if (path.startsWith('/api/v1/audit')) {
        return {
          logs: [
            {
              id: 'audit-1',
              actorId: null,
              action: 'test.success',
              targetType: 'system',
              targetId: null,
              metadata: {},
              createdAt: now,
            },
            {
              id: 'audit-2',
              actorId: user.id,
              action: 'test.failure',
              targetType: 'plugin',
              targetId: plugin.manifest.id,
              metadata: { success: false },
              createdAt: now,
            },
          ],
        };
      }
      if (path === '/api/v1/queue/status') return { active: 2, pending: 3 };
      if (path === '/api/v1/system/status') {
        systemCall += 1;
        return {
          status: systemCall === 1 ? 'degraded' : 'ok',
          version: '0.1.0',
          node: systemCall === 1 ? 'v18.0.0' : 'v24.0.0',
          databaseSchemaVersion: systemCall === 1 ? 0 : 1,
          extensionsReady: systemCall !== 1,
          runtime: { memoryRssBytes: systemCall === 1 ? 600 * 1024 * 1024 : 0 },
        };
      }
      return null;
    });

    await expect(transport.getUsageSummary('month')).resolves.toMatchObject({
      range: 'month',
      cacheHitRate: 0.25,
      trend: [{ date: '2026-07-28' }],
      byModel: [{ model: 'model-a' }],
    });
    await expect(transport.listUsageRecords('week')).resolves.toMatchObject([
      { project: '未绑定项目', cacheHit: true },
    ]);
    await expect(transport.listSkills()).resolves.toMatchObject([
      { source: 'local', permissions: ['plugin:com.eagent.skills'] },
    ]);
    await expect(transport.setSkillEnabled(skill.id, false)).resolves.toMatchObject({
      id: skill.id,
    });
    await expect(transport.installSkill('https://example.com/skill.git')).resolves.toMatchObject({
      id: skill.id,
    });
    await expect(transport.installSkill('C:/skills/doc-gen')).resolves.toMatchObject({
      enabled: true,
    });

    await expect(transport.listPlugins()).resolves.toMatchObject([
      {
        id: plugin.manifest.id,
        permissions: [
          'network:example.com',
          'fileSystem:read:src/**',
          'fileSystem:write:generated/**',
          'env:SAFE_NAME',
          'notifications',
          '待授权',
        ],
      },
    ]);
    await expect(transport.setPluginApproved(plugin.manifest.id, true)).resolves.toMatchObject({
      id: plugin.manifest.id,
    });
    await expect(transport.setPluginApproved(plugin.manifest.id, false)).resolves.toMatchObject({
      approved: false,
    });
    await expect(transport.setPluginEnabled(plugin.manifest.id, true)).resolves.toMatchObject({
      enabled: true,
    });
    await expect(transport.installPlugin('https://example.com/plugin.git')).resolves.toMatchObject({
      id: plugin.manifest.id,
    });
    await expect(transport.installPlugin('C:/plugins/local')).resolves.toMatchObject({
      id: plugin.manifest.id,
    });
    await expect(transport.uninstallPlugin(plugin.manifest.id)).resolves.toBeUndefined();

    await expect(transport.getSettings()).resolves.toMatchObject({
      locale: expect.stringMatching(/^(zh-CN|en-US)$/),
      autoCompressContext: true,
      autoUpdate: true,
      telemetryEnabled: false,
      ollamaFallback: false,
    });
    await expect(
      transport.updateSettings({
        locale: 'zh-CN',
        theme: 'light',
        maxConcurrency: 3,
        costAlertThreshold: 2,
        autoCompressContext: false,
        autoUpdate: false,
        telemetryEnabled: true,
        ollamaFallback: true,
        defaultModels: {
          code: 'code-model',
          chat: '',
          summarize: 'summary-model',
          embedding: 'embedding-model',
          vision: 'vision-model',
        },
      }),
    ).resolves.toMatchObject({ theme: 'dark' });
    expect(JSON.parse(window.localStorage.getItem('e-agent-local-settings') ?? '{}')).toEqual({
      autoCompressContext: false,
      autoUpdate: false,
      telemetryEnabled: true,
      ollamaFallback: true,
    });

    await expect(transport.listAuditEntries()).resolves.toMatchObject([
      { actorName: '系统', result: 'success', target: 'system' },
      { actorName: user.id, result: 'failure', target: `plugin:${plugin.manifest.id}` },
    ]);
    await expect(transport.getQueueStatus()).resolves.toEqual({ running: 2, queued: 3 });
    await expect(transport.runStartupCheck()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'E Agent 服务', ok: false }),
        expect.objectContaining({ name: '内存占用', ok: false, message: '600 MB' }),
      ]),
    );
    await expect(transport.runStartupCheck()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'E Agent 服务', ok: true }),
        expect.objectContaining({ name: '内存占用', ok: true, message: '暂无采样' }),
      ]),
    );
  });

  it('导出报表并为失败响应提供安全错误', async () => {
    window.sessionStorage.setItem('e-agent-access-token', 'fixture-access-token');
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('report', { status: 200, headers: { 'content-type': 'text/csv' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(transport.exportUsage('day', 'csv')).resolves.toBeInstanceOf(Blob);
    await expect(transport.exportUsage('week', 'pdf')).rejects.toMatchObject({ status: 500 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer fixture-access-token' },
    });
  });

  it('处理通用请求的网络、认证、信封和相关 ID 错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(new HttpTransport('http://localhost').getQueueStatus()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'FORBIDDEN',
              message: 'denied',
              requestId: 'request-1',
            },
          },
          403,
          { 'x-correlation-id': 'correlation-1' },
        ),
      ),
    );
    await expect(new HttpTransport('http://localhost').getQueueStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      correlationId: 'request-1',
      status: 403,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: { active: 1, pending: 2 } })),
    );
    await expect(new HttpTransport('http://localhost').getQueueStatus()).resolves.toEqual({
      running: 1,
      queued: 2,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ initialized: false, bootstrapTokenRequired: true })),
    );
    await expect(new HttpTransport('http://localhost').getSession()).rejects.toMatchObject({
      code: 'SETUP_REQUIRED',
      bootstrapTokenRequired: true,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(new HttpTransport('http://localhost').getSession()).resolves.toBeNull();

    window.sessionStorage.setItem('e-agent-access-token', 'expired-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'expired' } }, 401)),
    );
    await expect(new HttpTransport('http://localhost').getSession()).resolves.toBeNull();
    expect(window.sessionStorage.getItem('e-agent-access-token')).toBeNull();
  });

  it('覆盖流式推理、默认字段、错误事件和请求失败', async () => {
    const sse = [
      'data: {"type":"queue","position":"bad","active":"bad","pending":"bad"}',
      '',
      'data: {"type":"start"}',
      '',
      'data: {"type":"reasoning_delta","content":"thinking"}',
      '',
      'data: {"type":"delta"}',
      '',
      'data: {"type":"tool_call_delta","index":"bad","name":"tool"}',
      '',
      'data: {"type":"usage","usage":{},"durationMs":"bad"}',
      '',
      'data: {"type":"error"}',
      '',
      'data: {"type":"done"}',
      '',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    );
    const events = [];
    for await (const event of new HttpTransport('http://localhost').streamChat({
      conversationId: conversation.id,
      content: 'hello',
      model: 'model-1',
      contextMentions: [],
    })) {
      events.push(event);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'queue',
          queue: { position: null, active: 0, pending: 0 },
        }),
        expect.objectContaining({ type: 'reasoning', delta: 'thinking' }),
        expect.objectContaining({
          type: 'usage',
          usage: { inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: 0 },
        }),
        expect.objectContaining({ type: 'error', message: '流式响应失败。' }),
      ]),
    );

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));
    const failedNetwork = new HttpTransport('http://localhost').streamChat({
      conversationId: conversation.id,
      content: 'hello',
      model: 'model-1',
      contextMentions: [],
    });
    await expect(failedNetwork.next()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: 'provider unavailable' } }, 503, {
          'x-request-id': 'request-503',
        }),
      ),
    );
    const failedStatus = new HttpTransport('http://localhost').streamChat({
      conversationId: conversation.id,
      content: 'hello',
      model: 'model-1',
      contextMentions: [],
    });
    await expect(failedStatus.next()).rejects.toMatchObject({
      message: 'provider unavailable',
      status: 503,
      correlationId: 'request-503',
    });
  });
});
