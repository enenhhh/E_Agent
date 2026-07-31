import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatClientFactory } from '@e-agent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDesktopApplicationRuntime,
  type DesktopApplicationRuntimeOptions,
} from './application-runtime.js';
import { parseToolEnvelope, serializeToolEnvelope } from './services/agent-tool-registry.js';
import { DesktopContextResolver } from './services/context-resolver.js';
import { AppLogger } from './services/logger.js';
import { DesktopSecretStore } from './services/secret-store.js';
import { DesktopSkillResolver } from './services/skill-resolver.js';
import { WorkspaceService } from './services/workspace.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRuntime(
  chatClientFactory?: ChatClientFactory,
  skillResolver?: DesktopSkillResolver,
  overrides: Partial<
    Pick<
      DesktopApplicationRuntimeOptions,
      | 'autoCreateOwner'
      | 'autoDiscoverModels'
      | 'browserTools'
      | 'commandRunner'
      | 'contextResolver'
      | 'mcpService'
      | 'notifyCostAlert'
      | 'ollamaUrl'
      | 'openAiBaseUrl'
      | 'pluginHookRunner'
    >
  > = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-runtime-'));
  directories.push(directory);
  const logger = new AppLogger(join(directory, 'logs'));
  await logger.initialize();
  const secrets = new DesktopSecretStore({
    directory: join(directory, 'secrets'),
    developmentMode: false,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`safe:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').slice(5),
    },
  });
  const workspaceRoot = join(directory, 'workspace');
  await mkdir(workspaceRoot);
  const workspace = new WorkspaceService({
    stateFile: join(directory, 'workspace-binding.json'),
  });
  await workspace.bind(workspaceRoot);
  return createDesktopApplicationRuntime({
    databasePath: ':memory:',
    secrets,
    workspace,
    logger,
    locale: 'zh-CN' as const,
    autoDiscoverModels: false,
    ...overrides,
    ...(chatClientFactory === undefined ? {} : { chatClientFactory }),
    ...(skillResolver === undefined ? {} : { skillResolver }),
  });
}

async function invoke(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  channel: keyof typeof runtime.handlers,
  input: unknown = {},
): Promise<unknown> {
  const handler = runtime.handlers[channel];
  if (handler === undefined) {
    throw new Error(`missing handler: ${channel}`);
  }
  return handler(input);
}

function createMcpServiceMock(input: {
  readOnly: boolean;
  callTool?: NonNullable<DesktopApplicationRuntimeOptions['mcpService']>['callTool'];
}) {
  const managedTool = {
    name: 'mcp_project_memory_search',
    originalName: 'search',
    serverId: 'project-memory',
    serverName: 'Project Memory',
    endpoint: 'mcp-project-memory',
    bindingRevision: 'binding-revision-1',
    approvalIdentity: 'approval-identity-1',
    title: 'Search memory',
    description: 'Search project memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' } },
    },
    annotations: {
      readOnlyHint: input.readOnly,
      destructiveHint: !input.readOnly,
      openWorldHint: false,
    },
  };
  const callTool: NonNullable<DesktopApplicationRuntimeOptions['mcpService']>['callTool'] =
    input.callTool ??
    vi.fn(async () => ({
      content: [{ type: 'text', text: 'memory result' }],
      isError: false,
    }));
  return {
    managedTool,
    activate: vi.fn(),
    list: vi.fn(async () => []),
    save: vi.fn(),
    setEnabled: vi.fn(),
    refresh: vi.fn(),
    remove: vi.fn(),
    listChatTools: vi.fn(async () => [
      {
        type: 'function' as const,
        function: {
          name: managedTool.name,
          description: '[MCP · Project Memory] Search project memory',
          parameters: managedTool.inputSchema,
        },
      },
    ]),
    describeTool: vi.fn(async (name: string) =>
      name === managedTool.name ? managedTool : undefined,
    ),
    callTool,
  };
}

describe('desktop application runtime', () => {
  it('首轮桌面流完成后异步生成标题，同时保留手动标题', async () => {
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        yield { type: 'delta' as const, content: '已完成桌面工具卡片修复。' };
        yield {
          type: 'usage' as const,
          usage: {
            inputTokens: 8,
            outputTokens: 6,
            totalTokens: 14,
            cachedTokens: 0,
            estimatedCostUsd: 0,
          },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '新会话',
      })) as { id: string };
      const manual = (await invoke(runtime, 'conversations:create', {
        title: '我手动设置的标题',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama!.id,
        remoteId: 'desktop-auto-title-model',
        displayName: 'Desktop Auto Title Model',
        capabilitiesJson: '["chat"]',
        contextWindow: 8_192,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '# 请帮我 @file:"src/tools.ts" 优化 **工具结果卡片** 的展示。',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费完整流，确保 done 已返回给桌面调用方。
      }
      for await (const _event of await stream(
        {
          conversationId: manual.id,
          content: '这条消息不能覆盖手动标题',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费完整流。
      }

      await vi.waitFor(async () => {
        const conversations = (await invoke(runtime, 'conversations:list')) as Array<{
          id: string;
          title: string;
        }>;
        expect(conversations.find((item) => item.id === conversation.id)?.title).toBe(
          '优化 工具结果卡片 的展示',
        );
        expect(conversations.find((item) => item.id === manual.id)?.title).toBe('我手动设置的标题');
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('将缺失结果的无效工具参数映射为失败卡片，而不是伪造完成状态', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Invalid tool arguments',
      })) as { id: string };
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        toolCallsJson: JSON.stringify([
          {
            id: 'malformed-json',
            type: 'function',
            function: { name: 'workspace_propose_write', arguments: '{' },
          },
          {
            id: 'invalid-shape',
            type: 'function',
            function: {
              name: 'workspace_propose_write',
              arguments: JSON.stringify({ path: 'created.txt' }),
            },
          },
        ]),
      });

      const messages = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{
        toolCalls: Array<{
          id: string;
          status: string;
          result?: string;
          errorCode?: string;
        }>;
      }>;

      expect(messages.at(-1)?.toolCalls).toEqual([
        expect.objectContaining({
          id: 'malformed-json',
          status: 'failed',
          errorCode: 'TOOL_ARGUMENTS_INVALID',
          result: '工具参数不是有效的 JSON，未执行任何操作。',
        }),
        expect.objectContaining({
          id: 'invalid-shape',
          status: 'failed',
          errorCode: 'TOOL_ARGUMENTS_INVALID',
          result: '工具参数不符合要求，未执行任何操作。',
        }),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it('并发读取首次会话时只创建一个本地 Owner', async () => {
    const runtime = await createRuntime();
    try {
      const [first, second] = (await Promise.all([
        invoke(runtime, 'auth:get-session'),
        invoke(runtime, 'auth:get-session'),
      ])) as [{ user: { id: string; role: string } }, { user: { id: string; role: string } }];
      expect(first.user.role).toBe('owner');
      expect(second.user.id).toBe(first.user.id);
      expect(runtime.services.repositories.users.count()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('自动创建本地 Owner 并完整执行会话与设置桥接', async () => {
    const runtime = await createRuntime();
    try {
      const session = (await invoke(runtime, 'auth:get-session')) as {
        user: { role: string; email: string };
      };
      expect(session.user.role).toBe('owner');
      expect(session.user.email).toBe('local-owner@e-agent.invalid');

      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '本地会话',
      })) as { id: string; title: string };
      expect(conversation.title).toBe('本地会话');
      await expect(invoke(runtime, 'conversations:list')).resolves.toEqual([
        expect.objectContaining({ id: conversation.id }),
      ]);

      const settings = await invoke(runtime, 'settings:update', {
        maxConcurrency: 3,
        autoUpdate: false,
        defaultModels: { chat: '' },
      });
      expect(settings).toEqual(
        expect.objectContaining({
          maxConcurrency: 3,
          autoUpdate: false,
        }),
      );
      await expect(invoke(runtime, 'queue:status')).resolves.toEqual({
        running: 0,
        queued: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('通过定向 IPC 读取会话摘要、返回直接分支数并隔离其他成员会话', async () => {
    const runtime = await createRuntime();
    try {
      const session = (await invoke(runtime, 'auth:get-session')) as {
        user: { id: string };
      };
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '定向摘要',
      })) as { id: string };
      const message = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '创建分支',
      });
      await invoke(runtime, 'conversations:branch', {
        id: conversation.id,
        messageId: message.id,
      });
      const otherMember = runtime.services.repositories.users.create({
        email: 'desktop-other-member@example.com',
        displayName: 'Other Member',
        passwordHash: 'not-used-in-this-test',
        role: 'member',
      });
      runtime.services.repositories.conversations.branch({
        conversationId: conversation.id,
        fromMessageId: message.id,
        userId: otherMember.id,
        title: '其他成员分支',
      });
      const list = vi.spyOn(runtime.services.conversations, 'list');
      const getDetail = vi.spyOn(runtime.services.conversations, 'get');

      await expect(invoke(runtime, 'conversations:get', { id: conversation.id })).resolves.toEqual(
        expect.objectContaining({
          id: conversation.id,
          title: '定向摘要',
          messageCount: 1,
          branchCount: 2,
        }),
      );
      expect(list).not.toHaveBeenCalled();
      expect(getDetail).not.toHaveBeenCalled();

      const otherConversation = runtime.services.repositories.conversations.create({
        projectId: null,
        userId: otherMember.id,
        title: '其他成员会话',
      });
      runtime.services.repositories.users.update(session.user.id, { role: 'viewer' });

      await expect(invoke(runtime, 'conversations:get', { id: conversation.id })).resolves.toEqual(
        expect.objectContaining({ id: conversation.id, branchCount: 1 }),
      );
      await expect(
        invoke(runtime, 'conversations:get', { id: otherConversation.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(list).not.toHaveBeenCalled();
      expect(getDetail).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('通过桌面 IPC 列出并恢复快照，且分支数表示直接子分支数量', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '快照与分支',
      })) as { id: string };
      const firstMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '第一条消息',
      });
      const snapshot = (await invoke(runtime, 'conversations:snapshot', {
        id: conversation.id,
      })) as { id: string; conversationId: string; messageCount: number };
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '快照之后的消息',
      });

      await expect(
        invoke(runtime, 'conversations:list-snapshots', { id: conversation.id }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: snapshot.id,
          conversationId: conversation.id,
          messageCount: 1,
        }),
      ]);
      await expect(
        invoke(runtime, 'conversations:restore-snapshot', {
          id: conversation.id,
          snapshotId: snapshot.id,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          id: conversation.id,
          messageCount: 1,
          branchCount: 0,
        }),
      );
      await expect(
        invoke(runtime, 'messages:list', { conversationId: conversation.id }),
      ).resolves.toHaveLength(1);

      const branch = (await invoke(runtime, 'conversations:branch', {
        id: conversation.id,
        messageId: firstMessage.id,
      })) as { id: string; branchCount: number };
      expect(branch.branchCount).toBe(0);
      const conversations = (await invoke(runtime, 'conversations:list')) as Array<{
        id: string;
        branchCount: number;
      }>;
      expect(conversations.find((item) => item.id === conversation.id)?.branchCount).toBe(1);
      expect(conversations.find((item) => item.id === branch.id)?.branchCount).toBe(0);

      await expect(
        invoke(runtime, 'conversations:update', {
          id: conversation.id,
          input: { title: '重命名后' },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          id: conversation.id,
          title: '重命名后',
          branchCount: 1,
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('通过受控 IPC 完成重试分支、反馈和消息截尾删除', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '消息操作',
      })) as { id: string };
      const userMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '请回答',
      });
      const assistantMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '初始回答',
      });
      const tailMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '后续消息',
      });

      await expect(
        invoke(runtime, 'messages:feedback', {
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          feedback: 'helpful',
        }),
      ).resolves.toEqual(expect.objectContaining({ id: assistantMessage.id, feedback: 'helpful' }));

      const branchRequest = {
        id: conversation.id,
        messageId: userMessage.id,
        operationId: 'desktop-branch-operation',
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: assistantMessage.id,
        title: '回答版本 2',
      };
      const firstBranch = await invoke(runtime, 'conversations:branch', branchRequest);
      await expect(Promise.resolve(firstBranch)).resolves.toEqual(
        expect.objectContaining({
          parentConversationId: conversation.id,
          forkKind: 'retry',
          originMessageId: assistantMessage.id,
          messageCount: 0,
        }),
      );
      await expect(invoke(runtime, 'conversations:branch', branchRequest)).resolves.toEqual(
        firstBranch,
      );

      const deleteRequest = {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        operationId: 'desktop-delete-operation',
        expectedMessageCount: 3,
        expectedTailMessageId: tailMessage.id,
      };
      const firstDelete = await invoke(runtime, 'messages:delete', deleteRequest);
      await expect(Promise.resolve(firstDelete)).resolves.toEqual(
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: conversation.id,
            messageCount: 1,
            branchCount: 1,
          }),
          snapshot: expect.objectContaining({ messageCount: 3 }),
          removedCount: 2,
        }),
      );
      await expect(invoke(runtime, 'messages:delete', deleteRequest)).resolves.toEqual(firstDelete);
      await expect(
        invoke(runtime, 'messages:list', { conversationId: conversation.id }),
      ).resolves.toEqual([expect.objectContaining({ id: userMessage.id })]);
    } finally {
      await runtime.dispose();
    }
  });

  it('消息快照使用原始数据库尾 ID，即使工具消息不会单独展示', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '原始尾消息',
      })) as { id: string };
      const userMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: '用户可见消息',
      });
      const toolMessage = runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'tool',
        content: '{}',
        parentMessageId: 'tool-call-1',
      });

      await expect(
        invoke(runtime, 'messages:snapshot', { conversationId: conversation.id }),
      ).resolves.toEqual({
        messages: [expect.objectContaining({ id: userMessage.id })],
        messageCount: 2,
        tailMessageId: toolMessage.id,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('创建自定义提供商凭据并只返回脱敏信息', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const credential = (await invoke(runtime, 'credentials:create', {
        name: '测试 Key',
        provider: 'LCAPI Compatible',
        apiKey: 'sk-test-secret-value',
        baseUrl: 'https://example.com/v1',
        strategy: 'round-robin',
        priority: 10,
      })) as {
        providerId: string;
        providerName: string;
        providerType: string;
        provider: string;
        lastFour: string;
        status: string;
      };
      expect(credential).toEqual(
        expect.objectContaining({
          provider: 'LCAPI Compatible',
          providerId: expect.any(String),
          providerName: 'LCAPI Compatible',
          providerType: 'custom',
          lastFour: 'alue',
          status: 'unknown',
          quotaUnit: 'usd',
        }),
      );
      expect(JSON.stringify(credential)).not.toContain('sk-test-secret-value');
    } finally {
      await runtime.dispose();
    }
  });

  it('生成可传输的本地用量报表数据', async () => {
    const runtime = await createRuntime();
    try {
      await invoke(runtime, 'auth:get-session');
      const exported = (await invoke(runtime, 'usage:export', {
        range: 'day',
        format: 'json',
      })) as { data: Uint8Array; contentType: string };
      expect(exported.data).toBeInstanceOf(Uint8Array);
      expect(exported.contentType).toContain('application/json');
    } finally {
      await runtime.dispose();
    }
  });

  it('把模型文件工具调用转换为待审批 Diff，接受后才原子写盘', async () => {
    let registeredToolNames: string[] = [];
    let chatRound = 0;
    const runtime = await createRuntime(() => ({
      async *streamChat(request) {
        chatRound += 1;
        registeredToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
        if (chatRound > 1) {
          yield { type: 'delta' as const, content: '文件已经创建并通过校验。' };
          yield { type: 'done' as const, finishReason: 'stop' };
          return;
        }
        yield {
          type: 'tool_call_delta' as const,
          index: 0,
          id: 'workspace-call-1',
          name: 'workspace_propose_write',
          arguments: JSON.stringify({
            path: 'generated.ts',
            content: 'export const generated = true;\n',
          }),
        };
        yield {
          type: 'usage' as const,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedTokens: 0,
            estimatedCostUsd: 0,
          },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '文件修改',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      expect(ollama).toBeDefined();
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'fake-tool-model',
        displayName: 'Fake Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) {
        throw new Error('missing chat stream handler');
      }
      const events: unknown[] = [];
      const userMessageId = crypto.randomUUID();
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          userMessageId,
          content: '请创建文件',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      const fileChangeEvent = events.find(
        (event): event is { type: 'file_change'; fileChange: { id: string; path: string } } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'file_change',
      );
      expect(registeredToolNames).toContain('workspace_propose_write');
      expect(registeredToolNames).toContain('workspace_run_command');
      expect(fileChangeEvent?.fileChange.path).toBe('generated.ts');
      const pendingMessages = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{
        id: string;
        role: string;
        toolCalls: Array<{ id: string; status: string }>;
      }>;
      expect(pendingMessages.find((message) => message.role === 'user')?.id).toBe(userMessageId);
      expect(
        pendingMessages
          .flatMap((message) => message.toolCalls)
          .find((tool) => tool.id === 'workspace-call-1')?.status,
      ).toBe('approval-required');

      const directory = directories.at(-1);
      const generatedPath = join(directory ?? '', 'workspace', 'generated.ts');
      await expect(readFile(generatedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: conversation.id,
          changeId: fileChangeEvent?.fileChange.id,
          decision: 'accept',
          acceptedLines: [1],
        }),
      ).rejects.toMatchObject({ code: 'PARTIAL_FILE_APPROVAL_UNSUPPORTED' });
      await expect(readFile(generatedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const accepted = await invoke(runtime, 'workspace:decide-change', {
        conversationId: conversation.id,
        changeId: fileChangeEvent?.fileChange.id,
        decision: 'accept',
      });
      expect(accepted).toEqual(
        expect.objectContaining({
          id: 'workspace-call-1',
          status: 'completed',
          metadata: expect.objectContaining({
            kind: 'file-change',
            changeId: fileChangeEvent?.fileChange.id,
            path: 'generated.ts',
          }),
        }),
      );
      await expect(readFile(generatedPath, 'utf8')).resolves.toBe(
        'export const generated = true;\n',
      );
      const toolMessageCount = runtime.services.repositories.conversations
        .listMessages(conversation.id)
        .filter((message) => message.role === 'tool').length;
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: conversation.id,
          changeId: fileChangeEvent?.fileChange.id,
          decision: 'accept',
        }),
      ).resolves.toEqual(expect.objectContaining({ id: 'workspace-call-1', status: 'completed' }));
      expect(
        runtime.services.repositories.conversations
          .listMessages(conversation.id)
          .filter((message) => message.role === 'tool'),
      ).toHaveLength(toolMessageCount);
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: conversation.id,
          changeId: fileChangeEvent?.fileChange.id,
          decision: 'reject',
        }),
      ).rejects.toMatchObject({ code: 'FILE_CHANGE_ALREADY_DECIDED' });

      const terminalEnvelope = runtime.services.repositories.conversations
        .listMessages(conversation.id)
        .filter((message) => message.role === 'tool')
        .map((message) => parseToolEnvelope(message.content))
        .reverse()
        .find((envelope) => envelope?.toolCallId === 'workspace-call-1');
      expect(terminalEnvelope).toEqual(
        expect.objectContaining({
          modelId: model.id,
          status: 'completed',
          result: expect.objectContaining({
            kind: 'file-change',
            changeId: fileChangeEvent?.fileChange.id,
            path: 'generated.ts',
            status: 'accepted',
          }),
        }),
      );
      const continuationEvents: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: model.remoteId,
          continuationToolCallId: 'workspace-call-1',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        continuationEvents.push(event);
      }
      expect(continuationEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'delta',
            delta: '文件已经创建并通过校验。',
          }),
        ]),
      );
      await expect(
        invoke(runtime, 'messages:list', { conversationId: conversation.id }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCalls: expect.arrayContaining([
              expect.objectContaining({
                id: 'workspace-call-1',
                status: 'completed',
              }),
            ]),
            fileChanges: expect.arrayContaining([
              expect.objectContaining({
                id: fileChangeEvent?.fileChange.id,
                status: 'accepted',
              }),
            ]),
          }),
        ]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('拒绝文件 Diff 时持久化工具终态，并在写入错误或无工具关联时保持安全状态', async () => {
    const runtime = await createRuntime(() => ({
      async *streamChat(request) {
        const prompt = request.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content)
          .join('\n');
        const conflict = prompt.includes('冲突');
        yield {
          type: 'tool_call_delta' as const,
          index: 0,
          id: conflict ? 'workspace-conflict-call' : 'workspace-reject-call',
          name: 'workspace_propose_write',
          arguments: JSON.stringify({
            path: conflict ? 'conflict.ts' : 'rejected.ts',
            content: conflict ? 'after\n' : 'must not be written\n',
          }),
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'file-decision-model',
        displayName: 'File Decision Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const startFileChange = async (
        conversationId: string,
        content: string,
      ): Promise<{ id: string; path: string }> => {
        const events: unknown[] = [];
        for await (const event of await stream(
          {
            conversationId,
            content,
            model: model.id,
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          events.push(event);
        }
        const fileChange = events.find(
          (event): event is { type: 'file_change'; fileChange: { id: string; path: string } } =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'file_change',
        )?.fileChange;
        if (fileChange === undefined) throw new Error('missing file change event');
        return fileChange;
      };

      const rejectedConversation = (await invoke(runtime, 'conversations:create', {
        title: '拒绝文件变更',
      })) as { id: string };
      const rejectedChange = await startFileChange(rejectedConversation.id, '创建后由用户拒绝');
      const rejectedResults = await Promise.all([
        invoke(runtime, 'workspace:decide-change', {
          conversationId: rejectedConversation.id,
          changeId: rejectedChange.id,
          decision: 'reject',
        }),
        invoke(runtime, 'workspace:decide-change', {
          conversationId: rejectedConversation.id,
          changeId: rejectedChange.id,
          decision: 'reject',
        }),
      ]);
      expect(rejectedResults).toEqual([
        expect.objectContaining({ id: 'workspace-reject-call', status: 'rejected' }),
        expect.objectContaining({ id: 'workspace-reject-call', status: 'rejected' }),
      ]);
      const directory = directories.at(-1);
      await expect(
        readFile(join(directory ?? '', 'workspace', 'rejected.ts'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const rejectedEnvelope = runtime.services.repositories.conversations
        .listMessages(rejectedConversation.id)
        .filter((message) => message.role === 'tool')
        .map((message) => parseToolEnvelope(message.content))
        .reverse()
        .find((envelope) => envelope?.toolCallId === 'workspace-reject-call');
      expect(rejectedEnvelope).toEqual(
        expect.objectContaining({
          modelId: model.id,
          status: 'rejected',
          result: expect.objectContaining({
            kind: 'file-change',
            changeId: rejectedChange.id,
            path: 'rejected.ts',
            status: 'rejected',
          }),
        }),
      );
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: rejectedConversation.id,
          changeId: rejectedChange.id,
          decision: 'accept',
        }),
      ).rejects.toMatchObject({ code: 'FILE_CHANGE_ALREADY_DECIDED' });

      const conflictConversation = (await invoke(runtime, 'conversations:create', {
        title: '文件冲突',
      })) as { id: string };
      const conflictPath = join(directory ?? '', 'workspace', 'conflict.ts');
      await writeFile(conflictPath, 'before\n');
      const conflictChange = await startFileChange(conflictConversation.id, '制造冲突');
      await writeFile(conflictPath, 'external\n');
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: conflictConversation.id,
          changeId: conflictChange.id,
          decision: 'accept',
        }),
      ).rejects.toMatchObject({ code: 'FILE_CHANGED' });
      expect(
        runtime.services.repositories.conversations
          .listFileChanges(conflictConversation.id)
          .find((change) => change.id === conflictChange.id)?.status,
      ).toBe('pending');
      const pendingEnvelope = runtime.services.repositories.conversations
        .listMessages(conflictConversation.id)
        .filter((message) => message.role === 'tool')
        .map((message) => parseToolEnvelope(message.content))
        .reverse()
        .find((envelope) => envelope?.toolCallId === 'workspace-conflict-call');
      expect(pendingEnvelope?.status).toBe('approval-required');
      await expect(readFile(conflictPath, 'utf8')).resolves.toBe('external\n');
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: conflictConversation.id,
          changeId: conflictChange.id,
          decision: 'reject',
        }),
      ).resolves.toEqual(
        expect.objectContaining({ id: 'workspace-conflict-call', status: 'rejected' }),
      );

      const orphanConversation = (await invoke(runtime, 'conversations:create', {
        title: '孤立文件变更',
      })) as { id: string };
      const orphan = runtime.services.repositories.conversations.createFileChange({
        conversationId: orphanConversation.id,
        path: 'orphan.ts',
        diff: '--- a/orphan.ts\n+++ b/orphan.ts\n',
      });
      await expect(
        invoke(runtime, 'workspace:decide-change', {
          conversationId: orphanConversation.id,
          changeId: orphan.id,
          decision: 'reject',
        }),
      ).rejects.toMatchObject({ code: 'FILE_CHANGE_TOOL_NOT_FOUND' });
      expect(
        runtime.services.repositories.conversations
          .listFileChanges(orphanConversation.id)
          .find((change) => change.id === orphan.id)?.status,
      ).toBe('pending');
    } finally {
      await runtime.dispose();
    }
  });

  it('模型返回重复 tool_call id 时拒绝执行，并禁止通过审批入口选择其中任意一个调用', async () => {
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        for (const [index, path] of ['duplicate-a.ts', 'duplicate-b.ts'].entries()) {
          yield {
            type: 'tool_call_delta' as const,
            index,
            id: 'duplicate-tool-call',
            name: 'workspace_propose_write',
            arguments: JSON.stringify({ path, content: `${path}\n` }),
          };
        }
        yield { type: 'done' as const, finishReason: 'tool_calls' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '重复工具调用',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'duplicate-tool-model',
        displayName: 'Duplicate Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '创建两个文件',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: expect.stringContaining('重复的工具调用标识'),
          }),
        ]),
      );
      expect(runtime.services.repositories.conversations.listFileChanges(conversation.id)).toEqual(
        [],
      );
      expect(
        runtime.services.repositories.conversations
          .listMessages(conversation.id)
          .filter((message) => message.role === 'tool'),
      ).toEqual([]);
      await expect(
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'duplicate-tool-call',
          decision: 'reject',
        }),
      ).rejects.toMatchObject({ code: 'TOOL_CALL_AMBIGUOUS' });
    } finally {
      await runtime.dispose();
    }
  });

  it('普通聊天模型不发送工具定义，避免不支持 tools 的服务商拒绝请求', async () => {
    let receivedTools: unknown;
    const runtime = await createRuntime(() => ({
      async *streamChat(request) {
        receivedTools = request.tools;
        yield { type: 'delta' as const, content: '普通聊天响应' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '普通聊天',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'chat-without-tools',
        displayName: 'Chat Without Tools',
        capabilitiesJson: JSON.stringify(['chat']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');

      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '你好',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(receivedTools).toBeUndefined();
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'delta', delta: '普通聊天响应' })]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('自动执行只读工具、持久化结果并继续生成最终回答', async () => {
    let round = 0;
    let continuationIncludedToolResult = false;
    const runtime = await createRuntime(() => ({
      async *streamChat(request) {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'read-call-1',
            name: 'workspace_read_file',
            arguments: JSON.stringify({ path: 'source.ts' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
          return;
        }
        continuationIncludedToolResult = request.messages.some(
          (message) =>
            message.role === 'tool' &&
            typeof message.content === 'string' &&
            message.content.includes('read-file') &&
            message.toolCallId === 'read-call-1',
        );
        yield { type: 'delta' as const, content: '文件已读取。' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const workspaceRoot = join(directories.at(-1) ?? '', 'workspace');
      await writeFile(join(workspaceRoot, 'source.ts'), 'export const answer = 42;\n');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '只读工具',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'read-tool-model',
        displayName: 'Read Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '读取 source.ts',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(round).toBe(2);
      expect(continuationIncludedToolResult).toBe(true);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_call',
            toolCall: expect.objectContaining({
              id: 'read-call-1',
              status: 'completed',
            }),
          }),
          expect.objectContaining({ type: 'delta', delta: '文件已读取。' }),
        ]),
      );
      const persisted = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{
        role: string;
        content: string;
        toolCalls: Array<{ id: string; status: string; result?: string }>;
      }>;
      expect(persisted.some((message) => message.role === 'tool')).toBe(false);
      expect(
        persisted.some((message) =>
          message.toolCalls.some(
            (tool) =>
              tool.id === 'read-call-1' &&
              tool.status === 'completed' &&
              tool.result?.includes('answer'),
          ),
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('发现 MCP 工具，但不信任 Server 自报的只读标记，仍要求人工审批', async () => {
    const mcpService = createMcpServiceMock({ readOnly: true });
    let exposedMcpTool = false;
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          exposedMcpTool ||= Boolean(
            request.tools?.some((tool) => tool.function.name === 'mcp_project_memory_search'),
          );
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'mcp-read-call',
            name: 'mcp_project_memory_search',
            arguments: JSON.stringify({ query: 'architecture' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { mcpService },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      await invoke(runtime, 'settings:update', { toolExecutionPolicy: 'allow-safe' });
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'MCP 只读工具',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'mcp-read-model',
        displayName: 'MCP Read Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '从项目记忆查找架构',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(exposedMcpTool).toBe(true);
      expect(mcpService.callTool).not.toHaveBeenCalled();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_call',
            toolCall: expect.objectContaining({
              id: 'mcp-read-call',
              status: 'approval-required',
              metadata: expect.objectContaining({
                originalToolName: 'search',
                serverId: 'project-memory',
                readOnlyHint: true,
              }),
            }),
          }),
        ]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('MCP 写工具必须审批，并发重复批准只执行一次', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'updated' }],
      isError: false,
    }));
    const mcpService = createMcpServiceMock({ readOnly: false, callTool });
    let releaseApprovalDescribe!: () => void;
    let notifyApprovalDescribeStarted!: () => void;
    const approvalDescribeGate = new Promise<void>((resolve) => {
      releaseApprovalDescribe = resolve;
    });
    const approvalDescribeStarted = new Promise<void>((resolve) => {
      notifyApprovalDescribeStarted = resolve;
    });
    let describeCalls = 0;
    mcpService.describeTool = vi.fn(async (name: string) => {
      describeCalls += 1;
      if (describeCalls >= 2) {
        notifyApprovalDescribeStarted();
        await approvalDescribeGate;
      }
      return name === mcpService.managedTool.name ? mcpService.managedTool : undefined;
    });
    let chatRound = 0;
    let continuationIncludedResult = false;
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          chatRound += 1;
          if (chatRound > 1) {
            continuationIncludedResult = request.messages.some(
              (message) =>
                message.role === 'tool' &&
                typeof message.content === 'string' &&
                message.content.includes('updated'),
            );
            yield { type: 'delta' as const, content: '已分析 MCP 执行结果。' };
            yield { type: 'done' as const, finishReason: 'stop' };
            return;
          }
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'mcp-write-call',
            name: 'mcp_project_memory_search',
            arguments: JSON.stringify({ query: 'update index' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { mcpService },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      await invoke(runtime, 'settings:update', { toolExecutionPolicy: 'allow-safe' });
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'MCP 写工具审批',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'mcp-write-model',
        displayName: 'MCP Write Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '更新索引',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费完整流，等待审批状态持久化。
      }
      const persistedEnvelope = runtime.services.repositories.conversations
        .listMessages(conversation.id)
        .filter((message) => message.role === 'tool')
        .map((message) => parseToolEnvelope(message.content))
        .find((envelope) => envelope?.toolCallId === 'mcp-write-call');
      expect(persistedEnvelope?.modelId).toBe(model.id);
      const before = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{ toolCalls: Array<{ id: string; status: string }> }>;
      expect(
        before.flatMap((message) => message.toolCalls).find((tool) => tool.id === 'mcp-write-call')
          ?.status,
      ).toBe('approval-required');

      const firstApproval = invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'mcp-write-call',
        decision: 'approve',
      });
      await approvalDescribeStarted;
      const secondApproval = invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'mcp-write-call',
        decision: 'approve',
      });
      releaseApprovalDescribe();
      const results = await Promise.all([firstApproval, secondApproval]);
      expect(results).toEqual([
        expect.objectContaining({
          status: 'completed',
          result: expect.stringContaining('updated'),
        }),
        expect.objectContaining({
          status: 'completed',
          result: expect.stringContaining('updated'),
        }),
      ]);
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(mcpService.describeTool).toHaveBeenCalledTimes(2);
      const continuationEvents: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: model.remoteId,
          continuationToolCallId: 'mcp-write-call',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        continuationEvents.push(event);
      }
      expect(continuationIncludedResult).toBe(true);
      expect(continuationEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'delta', delta: '已分析 MCP 执行结果。' }),
        ]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('审批续写从主进程私有快照恢复 Skill 与补充上下文，且不能重复消费', async () => {
    const privateContext = 'PRIVATE_FILE_CONTEXT_7f6d';
    const resolvedSkillPrompt = 'RESOLVED_SKILL_PROMPT_92ab';
    const contextResolver = {
      resolve: vi.fn(async () => [{ role: 'user' as const, content: privateContext }]),
    } as unknown as NonNullable<DesktopApplicationRuntimeOptions['contextResolver']>;
    const skillResolver = {
      resolve: vi.fn(async () => resolvedSkillPrompt),
    } as unknown as DesktopSkillResolver;
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 5,
      truncated: false,
    }));
    let round = 0;
    let continuationMessages: Array<{ role: string; content: unknown }> = [];
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          round += 1;
          if (round === 1) {
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              id: 'snapshot-command-call',
              name: 'workspace_run_command',
              arguments: JSON.stringify({ executable: 'pnpm', args: ['test'], cwd: '' }),
            };
            yield { type: 'done' as const, finishReason: 'tool_calls' };
            return;
          }
          continuationMessages = request.messages;
          yield { type: 'delta' as const, content: '已结合原始上下文分析命令结果。' };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
      skillResolver,
      { commandRunner: { run }, contextResolver },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '安全上下文续写',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'snapshot-continuation-model',
        displayName: 'Snapshot Continuation Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '执行测试并结合文件给出结论',
          model: model.id,
          skill: 'com.example.review',
          contextMentions: ['@file:private.ts'],
        },
        new AbortController().signal,
      )) {
        // 等待工具审批卡和主进程内续写快照就绪。
      }

      const decision = (await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'snapshot-command-call',
        decision: 'approve',
      })) as { metadata?: Record<string, unknown> };
      expect(decision.metadata?.['continuationToolCallId']).toBe('snapshot-command-call');
      const persistedBeforeContinuation = runtime.services.repositories.conversations
        .listMessages(conversation.id)
        .map((message) => message.content)
        .join('\n');
      expect(persistedBeforeContinuation).not.toContain(privateContext);
      expect(persistedBeforeContinuation).not.toContain(resolvedSkillPrompt);

      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: 'renderer-supplied-model-is-ignored',
          continuationToolCallId: 'snapshot-command-call',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费完整续写。
      }
      expect(
        continuationMessages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes(privateContext),
        ),
      ).toBe(true);
      expect(
        continuationMessages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes(resolvedSkillPrompt),
        ),
      ).toBe(true);
      expect(contextResolver.resolve).toHaveBeenCalledOnce();
      expect(skillResolver.resolve).toHaveBeenCalledOnce();

      const repeatContinuation = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: '',
            model: model.id,
            continuationToolCallId: 'snapshot-command-call',
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          // 重复续写必须在调用模型前失败。
        }
      };
      await expect(repeatContinuation()).rejects.toMatchObject({
        code: 'TOOL_CONTINUATION_ALREADY_USED',
      });
      expect(round).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('审批后的首次模型续写失败时释放快照，允许同进程安全重试', async () => {
    const retryContext = 'RETRY_CONTEXT_3f91';
    const contextResolver = {
      resolve: vi.fn(async () => [{ role: 'user' as const, content: retryContext }]),
    } as unknown as NonNullable<DesktopApplicationRuntimeOptions['contextResolver']>;
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: 'done\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 5,
      truncated: false,
    }));
    let round = 0;
    let retryRestoredContext = false;
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          round += 1;
          if (round === 1) {
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              id: 'retry-command-call',
              name: 'workspace_run_command',
              arguments: JSON.stringify({ executable: 'pnpm', args: ['test'], cwd: '' }),
            };
            yield { type: 'done' as const, finishReason: 'tool_calls' };
            return;
          }
          if (round === 2) throw new Error('provider temporarily unavailable');
          retryRestoredContext = request.messages.some(
            (message) =>
              typeof message.content === 'string' && message.content.includes(retryContext),
          );
          yield { type: 'delta' as const, content: '重试成功。' };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
      undefined,
      { commandRunner: { run }, contextResolver },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '续写失败重试',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'continuation-retry-model',
        displayName: 'Continuation Retry Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '运行测试',
          model: model.id,
          contextMentions: ['@file:retry.ts'],
        },
        new AbortController().signal,
      )) {
        // 等待审批状态。
      }
      await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'retry-command-call',
        decision: 'approve',
      });

      const failedEvents: Array<{ type?: string }> = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: model.id,
          continuationToolCallId: 'retry-command-call',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        failedEvents.push(event as { type?: string });
      }
      expect(failedEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'error' })]),
      );

      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: model.id,
          continuationToolCallId: 'retry-command-call',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 同一私有快照应可重试一次并在成功后消费。
      }
      expect(retryRestoredContext).toBe(true);
      expect(round).toBe(3);

      const replay = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: '',
            model: model.id,
            continuationToolCallId: 'retry-command-call',
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          // 成功后再次重放必须失败。
        }
      };
      await expect(replay()).rejects.toMatchObject({
        code: 'TOOL_CONTINUATION_ALREADY_USED',
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('续写产生第二组待审批工具时继续继承原始 Skill 与文件上下文', async () => {
    const nestedContext = 'NESTED_PRIVATE_CONTEXT_15ce';
    const nestedSkill = 'NESTED_SKILL_PROMPT_8ab4';
    const contextResolver = {
      resolve: vi.fn(async () => [{ role: 'user' as const, content: nestedContext }]),
    } as unknown as NonNullable<DesktopApplicationRuntimeOptions['contextResolver']>;
    const skillResolver = {
      resolve: vi.fn(async () => nestedSkill),
    } as unknown as DesktopSkillResolver;
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: 'done\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 5,
      truncated: false,
    }));
    let round = 0;
    const continuationContextChecks: boolean[] = [];
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          round += 1;
          if (round > 1) {
            continuationContextChecks.push(
              request.messages.some(
                (message) =>
                  typeof message.content === 'string' && message.content.includes(nestedContext),
              ) &&
                request.messages.some(
                  (message) =>
                    typeof message.content === 'string' && message.content.includes(nestedSkill),
                ),
            );
          }
          if (round <= 2) {
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              id: round === 1 ? 'nested-command-a' : 'nested-command-b',
              name: 'workspace_run_command',
              arguments: JSON.stringify({ executable: 'pnpm', args: ['test'], cwd: '' }),
            };
            yield { type: 'done' as const, finishReason: 'tool_calls' };
            return;
          }
          yield { type: 'delta' as const, content: '两轮审批后的最终回答。' };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
      skillResolver,
      { commandRunner: { run }, contextResolver },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '嵌套审批上下文',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'nested-approval-model',
        displayName: 'Nested Approval Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const consume = async (continuationToolCallId?: string): Promise<void> => {
        for await (const _event of await stream(
          continuationToolCallId === undefined
            ? {
                conversationId: conversation.id,
                content: '运行两步检查',
                model: model.id,
                skill: 'com.example.nested-review',
                contextMentions: ['@file:nested.ts'],
              }
            : {
                conversationId: conversation.id,
                content: '',
                model: model.id,
                continuationToolCallId,
                contextMentions: [],
              },
          new AbortController().signal,
        )) {
          // 消费完整一轮。
        }
      };

      await consume();
      const first = (await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'nested-command-a',
        decision: 'approve',
      })) as { metadata?: Record<string, unknown> };
      expect(first.metadata?.['continuationToolCallId']).toBe('nested-command-a');
      await consume('nested-command-a');

      const second = (await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'nested-command-b',
        decision: 'approve',
      })) as { metadata?: Record<string, unknown> };
      expect(second.metadata?.['continuationToolCallId']).toBe('nested-command-b');
      await consume('nested-command-b');

      expect(continuationContextChecks).toEqual([true, true]);
      expect(contextResolver.resolve).toHaveBeenCalledOnce();
      expect(skillResolver.resolve).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledTimes(2);
      expect(round).toBe(3);
    } finally {
      await runtime.dispose();
    }
  });

  it('同一回复的多个待审批工具全部终态后才签发一次组续写资格', async () => {
    const run = vi.fn(async (input: { executable: string }) => ({
      status: 'completed' as const,
      stdout: `${input.executable} complete\n`,
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 5,
      truncated: false,
    }));
    let round = 0;
    let continuationToolResults: string[] = [];
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          round += 1;
          if (round === 1) {
            yield {
              type: 'tool_call_delta' as const,
              index: 0,
              id: 'multi-command-a',
              name: 'workspace_run_command',
              arguments: JSON.stringify({ executable: 'pnpm', args: ['test'], cwd: '' }),
            };
            yield {
              type: 'tool_call_delta' as const,
              index: 1,
              id: 'multi-command-b',
              name: 'workspace_run_command',
              arguments: JSON.stringify({ executable: 'node', args: ['--version'], cwd: '' }),
            };
            yield { type: 'done' as const, finishReason: 'tool_calls' };
            return;
          }
          continuationToolResults = request.messages
            .filter((message) => message.role === 'tool' && typeof message.content === 'string')
            .map((message) => message.content as string);
          yield { type: 'delta' as const, content: '两个工具结果均已分析。' };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
      undefined,
      { commandRunner: { run } },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '多工具审批',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'multi-approval-model',
        displayName: 'Multi Approval Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '依次运行两个命令',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 等待同一 assistant 消息中的两张审批卡就绪。
      }
      const continuationStateIds = runtime.services.repositories.conversations
        .listMessages(conversation.id)
        .filter((message) => message.role === 'tool')
        .map((message) => parseToolEnvelope(message.content)?.continuationStateId);
      expect(continuationStateIds).toHaveLength(2);
      expect(continuationStateIds.every((stateId) => stateId === continuationStateIds[0])).toBe(
        true,
      );
      expect(continuationStateIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      const secondFirst = (await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'multi-command-b',
        decision: 'approve',
      })) as { metadata?: Record<string, unknown> };
      expect(secondFirst.metadata?.['continuationToolCallId']).toBeUndefined();

      const firstLast = (await invoke(runtime, 'tools:decide', {
        conversationId: conversation.id,
        toolCallId: 'multi-command-a',
        decision: 'approve',
      })) as { metadata?: Record<string, unknown> };
      expect(firstLast.metadata?.['continuationToolCallId']).toBe('multi-command-a');

      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: model.id,
          continuationToolCallId: 'multi-command-a',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费唯一的组续写。
      }
      expect(run).toHaveBeenCalledTimes(2);
      expect(continuationToolResults).toHaveLength(2);
      expect(continuationToolResults.join('\n')).toContain('pnpm complete');
      expect(continuationToolResults.join('\n')).toContain('node complete');

      const siblingContinuation = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: '',
            model: model.id,
            continuationToolCallId: 'multi-command-b',
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          // 同组任意 sibling 都不能再次续写。
        }
      };
      await expect(siblingContinuation()).rejects.toMatchObject({
        code: 'TOOL_CONTINUATION_ALREADY_USED',
      });
      expect(round).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('现代工具信封存在续写状态标识但内存快照缺失时拒绝静默降级', async () => {
    let chatRequests = 0;
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        chatRequests += 1;
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '重启后续写保护',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'restart-protected-model',
        displayName: 'Restart Protected Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        model: model.remoteId,
        toolCallsJson: JSON.stringify([
          {
            id: 'restart-protected-call',
            type: 'function',
            function: { name: 'workspace_run_command', arguments: '{}' },
          },
        ]),
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        parentMessageId: 'restart-protected-call',
        role: 'tool',
        content: serializeToolEnvelope({
          schemaVersion: 1,
          toolCallId: 'restart-protected-call',
          toolName: 'workspace_run_command',
          modelId: model.id,
          continuationStateId: crypto.randomUUID(),
          status: 'completed',
          bindingId: null,
          result: { kind: 'command', stdout: 'done' },
        }),
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const consume = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: '',
            model: model.id,
            continuationToolCallId: 'restart-protected-call',
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          // 缺失的私有快照必须在模型调用前失败。
        }
      };

      await expect(consume()).rejects.toMatchObject({
        code: 'TOOL_CONTINUATION_CONTEXT_EXPIRED',
      });
      expect(chatRequests).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('旧版工具信封只在厂商模型名唯一时恢复内部模型，并忽略界面传回的模型值', async () => {
    let chatRequests = 0;
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        chatRequests += 1;
        yield { type: 'delta' as const, content: '旧版工具结果已续写。' };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '旧版工具续写',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'legacy-unique-model',
        displayName: 'Legacy Unique Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        model: model.remoteId,
        toolCallsJson: JSON.stringify([
          {
            id: 'legacy-unique-call',
            type: 'function',
            function: { name: 'workspace_read_file', arguments: '{"path":"source.ts"}' },
          },
        ]),
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        parentMessageId: 'legacy-unique-call',
        role: 'tool',
        content: serializeToolEnvelope({
          schemaVersion: 1,
          toolCallId: 'legacy-unique-call',
          toolName: 'workspace_read_file',
          status: 'completed',
          bindingId: null,
          result: { kind: 'read-file', content: 'legacy result' },
        }),
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '',
          model: 'untrusted-ui-model-value',
          continuationToolCallId: 'legacy-unique-call',
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(chatRequests).toBe(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'delta', delta: '旧版工具结果已续写。' }),
        ]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('旧版工具信封遇到跨服务商重复的厂商模型名时拒绝歧义续写', async () => {
    let chatRequests = 0;
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        chatRequests += 1;
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '歧义工具续写',
      })) as { id: string };
      const providers = runtime.services.repositories.providers.list();
      const firstProvider = providers[0];
      const secondProvider = providers[1];
      if (firstProvider === undefined || secondProvider === undefined) {
        throw new Error('expected at least two default providers');
      }
      const duplicateRemoteId = 'shared-legacy-model';
      const firstModel = runtime.services.repositories.models.upsert({
        providerId: firstProvider.id,
        remoteId: duplicateRemoteId,
        displayName: 'Shared Legacy Model A',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.repositories.models.upsert({
        providerId: secondProvider.id,
        remoteId: duplicateRemoteId,
        displayName: 'Shared Legacy Model B',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        model: duplicateRemoteId,
        toolCallsJson: JSON.stringify([
          {
            id: 'legacy-ambiguous-call',
            type: 'function',
            function: { name: 'workspace_read_file', arguments: '{"path":"source.ts"}' },
          },
        ]),
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        parentMessageId: 'legacy-ambiguous-call',
        role: 'tool',
        content: serializeToolEnvelope({
          schemaVersion: 1,
          toolCallId: 'legacy-ambiguous-call',
          toolName: 'workspace_read_file',
          status: 'completed',
          bindingId: null,
          result: { kind: 'read-file', content: 'legacy result' },
        }),
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const consumeContinuation = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: '',
            model: firstModel.id,
            continuationToolCallId: 'legacy-ambiguous-call',
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          // 歧义检查应在模型请求发出前失败。
        }
      };

      await expect(consumeContinuation()).rejects.toMatchObject({
        code: 'TOOL_CONTINUATION_MODEL_AMBIGUOUS',
      });
      expect(chatRequests).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('MCP Server 绑定在等待审批期间变化时拒绝执行旧调用', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'must not run' }],
      isError: false,
    }));
    const mcpService = createMcpServiceMock({ readOnly: false, callTool });
    const runtime = await createRuntime(
      () => ({
        async *streamChat() {
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'mcp-stale-call',
            name: 'mcp_project_memory_search',
            arguments: JSON.stringify({ query: 'replace server' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { mcpService },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'MCP 绑定变化',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'mcp-stale-model',
        displayName: 'MCP Stale Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '调用 MCP',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 等待审批卡持久化。
      }

      mcpService.managedTool.bindingRevision = 'binding-revision-2';
      mcpService.managedTool.approvalIdentity = 'approval-identity-2';
      await expect(
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'mcp-stale-call',
          decision: 'approve',
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'MCP_TOOL_BINDING_CHANGED',
      });
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('Member 不能管理全局 MCP，Viewer 不能修改工具策略或批准执行', async () => {
    const mcpService = createMcpServiceMock({ readOnly: false });
    const runtime = await createRuntime(
      () => ({
        async *streamChat() {
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'viewer-command-call',
            name: 'workspace_run_command',
            arguments: JSON.stringify({ executable: 'pnpm', args: ['test'], cwd: '' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { mcpService },
    );
    try {
      const session = (await invoke(runtime, 'auth:get-session')) as {
        user: { id: string };
      };
      runtime.services.repositories.users.update(session.user.id, { role: 'member' });
      await expect(
        invoke(runtime, 'mcp:save', {
          displayName: 'Denied',
          enabled: false,
          transport: 'stdio',
          command: 'node',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mcpService.save).not.toHaveBeenCalled();

      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Viewer 审批',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'viewer-tool-model',
        displayName: 'Viewer Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '运行测试',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 等待命令审批卡持久化。
      }

      runtime.services.repositories.users.update(session.user.id, { role: 'viewer' });
      await expect(
        invoke(runtime, 'settings:update', { toolExecutionPolicy: 'disabled' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'viewer-command-call',
          decision: 'approve',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await runtime.dispose();
    }
  });

  it('Viewer 流请求在解析 Skill、上下文、MCP 和调用模型前即被拒绝', async () => {
    const providerStream = vi.fn(async function* () {
      yield { type: 'done' as const, finishReason: 'stop' };
    });
    const contextResolver = new DesktopContextResolver({ workspace: {} as never });
    const contextResolve = vi.spyOn(contextResolver, 'resolve');
    const skillResolver = new DesktopSkillResolver({
      pluginsDirectory: '',
      plugins: {} as never,
      locale: 'zh-CN',
    });
    const skillResolve = vi.spyOn(skillResolver, 'resolve');
    const mcpService = createMcpServiceMock({ readOnly: true });
    const runtime = await createRuntime(
      () => ({
        streamChat: providerStream,
        close: async () => undefined,
      }),
      skillResolver,
      { contextResolver, mcpService },
    );
    try {
      const session = (await invoke(runtime, 'auth:get-session')) as {
        user: { id: string };
      };
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Viewer preflight',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'viewer-preflight-model',
        displayName: 'Viewer Preflight Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 8_192,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.repositories.users.update(session.user.id, { role: 'viewer' });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');

      const consume = async (): Promise<void> => {
        for await (const _event of await stream(
          {
            conversationId: conversation.id,
            content: 'read private context',
            model: model.id,
            skill: 'com.example.skill',
            contextMentions: ['@file:README.md'],
          },
          new AbortController().signal,
        )) {
          // Viewer 必须在任何昂贵或敏感解析前失败。
        }
      };

      await expect(consume()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(contextResolve).not.toHaveBeenCalled();
      expect(skillResolve).not.toHaveBeenCalled();
      expect(mcpService.listChatTools).not.toHaveBeenCalled();
      expect(providerStream).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('按角色保护凭据和全局设置，并且凭据列表只返回掩码', async () => {
    const runtime = await createRuntime();
    try {
      const session = (await invoke(runtime, 'auth:get-session')) as {
        user: { id: string };
      };
      const credential = (await invoke(runtime, 'credentials:create', {
        name: 'RBAC key',
        provider: 'OpenAI',
        apiKey: 'sk-rbac-secret-value',
        strategy: 'round-robin',
        priority: 1,
      })) as { id: string; lastFour: string };

      const listed = (await invoke(runtime, 'credentials:list')) as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(expect.objectContaining({ id: credential.id, lastFour: 'alue' }));
      expect(listed[0]).not.toHaveProperty('apiKey');
      expect(listed[0]).not.toHaveProperty('maskedKey');
      expect(JSON.stringify(listed)).not.toContain('sk-rbac-secret-value');

      const check = vi.spyOn(runtime.services.keys, 'check').mockResolvedValue({
        id: credential.id,
        health: 'healthy',
        latencyMs: 1,
        checkedAt: new Date().toISOString(),
        error: null,
      });
      const checkAll = vi.spyOn(runtime.services.keys, 'checkAll').mockResolvedValue([]);

      runtime.services.repositories.users.update(session.user.id, { role: 'admin' });
      await expect(
        invoke(runtime, 'credentials:create', {
          name: 'Denied admin key',
          provider: 'OpenAI',
          apiKey: 'sk-denied',
          strategy: 'round-robin',
          priority: 1,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        invoke(runtime, 'credentials:update', {
          id: credential.id,
          input: { name: 'Denied rename' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        invoke(runtime, 'credentials:delete', { id: credential.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        invoke(runtime, 'credentials:check', { id: credential.id }),
      ).resolves.toMatchObject({ id: credential.id });
      await expect(invoke(runtime, 'credentials:check-all')).resolves.toHaveLength(1);
      await expect(
        invoke(runtime, 'settings:update', { theme: 'midnight' }),
      ).resolves.toMatchObject({ theme: 'midnight' });
      await expect(invoke(runtime, 'audit:list')).resolves.toBeInstanceOf(Array);
      expect(check).toHaveBeenCalledOnce();
      expect(checkAll).toHaveBeenCalledOnce();

      for (const role of ['member', 'viewer'] as const) {
        runtime.services.repositories.users.update(session.user.id, { role });
        await expect(
          invoke(runtime, 'credentials:check', { id: credential.id }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(invoke(runtime, 'credentials:check-all')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(invoke(runtime, 'models:discover')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(invoke(runtime, 'settings:update', { theme: 'ink' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(invoke(runtime, 'audit:list')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(invoke(runtime, 'credentials:list')).resolves.toEqual([
          expect.objectContaining({ id: credential.id, lastFour: 'alue' }),
        ]);
      }
      expect(check).toHaveBeenCalledOnce();
      expect(checkAll).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
    }
  });

  it('命令只按持久化参数审批执行，并发重复批准只运行一次', async () => {
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: 'tests passed\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 25,
      truncated: false,
    }));
    const runtime = await createRuntime(
      () => ({
        async *streamChat() {
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'command-call-1',
            name: 'workspace_run_command',
            arguments: JSON.stringify({
              executable: 'pnpm',
              args: ['test'],
              cwd: '',
            }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { commandRunner: { run } },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '命令审批',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'command-tool-model',
        displayName: 'Command Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      for await (const _event of await stream(
        {
          conversationId: conversation.id,
          content: '运行测试',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        // 消费完整流，确保审批状态已经持久化。
      }
      const before = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{ toolCalls: Array<{ id: string; status: string }> }>;
      expect(
        before.flatMap((message) => message.toolCalls).find((tool) => tool.id === 'command-call-1')
          ?.status,
      ).toBe('approval-required');

      const [first, second] = await Promise.all([
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'command-call-1',
          decision: 'approve',
        }),
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'command-call-1',
          decision: 'approve',
        }),
      ]);
      expect(first).toEqual(expect.objectContaining({ id: 'command-call-1', status: 'completed' }));
      expect(second).toEqual(
        expect.objectContaining({ id: 'command-call-1', status: 'completed' }),
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ executable: 'pnpm', args: ['test'] }),
        expect.objectContaining({ bindingId: expect.any(String) }),
      );
      const after = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{
        toolCalls: Array<{ id: string; status: string; result?: string }>;
      }>;
      expect(
        after.flatMap((message) => message.toolCalls).find((tool) => tool.id === 'command-call-1'),
      ).toEqual(
        expect.objectContaining({
          status: 'completed',
          result: expect.stringContaining('tests passed'),
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('持久化、运行并删除桌面 Workflow', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'e-agent-workflow-skill-'));
    directories.push(pluginRoot);
    await mkdir(join(pluginRoot, 'prompts'), { recursive: true });
    await writeFile(
      join(pluginRoot, 'skill.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'com.example.echo',
        command: '@echo',
        name: { 'zh-CN': '回显', 'en-US': 'Echo' },
        version: '1.0.0',
        description: { 'zh-CN': '回显输入', 'en-US': 'Echo input' },
        prompts: { 'zh-CN': 'prompts/zh.md', 'en-US': 'prompts/en.md' },
        variables: [
          {
            name: 'code',
            description: '输入内容',
            required: true,
            maximumLength: 10_000,
          },
        ],
        output: 'text',
        timeoutMs: 60_000,
      }),
    );
    await writeFile(join(pluginRoot, 'prompts', 'zh.md'), '处理：{{code}}');
    await writeFile(join(pluginRoot, 'prompts', 'en.md'), 'Process: {{code}}');
    const plugins = {
      list: async () => [
        {
          root: pluginRoot,
          enabled: true,
          approved: true,
          integrity: 'workflow-skill',
          manifest: {
            schemaVersion: 1,
            id: 'com.example.workflow-plugin',
            name: 'Workflow fixture',
            version: '1.0.0',
            description: 'Fixture',
            publisher: 'E Agent',
            entry: 'index.js',
            engines: { eAgent: '>=0.1.0' },
            types: ['tool'],
            permissions: {},
            contributes: {
              skills: [{ id: 'com.example.echo', definition: 'skill.json' }],
            },
          },
        },
      ],
      getPluginRoot: async () => pluginRoot,
      isSkillEnabled: () => true,
    };
    const skillResolver = new DesktopSkillResolver({
      pluginsDirectory: pluginRoot,
      plugins: plugins as never,
      locale: 'zh-CN',
    });
    let workflowPrompt = '';
    const runtime = await createRuntime(
      () => ({
        async *streamChat(request) {
          workflowPrompt = request.messages
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter((part) => part.type === 'text')
                    .map((part) => (part.type === 'text' ? part.text : ''))
                    .join('\n'),
            )
            .join('\n');
          yield { type: 'delta' as const, content: 'workflow output' };
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: 2,
              outputTokens: 2,
              totalTokens: 4,
              cachedTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
      skillResolver,
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const workflowModel = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'workflow-model',
        displayName: 'Workflow Model',
        capabilitiesJson: JSON.stringify(['chat']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      await invoke(runtime, 'settings:update', {
        defaultModels: { chat: workflowModel.id },
      });
      const workflow = {
        schemaVersion: 1 as const,
        id: 'com.eagent.workflow.echo',
        name: 'Echo workflow',
        steps: [
          {
            id: 'echo-1',
            skillId: 'com.example.echo',
            dependsOn: [],
            input: { code: '{{input.source}}' },
          },
        ],
      };
      await expect(invoke(runtime, 'workflows:save', { workflow })).resolves.toEqual(workflow);
      await expect(invoke(runtime, 'workflows:list')).resolves.toEqual([workflow]);
      await expect(
        invoke(runtime, 'workflows:run', {
          id: workflow.id,
          variables: { source: 'hello workflow' },
          locale: 'zh-CN',
        }),
      ).resolves.toEqual({
        workflowId: workflow.id,
        outputs: { 'echo-1': 'workflow output' },
      });
      expect(workflowPrompt).toContain('hello workflow');
      await invoke(runtime, 'workflows:delete', { id: workflow.id });
      await expect(invoke(runtime, 'workflows:list')).resolves.toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it('桌面聊天流透传排队位置并在取得执行槽位后清空', async () => {
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        yield { type: 'delta' as const, content: 'desktop queue response' };
        yield {
          type: 'usage' as const,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cachedTokens: 0,
            estimatedCostUsd: 0,
          },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Queue stream',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama?.id ?? '',
        remoteId: 'desktop-queue-model',
        displayName: 'Desktop Queue Model',
        capabilitiesJson: JSON.stringify(['chat']),
        contextWindow: 32_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      runtime.services.queue.setConcurrency(1);
      const blocker = await runtime.services.queue.acquire();
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const iterator = (
        await stream(
          {
            conversationId: conversation.id,
            content: 'queued locally',
            model: model.id,
            contextMentions: [],
          },
          new AbortController().signal,
        )
      )[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          type: 'queue',
          queue: { position: 1, active: 1, pending: 1 },
        },
      });
      blocker.release();
      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          type: 'queue',
          queue: { position: null, active: 1, pending: 0 },
        },
      });
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'start' } });
      let next = await iterator.next();
      while (!next.done) {
        next = await iterator.next();
      }
      expect(runtime.services.queue.snapshot).toEqual({
        active: 0,
        pending: 0,
        concurrency: 1,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('覆盖本地登录、模型、凭据、会话、用量、设置与审计完整生命周期', async () => {
    const runtime = await createRuntime(undefined, undefined, { autoCreateOwner: false });
    try {
      await expect(invoke(runtime, 'auth:get-session')).resolves.toBeNull();
      await expect(invoke(runtime, 'conversations:list')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      const session = (await invoke(runtime, 'auth:setup', {
        name: 'Desktop Owner',
        email: 'desktop-owner@example.com',
        password: 'correct horse battery staple',
      })) as { user: { id: string; name: string } };
      expect(session.user.name).toBe('Desktop Owner');
      await invoke(runtime, 'auth:logout');
      await expect(invoke(runtime, 'auth:get-session')).resolves.toBeNull();
      await expect(
        invoke(runtime, 'auth:login', {
          email: 'desktop-owner@example.com',
          password: 'wrong password',
        }),
      ).rejects.toThrow();
      await expect(
        invoke(runtime, 'auth:login', {
          email: 'desktop-owner@example.com',
          password: 'correct horse battery staple',
        }),
      ).resolves.toMatchObject({ user: { id: session.user.id } });

      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      expect(ollama).toBeDefined();
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama!.id,
        remoteId: 'coverage-model',
        displayName: 'Coverage Model',
        capabilitiesJson: JSON.stringify(['chat', 'reasoning', 'vision']),
        contextWindow: 8_192,
        inputPricePerMillion: 1,
        outputPricePerMillion: 2,
        metadataJson: JSON.stringify({ latencyMs: 25 }),
      });
      await expect(invoke(runtime, 'models:list')).resolves.toEqual([
        expect.objectContaining({
          id: model.id,
          providerId: ollama!.id,
          providerName: ollama!.name,
          capabilities: ['chat', 'vision'],
          latencyMs: 25,
          inputPricePerMillion: 1,
          outputPricePerMillion: 2,
        }),
      ]);
      const discover = vi
        .spyOn(runtime.services.models, 'discover')
        .mockResolvedValue([{ providerId: ollama!.id, discovered: 1, error: null }]);
      await expect(invoke(runtime, 'models:discover')).resolves.toHaveLength(1);
      expect(discover).toHaveBeenCalledOnce();
      await expect(
        invoke(runtime, 'models:update-provider-selection', {
          providerId: ollama!.id,
          enabledModelIds: [],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: model.id,
          configuredEnabled: false,
          available: false,
        }),
      ]);
      await invoke(runtime, 'models:update-provider-selection', {
        providerId: ollama!.id,
        enabledModelIds: [model.id],
      });

      const createdProvider = (await invoke(runtime, 'providers:create', {
        type: 'custom',
        name: 'Runtime Gateway',
        baseUrl: 'https://runtime-gateway.test/v1',
        keyStrategy: 'round-robin',
        enabled: false,
      })) as { id: string; enabled: boolean };
      expect(createdProvider.enabled).toBe(false);
      await expect(
        invoke(runtime, 'providers:update', {
          id: createdProvider.id,
          input: { name: 'Runtime Gateway Updated', keyStrategy: 'priority' },
        }),
      ).resolves.toMatchObject({
        id: createdProvider.id,
        name: 'Runtime Gateway Updated',
        enabled: false,
        keyStrategy: 'priority',
      });
      await expect(invoke(runtime, 'providers:list')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: createdProvider.id, name: 'Runtime Gateway Updated' }),
        ]),
      );

      const disabled = (await invoke(runtime, 'credentials:create', {
        name: 'Anthropic disabled',
        provider: 'Anthropic',
        apiKey: 'sk-anthropic-test-only',
        strategy: 'failover',
        priority: 20,
        dailyLimit: 0,
        monthlyLimit: 50,
        quotaUnit: 'tokens',
        enabled: false,
      })) as { id: string; enabled: boolean; proxyMode: string; strategy: string };
      expect(disabled).toMatchObject({
        enabled: false,
        proxyMode: 'direct',
        strategy: 'priority',
      });
      const proxied = (await invoke(runtime, 'credentials:create', {
        name: 'Google proxied',
        provider: 'Google',
        apiKey: 'sk-google-test-only',
        strategy: 'round-robin',
        priority: 5,
        dailyLimit: 3,
        proxyUrl: 'http://127.0.0.1:8080',
      })) as { id: string; proxyMode: string };
      expect(proxied.proxyMode).toBe('http');
      const direct = (await invoke(runtime, 'credentials:create', {
        name: 'OpenAI direct',
        provider: 'OpenAI',
        providerName: 'OpenAI Compatible',
        apiKey: 'sk-openai-test-only',
        baseUrl: 'https://openai-proxy.test/v1/',
        strategy: 'priority',
        priority: 1,
      })) as { id: string; provider: string };
      expect(direct.provider).toBe('OpenAI Compatible (2)');
      expect(await invoke(runtime, 'credentials:list')).toHaveLength(3);

      await expect(
        invoke(runtime, 'credentials:update', {
          id: proxied.id,
          input: { provider: 'Anthropic' },
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_CHANGE_REQUIRES_RECREATE' });
      const updated = await invoke(runtime, 'credentials:update', {
        id: proxied.id,
        input: {
          name: 'Google updated',
          provider: 'Google',
          apiKey: '',
          baseUrl: 'https://google-proxy.test/v1',
          strategy: 'failover',
          priority: 7,
          dailyLimit: 0,
          monthlyLimit: 9,
          quotaUnit: 'tokens',
          proxyUrl: null,
          enabled: true,
        },
      });
      expect(updated).toEqual(
        expect.objectContaining({
          name: 'Google updated',
          strategy: 'priority',
          priority: 7,
          proxyMode: 'direct',
          lastFour: 'only',
        }),
      );
      await expect(
        invoke(runtime, 'credentials:update', { id: 'missing', input: { name: 'Nope' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      vi.spyOn(runtime.services.keys, 'check').mockImplementation(async (id) => {
        runtime.services.repositories.apiKeys.update(id, { health: 'healthy' });
        return {
          id,
          health: 'healthy',
          latencyMs: 1,
          checkedAt: new Date().toISOString(),
          error: null,
        };
      });
      await expect(invoke(runtime, 'credentials:check', { id: proxied.id })).resolves.toEqual(
        expect.objectContaining({ status: 'healthy' }),
      );
      vi.spyOn(runtime.services.keys, 'checkAll').mockImplementation(async () => {
        runtime.services.repositories.apiKeys.update(proxied.id, { health: 'warning' });
        runtime.services.repositories.apiKeys.update(disabled.id, { health: 'unhealthy' });
        return [];
      });
      const checked = (await invoke(runtime, 'credentials:check-all')) as Array<{
        id: string;
        status: string;
      }>;
      expect(checked.find((key) => key.id === proxied.id)?.status).toBe('warning');
      expect(checked.find((key) => key.id === disabled.id)?.status).toBe('error');
      await invoke(runtime, 'credentials:delete', { id: direct.id });
      await expect(invoke(runtime, 'credentials:delete', { id: direct.id })).rejects.toThrow();

      const conversation = (await invoke(runtime, 'conversations:create', {
        title: '   ',
      })) as { id: string; title: string };
      expect(conversation.title).toBe('新会话');
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'system',
        content: 'system prompt',
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: 'hello',
      });
      runtime.services.repositories.conversations.addMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'world',
        model: model.remoteId,
        inputTokens: 3,
        outputTokens: 4,
        toolCallsJson: JSON.stringify([
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'example', arguments: '{}' },
          },
        ]),
      });
      const messages = (await invoke(runtime, 'messages:list', {
        conversationId: conversation.id,
      })) as Array<{ model?: string; toolCalls: unknown[] }>;
      expect(messages.at(-1)).toMatchObject({ model: model.remoteId });
      expect(messages.at(-1)?.toolCalls).toHaveLength(1);

      await invoke(runtime, 'settings:update', {
        locale: 'en-US',
        theme: 'cyberpunk',
        defaultModels: {
          code: model.id,
          chat: model.id,
          summarize: model.id,
          embedding: '',
          vision: model.id,
        },
        maxConcurrency: 4,
        costAlertThreshold: 7,
        autoCompressContext: false,
        autoUpdate: false,
        telemetryEnabled: true,
        ollamaFallback: true,
        reasoningDisplay: 'expanded',
        toolExecutionPolicy: 'always-ask',
        toolCommandTimeoutMs: 45_000,
        toolOutputLimitBytes: 65_536,
        tutorialCompletedVersion: 1,
        autoExpandRunningTools: false,
      });
      expect(runtime.isAutoUpdateEnabled()).toBe(false);
      await expect(invoke(runtime, 'settings:get')).resolves.toEqual(
        expect.objectContaining({
          locale: 'en-US',
          theme: 'cyberpunk',
          maxConcurrency: 4,
          autoCompressContext: false,
          telemetryEnabled: true,
          ollamaFallback: true,
          reasoningDisplay: 'expanded',
          toolExecutionPolicy: 'always-ask',
          toolCommandTimeoutMs: 45_000,
          toolOutputLimitBytes: 65_536,
          tutorialCompletedVersion: 1,
          autoExpandRunningTools: false,
        }),
      );
      await expect(
        invoke(runtime, 'context:get', { conversationId: conversation.id }),
      ).resolves.toEqual(
        expect.objectContaining({
          contextWindow: 8_192,
          usedTokens: expect.any(Number),
          sources: expect.arrayContaining([
            expect.objectContaining({ type: 'system' }),
            expect.objectContaining({ type: 'history' }),
          ]),
        }),
      );
      await invoke(runtime, 'settings:update', {
        defaultModels: { chat: '00000000-0000-4000-8000-000000000000' },
      });
      await expect(
        invoke(runtime, 'context:get', { conversationId: conversation.id }),
      ).resolves.toEqual(expect.objectContaining({ contextWindow: 64_000 }));

      runtime.services.usage.record({
        occurredAt: new Date(),
        userId: session.user.id,
        projectId: null,
        conversationId: conversation.id,
        providerId: ollama!.id,
        apiKeyId: null,
        model: model.remoteId,
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        estimatedCostUsd: 1.5,
        durationMs: 123,
        cacheHit: true,
        successful: true,
      });
      for (const range of ['day', 'week', 'month'] as const) {
        await expect(invoke(runtime, 'usage:summary', { range })).resolves.toEqual(
          expect.objectContaining({
            range,
            totalTokens: 15,
            requests: 1,
            trend: expect.any(Array),
            byModel: expect.any(Array),
          }),
        );
      }
      await expect(invoke(runtime, 'usage:records', { range: 'day' })).resolves.toEqual([
        expect.objectContaining({
          model: model.remoteId,
          project: '未绑定项目',
          cacheHit: true,
        }),
      ]);
      await expect(
        invoke(runtime, 'usage:export', { range: 'week', format: 'csv' }),
      ).resolves.toEqual(
        expect.objectContaining({ contentType: expect.stringContaining('text/csv') }),
      );

      runtime.services.repositories.audit.record({
        actorId: session.user.id,
        action: 'coverage.failure',
        targetType: 'test',
        targetId: 'one',
        metadata: { result: 'failure' },
      });
      runtime.services.repositories.audit.record({
        actorId: null,
        action: 'coverage.success',
        targetType: 'system',
        metadata: { success: true },
      });
      const audit = (await invoke(runtime, 'audit:list')) as Array<{
        action: string;
        actorName: string;
        result: string;
        target: string;
      }>;
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'coverage.failure',
            actorName: 'Desktop Owner',
            result: 'failure',
            target: 'test:one',
          }),
          expect.objectContaining({
            action: 'coverage.success',
            actorName: '系统',
            result: 'success',
            target: 'system',
          }),
        ]),
      );

      for (const [channel, input] of [
        ['workflows:list', {}],
        [
          'workflows:save',
          { workflow: { schemaVersion: 1, id: 'com.test.flow', name: 'Flow', steps: [] } },
        ],
        ['workflows:delete', { id: 'com.test.flow' }],
        ['workflows:run', { id: 'com.test.flow', variables: {}, locale: 'zh-CN' }],
      ] as const) {
        await expect(invoke(runtime, channel, input)).rejects.toMatchObject({
          code: 'WORKFLOW_UNAVAILABLE',
        });
      }

      await invoke(runtime, 'conversations:update', {
        id: conversation.id,
        input: { pinned: true, archived: true },
      });
      await invoke(runtime, 'conversations:delete', { id: conversation.id });
      await expect(invoke(runtime, 'conversations:list')).resolves.toEqual([]);
    } finally {
      await runtime.dispose();
    }
    await expect(invoke(runtime, 'queue:status')).rejects.toMatchObject({
      code: 'APPLICATION_SHUTTING_DOWN',
    });
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('映射推理、增量、未知工具和无效文件工具，并只发送一次成本提醒', async () => {
    const notifyCostAlert = vi.fn().mockResolvedValue(undefined);
    const runtime = await createRuntime(
      () => ({
        async *streamChat() {
          yield { type: 'reasoning_delta' as const, content: 'thinking' };
          yield { type: 'delta' as const, content: 'answer' };
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            name: 'mystery_tool',
            arguments: '{}',
          };
          yield {
            type: 'tool_call_delta' as const,
            index: 1,
            id: 'invalid-write',
            name: 'workspace_',
            arguments: '{',
          };
          yield {
            type: 'tool_call_delta' as const,
            index: 1,
            name: 'propose_write',
          };
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: 2,
              outputTokens: 3,
              totalTokens: 5,
              cachedTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      { notifyCostAlert },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      await invoke(runtime, 'settings:update', { costAlertThreshold: 0.000_001 });
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Stream branches',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama!.id,
        remoteId: 'stream-branches-model',
        displayName: 'Stream Branches Model',
        capabilitiesJson: JSON.stringify(['chat', 'reasoning', 'function-calling']),
        contextWindow: null,
        inputPricePerMillion: 1_000_000,
        outputPricePerMillion: 1_000_000,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');

      await expect(
        (
          await stream(
            {
              conversationId: conversation.id,
              content: 'with context',
              model: model.id,
              contextMentions: ['@file:src/main.ts'],
            },
            new AbortController().signal,
          )
        )
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
      await expect(
        (
          await stream(
            {
              conversationId: conversation.id,
              content: 'with skill',
              model: model.id,
              skill: 'com.example.skill',
              contextMentions: [],
            },
            new AbortController().signal,
          )
        )
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });

      const collect = async () => {
        const events: Array<Record<string, unknown>> = [];
        for await (const event of await stream(
          {
            conversationId: conversation.id,
            content: 'run tools',
            model: model.id,
            contextMentions: [],
          },
          new AbortController().signal,
        )) {
          events.push(event as Record<string, unknown>);
        }
        return events;
      };
      const first = await collect();
      expect(first).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', delta: 'thinking' }),
          expect.objectContaining({ type: 'delta', delta: 'answer' }),
          expect.objectContaining({ type: 'usage' }),
          expect.objectContaining({ type: 'done' }),
        ]),
      );
      const toolEvents = first.filter((event) => event['type'] === 'tool_call') as Array<{
        toolCall: { id: string; name: string; status: string; result?: string };
      }>;
      expect(toolEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCall: expect.objectContaining({
              name: 'mystery_tool',
              status: 'failed',
              result: '模型请求了未注册的工具，未执行任何操作。',
            }),
          }),
          expect.objectContaining({
            toolCall: expect.objectContaining({
              id: 'invalid-write',
              name: 'workspace_propose_write',
              status: 'failed',
              result: '工具参数不是有效的 JSON，未执行任何操作。',
            }),
          }),
        ]),
      );
      expect(notifyCostAlert).toHaveBeenCalledOnce();
      await collect();
      expect(notifyCostAlert).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
    }
  });

  it('把模型客户端异常转换为流错误并保留已生成的部分消息', async () => {
    const runtime = await createRuntime(() => ({
      async *streamChat() {
        yield { type: 'delta' as const, content: 'partial answer' };
        throw new Error('provider disconnected');
      },
      close: async () => undefined,
    }));
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Failed stream',
      })) as { id: string };
      const ollama = runtime.services.repositories.providers
        .list()
        .find((provider) => provider.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: ollama!.id,
        remoteId: 'failed-stream-model',
        displayName: 'Failed Stream Model',
        capabilitiesJson: JSON.stringify(['chat']),
        contextWindow: 4_096,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: 'fail after delta',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'delta', delta: 'partial answer' }),
          expect.objectContaining({
            type: 'error',
            message: 'provider disconnected',
          }),
        ]),
      );
      await expect(
        invoke(runtime, 'messages:list', { conversationId: conversation.id }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ content: 'partial answer' })]),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('浏览器工具先绑定完整 URL 等待审批，批准后才执行隔离浏览器调用', async () => {
    const execute = vi.fn(async () => ({
      kind: 'browser-page' as const,
      sessionId: '11111111-1111-4111-8111-111111111111',
      url: 'https://example.com/search?q=e-agent',
      title: 'Example',
      isolated: true as const,
      networkBoundary: 'best-effort-public-only' as const,
    }));
    const runtime = await createRuntime(
      () => ({
        async *streamChat() {
          yield {
            type: 'tool_call_delta' as const,
            index: 0,
            id: 'browser-call-1',
            name: 'browser_open',
            arguments: JSON.stringify({ url: 'https://example.com/search?q=e-agent' }),
          };
          yield { type: 'done' as const, finishReason: 'tool_calls' };
        },
      }),
      undefined,
      {
        browserTools: {
          execute,
          dispose: vi.fn(async () => undefined),
        },
      },
    );
    try {
      await invoke(runtime, 'auth:get-session');
      const conversation = (await invoke(runtime, 'conversations:create', {
        title: 'Browser approval',
      })) as { id: string };
      const provider = runtime.services.repositories.providers
        .list()
        .find((candidate) => candidate.type === 'ollama');
      const model = runtime.services.repositories.models.upsert({
        providerId: provider?.id ?? '',
        remoteId: 'browser-tool-model',
        displayName: 'Browser Tool Model',
        capabilitiesJson: JSON.stringify(['chat', 'function-calling']),
        contextWindow: 8_192,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        metadataJson: '{}',
      });
      const stream = runtime.streamHandlers['chat:stream'];
      if (stream === undefined) throw new Error('missing chat stream handler');
      const events: unknown[] = [];
      for await (const event of await stream(
        {
          conversationId: conversation.id,
          content: '打开网页',
          model: model.id,
          contextMentions: [],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(execute).not.toHaveBeenCalled();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_call',
            toolCall: expect.objectContaining({
              id: 'browser-call-1',
              name: 'browser_open',
              status: 'approval-required',
            }),
          }),
        ]),
      );

      await expect(
        invoke(runtime, 'tools:decide', {
          conversationId: conversation.id,
          toolCallId: 'browser-call-1',
          decision: 'approve',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          id: 'browser-call-1',
          status: 'completed',
        }),
      );
      expect(execute).toHaveBeenCalledWith(
        {
          name: 'browser_open',
          input: { url: 'https://example.com/search?q=e-agent' },
        },
        expect.objectContaining({
          conversationId: conversation.id,
          networkNavigationApproval: {
            approvedUrl: 'https://example.com/search?q=e-agent',
          },
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
});
