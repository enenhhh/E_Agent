import { describe, expect, it, vi } from 'vitest';

import type { SessionInfo, Skill } from '../types';

import { createDesktopTransport, type DesktopBridge } from './desktop-transport';
import { TransportError } from './transport';

const session = {
  user: {
    id: 'user-1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    active: true,
  },
} as SessionInfo;

function createBridge(
  responses: Record<string, unknown> = {},
  stream: DesktopBridge['stream'] = vi.fn(() => vi.fn()),
): {
  bridge: DesktopBridge;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async (channel: string) => responses[channel]);
  return {
    bridge: {
      invoke: invoke as DesktopBridge['invoke'],
      stream,
    },
    invoke,
  };
}

describe('desktop transport', () => {
  it('通过定向 IPC 读取单个会话，不扫描列表并把缺失结果映射为 404', async () => {
    const conversation = { id: 'conversation-1', title: '标题' };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel !== 'conversations:get') {
        throw new Error(`unexpected channel: ${channel}`);
      }
      if ((payload as { id?: string } | undefined)?.id === conversation.id) {
        return conversation;
      }
      const error = new Error('会话不存在');
      error.name = 'NOT_FOUND';
      throw error;
    });
    const transport = createDesktopTransport({
      invoke: invoke as DesktopBridge['invoke'],
      stream: vi.fn(() => vi.fn()),
    });

    await expect(transport.getConversation('conversation-1')).resolves.toBe(conversation);
    await expect(transport.getConversation('missing')).rejects.toMatchObject({
      name: TransportError.name,
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'conversations:get', {
      id: 'conversation-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'conversations:get', { id: 'missing' });
    expect(invoke).not.toHaveBeenCalledWith('conversations:list', expect.anything());
  });

  it('IPC 响应丢失后再次执行同一分支会复用 operationId', async () => {
    const result = { id: 'branch-1' } as never;
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC response lost'))
      .mockResolvedValueOnce(result);
    const transport = createDesktopTransport({
      invoke: invoke as DesktopBridge['invoke'],
      stream: vi.fn(() => vi.fn()),
    });

    await expect(transport.branchConversation('conversation-1', 'message-1')).rejects.toThrow(
      'IPC response lost',
    );
    await expect(transport.branchConversation('conversation-1', 'message-1')).resolves.toBe(result);

    expect(invoke.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect((invoke.mock.calls[1]?.[1] as { operationId: string }).operationId).toBe(
      (invoke.mock.calls[0]?.[1] as { operationId: string }).operationId,
    );
  });

  it('将桌面端全部常用操作映射到受控 IPC 通道与载荷', async () => {
    const skillBase = {
      id: 'skill-1',
      name: 'Skill',
      description: 'description',
      enabled: true,
      source: 'builtin',
      command: '@explain',
    } as unknown as Skill;
    const responses = {
      'auth:get-session': session,
      'models:list': [],
      'models:discover': [],
      'models:update-provider-selection': [],
      'providers:list': [],
      'credentials:list': [],
      'credentials:check-all': [],
      'conversations:list': [],
      'conversations:list-snapshots': [],
      'messages:list': [],
      'messages:snapshot': {
        messages: [],
        messageCount: 0,
        tailMessageId: null,
      },
      'usage:records': [],
      'usage:export': new Blob(['report']),
      'skills:list': [
        { ...skillBase, command: '@db-helper', variables: undefined },
        { ...skillBase, id: 'skill-2', command: '@deploy', variables: undefined },
        { ...skillBase, id: 'skill-3', command: '@code-review', variables: undefined },
        {
          ...skillBase,
          id: 'skill-4',
          variables: [{ name: 'input', description: 'input', required: true }],
        },
      ],
      'workflows:list': [],
      'plugins:list': [{ id: 'plugin-1', name: 'Plugin' }],
      'mcp:list': [],
      'audit:list': [],
      'system:check': [],
    };
    const { bridge, invoke } = createBridge(responses);
    const transport = createDesktopTransport(bridge);

    expect(transport.kind).toBe('desktop');
    await expect(transport.getSession()).resolves.toBe(session);
    await expect(transport.listUsers()).resolves.toEqual([session.user]);
    await transport.setup({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'password-123',
      bootstrapToken: 'desktop-must-ignore-this-bootstrap-token',
    });
    await transport.login({ email: 'owner@example.com', password: 'password-123' });
    await transport.logout();
    await transport.getWorkspaceBinding();
    await transport.chooseWorkspace();
    await transport.listModels();
    await transport.discoverModels('provider-1');
    await transport.updateProviderModelSelection('provider-1', ['model-1']);
    await transport.listProviders();
    await transport.createProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://api.example.com/v1',
      keyStrategy: 'round-robin',
    });
    await transport.updateProvider('provider-1', {
      name: 'Gateway updated',
      enabled: false,
    });
    await transport.listCredentials();
    await transport.createCredential({
      name: 'Gateway',
      provider: 'custom',
      apiKey: 'secret',
      strategy: 'round-robin',
      priority: 1,
    });
    await transport.updateCredential('credential-1', { enabled: false });
    await transport.deleteCredential('credential-1');
    await transport.checkCredential('credential-1');
    await transport.checkAllCredentials();
    await transport.listConversations();
    await transport.createConversation('New conversation');
    await transport.updateConversation('conversation-1', { pinned: true });
    await transport.deleteConversation('conversation-1');
    await transport.branchConversation('conversation-1', 'message-1');
    await transport.branchConversation('conversation-1', 'message-2', {
      includeFromMessage: false,
      kind: 'edit',
      originMessageId: 'message-2',
      title: 'Edited branch',
    });
    await transport.createSnapshot('conversation-1');
    await transport.listSnapshots('conversation-1');
    await transport.restoreSnapshot('conversation-1', 'snapshot-1');
    await transport.listMessages('conversation-1');
    await transport.getMessageSnapshot('conversation-1');
    await transport.deleteMessage('conversation-1', 'message-2', {
      messageCount: 4,
      tailMessageId: 'message-4',
    });
    await transport.setMessageFeedback('conversation-1', 'message-1', 'helpful');
    await transport.setMessageFeedback('conversation-1', 'message-1', null);
    await transport.getContext('conversation-1');
    await transport.decideFileChange('conversation-1', 'change-1', 'accept', [1, 2]);
    await transport.executeToolCall('conversation-1', 'tool-1', 'approve');
    await transport.getUsageSummary('week');
    await transport.listUsageRecords('month');
    await transport.exportUsage('day', 'csv');
    const skills = await transport.listSkills();
    await transport.setSkillEnabled('skill-1', true);
    await transport.installSkill('https://example.com/skill.git');
    await transport.listWorkflows();
    await transport.saveWorkflow({ id: 'workflow-1' } as never);
    await transport.deleteWorkflow('workflow-1');
    await transport.runWorkflow('workflow-1', { code: 'const value = 1;' });
    await transport.runWorkflow('workflow-1', {}, 'en-US');
    await transport.listPlugins();
    await transport.setPluginEnabled('plugin-1', true);
    await transport.installPlugin('https://example.com/plugin.git');
    await transport.uninstallPlugin('plugin-1');
    await transport.listMcpServers();
    await transport.saveMcpServer({
      displayName: 'Project memory',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
    await transport.setMcpServerEnabled('project-memory', false);
    await transport.refreshMcpServer('project-memory');
    await transport.removeMcpServer('project-memory');
    await transport.getSettings();
    await transport.updateSettings({ theme: 'dark' });
    await transport.listAuditEntries();
    await transport.getQueueStatus();
    await transport.runStartupCheck();

    expect(skills.map((skill) => skill.variables?.[0]?.name)).toEqual([
      'request',
      'projectContext',
      'code',
      'input',
    ]);
    expect(skills[2]?.variables?.[0]?.required).toBe(false);
    expect(invoke).toHaveBeenCalledWith('auth:setup', {
      name: 'Owner',
      email: 'owner@example.com',
      password: 'password-123',
    });
    expect(invoke).toHaveBeenCalledWith('credentials:update', {
      id: 'credential-1',
      input: { enabled: false },
    });
    expect(invoke).toHaveBeenCalledWith('models:discover', { providerId: 'provider-1' });
    expect(invoke).toHaveBeenCalledWith('models:update-provider-selection', {
      providerId: 'provider-1',
      enabledModelIds: ['model-1'],
    });
    expect(invoke).toHaveBeenCalledWith('providers:create', {
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://api.example.com/v1',
      keyStrategy: 'round-robin',
    });
    expect(invoke).toHaveBeenCalledWith('providers:update', {
      id: 'provider-1',
      input: { name: 'Gateway updated', enabled: false },
    });
    expect(invoke).toHaveBeenCalledWith('mcp:save', {
      displayName: 'Project memory',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
    expect(invoke).toHaveBeenCalledWith('mcp:set-enabled', {
      id: 'project-memory',
      enabled: false,
    });
    expect(invoke).toHaveBeenCalledWith(
      'conversations:branch',
      expect.objectContaining({
        id: 'conversation-1',
        messageId: 'message-1',
        operationId: expect.any(String),
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'conversations:branch',
      expect.objectContaining({
        id: 'conversation-1',
        messageId: 'message-2',
        operationId: expect.any(String),
        includeFromMessage: false,
        kind: 'edit',
        originMessageId: 'message-2',
        title: 'Edited branch',
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'messages:delete',
      expect.objectContaining({
        conversationId: 'conversation-1',
        messageId: 'message-2',
        operationId: expect.any(String),
        expectedMessageCount: 4,
        expectedTailMessageId: 'message-4',
      }),
    );
    expect(invoke).toHaveBeenCalledWith('messages:feedback', {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      feedback: 'helpful',
    });
    expect(invoke).toHaveBeenCalledWith('messages:feedback', {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      feedback: null,
    });
    expect(invoke).toHaveBeenCalledWith('workspace:decide-change', {
      conversationId: 'conversation-1',
      changeId: 'change-1',
      decision: 'accept',
      acceptedLines: [1, 2],
    });
    expect(invoke).toHaveBeenCalledWith('tools:decide', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      decision: 'approve',
    });
  });

  it('编辑 Key 时剔除空密钥、空代理和 undefined，避免覆盖已加密敏感值', async () => {
    const { bridge, invoke } = createBridge();
    const transport = createDesktopTransport(bridge);

    await transport.updateCredential('credential-1', {
      name: 'Renamed',
      apiKey: '',
      proxyUrl: '',
      dailyLimit: undefined,
      monthlyLimit: null,
    });

    expect(invoke).toHaveBeenCalledWith('credentials:update', {
      id: 'credential-1',
      input: {
        name: 'Renamed',
        monthlyLimit: null,
      },
    });
  });

  it('桌面单机模式明确拒绝团队成员管理', async () => {
    const { bridge } = createBridge({ 'auth:get-session': null });
    const transport = createDesktopTransport(bridge);

    await expect(transport.listUsers()).resolves.toEqual([]);
    for (const request of [
      transport.createUser({
        name: 'Member',
        email: 'member@example.com',
        password: 'password-123',
        role: 'member',
      }),
      transport.updateUser('user-2', { active: false }),
      transport.deleteUser('user-2'),
    ]) {
      await expect(request).rejects.toMatchObject({
        code: 'TEAM_MANAGEMENT_WEB_ONLY',
      });
    }
  });

  it('批准与撤销插件权限后重新读取真实插件状态', async () => {
    const { bridge, invoke } = createBridge({
      'plugins:list': [{ id: 'plugin-1', name: 'Plugin', approved: true }],
    });
    const transport = createDesktopTransport(bridge);

    await expect(transport.setPluginApproved('plugin-1', true)).resolves.toMatchObject({
      id: 'plugin-1',
    });
    await expect(transport.setPluginApproved('plugin-1', false)).resolves.toMatchObject({
      id: 'plugin-1',
    });

    expect(invoke).toHaveBeenCalledWith('plugins:approve', { pluginId: 'plugin-1' });
    expect(invoke).toHaveBeenCalledWith('plugins:revoke', { pluginId: 'plugin-1' });
    expect(invoke).toHaveBeenCalledWith('plugins:disable', { pluginId: 'plugin-1' });
  });

  it('插件状态回读缺失时返回可诊断错误', async () => {
    const { bridge } = createBridge({ 'plugins:list': [] });
    const transport = createDesktopTransport(bridge);

    await expect(transport.setPluginApproved('missing', true)).rejects.toBeInstanceOf(Error);
  });

  it('将桌面流事件按顺序转换为异步迭代器', async () => {
    const unsubscribe = vi.fn();
    const stream = vi.fn((_channel, _payload, callbacks) => {
      callbacks.onEvent({ type: 'delta', requestId: 'request-1', delta: 'first' });
      callbacks.onEvent({ type: 'delta', requestId: 'request-1', delta: 'second' });
      callbacks.onComplete();
      return unsubscribe;
    }) as DesktopBridge['stream'];
    const { bridge } = createBridge({}, stream);
    const transport = createDesktopTransport(bridge);
    const events = [];
    const userMessageId = crypto.randomUUID();

    for await (const event of transport.streamChat({
      conversationId: 'conversation-1',
      userMessageId,
      model: 'model-1',
      content: 'hello',
      contextMentions: [],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', requestId: 'request-1', delta: 'first' },
      { type: 'delta', requestId: 'request-1', delta: 'second' },
    ]);
    expect(stream).toHaveBeenCalledWith(
      'chat:stream',
      expect.objectContaining({ content: 'hello', userMessageId }),
      expect.any(Object),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('传播桌面流错误并在取消时释放订阅', async () => {
    const expected = new Error('stream failed');
    const errorUnsubscribe = vi.fn();
    const errorStream = vi.fn((_channel, _payload, callbacks) => {
      callbacks.onError(expected);
      return errorUnsubscribe;
    }) as DesktopBridge['stream'];
    const errorTransport = createDesktopTransport(createBridge({}, errorStream).bridge);

    await expect(
      (async () => {
        for await (const _event of errorTransport.streamChat({
          conversationId: 'conversation-1',
          model: 'model-1',
          content: 'hello',
          contextMentions: [],
        })) {
          // 流错误前不会产生事件。
        }
      })(),
    ).rejects.toBe(expected);
    expect(errorUnsubscribe).toHaveBeenCalled();

    const abortUnsubscribe = vi.fn();
    let abortCallbacks: Parameters<DesktopBridge['stream']>[2] | undefined;
    const abortTransport = createDesktopTransport(
      createBridge(
        {},
        vi.fn((_channel, _payload, callbacks) => {
          abortCallbacks = callbacks;
          return abortUnsubscribe;
        }) as DesktopBridge['stream'],
      ).bridge,
    );
    const controller = new AbortController();
    const iterator = abortTransport.streamChat(
      {
        conversationId: 'conversation-1',
        model: 'model-1',
        content: 'hello',
        contextMentions: [],
      },
      controller.signal,
    );
    const pending = iterator[Symbol.asyncIterator]().next();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(abortUnsubscribe).toHaveBeenCalled();
    abortCallbacks?.onComplete();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});
