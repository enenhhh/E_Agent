import type { Page, Route } from '@playwright/test';

const now = '2026-07-28T08:00:00.000Z';
const apiUser = {
  id: 'user-e2e',
  email: 'owner@example.test',
  displayName: 'E2E Owner',
  role: 'owner',
  active: true,
  createdAt: now,
  updatedAt: now,
};
const apiConversation = {
  id: 'conversation-e2e',
  projectId: null,
  parentConversationId: null,
  title: 'E2E conversation',
  pinned: false,
  archived: false,
  messageCount: 2,
  updatedAt: now,
};
const apiProvider = {
  id: 'provider-e2e',
  type: 'custom',
  name: 'Mock Provider',
  baseUrl: 'https://provider.example.test/v1',
  enabled: true,
  keyStrategy: 'round-robin',
  createdAt: now,
  updatedAt: now,
};
const apiProviderAlt = {
  id: 'provider-alt-e2e',
  type: 'deepseek',
  name: 'DeepSeek Lab',
  baseUrl: 'https://deepseek.example.test/v1',
  enabled: true,
  keyStrategy: 'priority',
  createdAt: now,
  updatedAt: now,
};
const apiKey = {
  id: 'key-e2e',
  providerId: apiProvider.id,
  label: 'E2E Key',
  maskedKey: '•••• e2e1',
  priority: 100,
  health: 'unknown',
  enabled: true,
  pausedReason: null,
  dailyLimit: 5,
  monthlyLimit: 100,
  quotaUnit: 'usd',
  todayUsed: 0.25,
  monthUsed: 2.5,
  proxyConfigured: false,
  lastCheckedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

function json(route: Route, data: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

/**
 * 为浏览器主流程提供完全本地、无供应商额度的确定性 API。
 */
export async function installMockApi(
  page: Page,
  options: { autoTitleScenario?: boolean } = {},
): Promise<void> {
  let keyHealthChecked = false;
  let chatCompleted = false;
  let mainConversationTitle = options.autoTitleScenario ? '新会话' : apiConversation.title;
  let firstMainPrompt: string | undefined;
  let mainUserMessageId = 'message-user-generated-e2e';
  let branchChatCompleted = false;
  let branchUserMessageId = 'message-user-branch-generated-e2e';
  let generatedAssistantDeleted = false;
  let members = [apiUser];

  await page.route('http://127.0.0.1:4318/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/auth/login' && request.method() === 'POST') {
      await json(route, {
        accessToken: 'e2e-access-token',
        expiresAt: '2026-07-29T08:00:00.000Z',
        user: apiUser,
      });
      return;
    }
    if (path === '/api/v1/auth/me') {
      await json(route, apiUser);
      return;
    }
    if (path === '/api/v1/users' && request.method() === 'GET') {
      await json(route, members);
      return;
    }
    if (path === '/api/v1/users' && request.method() === 'POST') {
      const input = request.postDataJSON() as {
        email: string;
        displayName: string;
        role: 'admin' | 'member' | 'viewer';
      };
      const member = {
        id: `user-${members.length + 1}`,
        email: input.email,
        displayName: input.displayName,
        role: input.role,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      members = [...members, member];
      await json(route, member, 201);
      return;
    }
    if (path.startsWith('/api/v1/users/') && request.method() === 'PATCH') {
      const id = path.split('/').at(-1);
      const input = request.postDataJSON() as {
        displayName?: string;
        role?: 'admin' | 'member' | 'viewer';
        active?: boolean;
      };
      const current = members.find((member) => member.id === id);
      if (!current) {
        await json(route, { error: { code: 'NOT_FOUND' } }, 404);
        return;
      }
      const updated = { ...current, ...input, updatedAt: now };
      members = members.map((member) => (member.id === id ? updated : member));
      await json(route, updated);
      return;
    }
    if (path.startsWith('/api/v1/users/') && request.method() === 'DELETE') {
      const id = path.split('/').at(-1);
      members = members.filter((member) => member.id !== id);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path === '/api/v1/audit') {
      await json(route, { logs: [], pageInfo: { hasMore: false, nextCursor: null } });
      return;
    }
    if (path === '/api/v1/models') {
      await json(route, {
        models: [
          {
            id: 'model-record-e2e',
            providerId: 'provider-e2e',
            provider: 'mock',
            providerName: apiProvider.name,
            remoteId: 'model-e2e',
            displayName: 'Deterministic Model',
            contextWindow: 32_768,
            capabilities: ['chat', 'code', 'function-calling'],
            enabled: true,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            metadata: { latencyMs: 8 },
          },
          {
            id: 'model-record-alt-e2e',
            providerId: apiProviderAlt.id,
            provider: 'deepseek',
            providerName: apiProviderAlt.name,
            remoteId: 'qwen-coder-e2e',
            displayName: 'Qwen Coder 35B',
            contextWindow: 65_536,
            capabilities: ['chat', 'code', 'function-calling'],
            enabled: true,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            metadata: { latencyMs: 12 },
          },
        ],
      });
      return;
    }
    if (path === '/api/v1/settings') {
      await json(route, {
        language: 'zh-CN',
        theme: 'obsidian',
        defaultModels: {
          chat: 'model-record-e2e',
          code: 'model-record-e2e',
          embedding: null,
          vision: null,
        },
        maxConcurrentRequests: 5,
        dailyCostAlertUsd: 5,
        contextCompressionThreshold: 0.7,
        contextCompressionModelId: 'model-record-e2e',
        desktopNotifications: true,
        autoSnapshotInterval: 50,
      });
      return;
    }
    if (path === '/api/v1/conversations' && request.method() === 'GET') {
      await json(route, {
        conversations: [{ ...apiConversation, title: mainConversationTitle }],
        nextCursor: null,
      });
      return;
    }
    if (path === '/api/v1/conversations' && request.method() === 'POST') {
      await json(
        route,
        {
          ...apiConversation,
          id: 'conversation-new',
          title: 'New conversation',
        },
        201,
      );
      return;
    }
    if (path === '/api/v1/conversations/conversation-e2e' && request.method() === 'GET') {
      const generatedMessages = chatCompleted
        ? [
            {
              id: mainUserMessageId,
              conversationId: apiConversation.id,
              role: 'user',
              content: 'Explain this function safely',
              reasoning: null,
              reasoningDurationMs: null,
              model: null,
              inputTokens: 0,
              outputTokens: 0,
              createdAt: now,
              toolCalls: [],
            },
            ...(generatedAssistantDeleted
              ? []
              : [
                  {
                    id: 'message-assistant-generated-e2e',
                    conversationId: apiConversation.id,
                    role: 'assistant',
                    content: 'Deterministic answer',
                    reasoning: null,
                    reasoningDurationMs: null,
                    model: 'model-e2e',
                    inputTokens: 4,
                    outputTokens: 2,
                    createdAt: now,
                    toolCalls: [],
                  },
                ]),
          ]
        : [];
      await json(route, {
        conversation: {
          ...apiConversation,
          title: mainConversationTitle,
          messageCount: 2 + generatedMessages.length,
        },
        messages: [
          {
            id: 'message-user-context-e2e',
            conversationId: apiConversation.id,
            role: 'user',
            content: '请检查 src/config.ts 并说明配置是否安全。',
            reasoning: null,
            reasoningDurationMs: null,
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: now,
            toolCalls: [],
          },
          {
            id: 'message-assistant-tools-e2e',
            conversationId: apiConversation.id,
            role: 'assistant',
            content: '我已检查配置结构；Web 模式不会直接访问本机文件。',
            reasoning: '先识别配置入口，再检查敏感字段与默认值，最后给出最小权限建议。',
            reasoningDurationMs: 13_000,
            model: 'model-e2e',
            inputTokens: 420,
            outputTokens: 96,
            createdAt: now,
            toolCalls: [
              {
                id: 'tool-read-e2e',
                type: 'function',
                function: {
                  name: 'workspace_read_file',
                  arguments: JSON.stringify({ path: 'src/config.ts', startLine: 1, endLine: 120 }),
                },
              },
            ],
          },
          ...generatedMessages,
        ],
      });
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-e2e/messages/message-assistant-generated-e2e' &&
      request.method() === 'DELETE'
    ) {
      if (
        url.searchParams.get('expectedMessageCount') !== '4' ||
        url.searchParams.get('expectedTailMessageId') !== 'message-assistant-generated-e2e'
      ) {
        await json(route, { error: { code: 'CONFLICT' } }, 409);
        return;
      }
      generatedAssistantDeleted = true;
      await json(route, {
        conversation: {
          ...apiConversation,
          messageCount: 3,
          updatedAt: now,
        },
        snapshot: {
          id: 'snapshot-before-message-delete-e2e',
          conversationId: apiConversation.id,
          messageCount: 4,
          createdAt: now,
        },
        removedCount: 1,
      });
      return;
    }
    if (path === '/api/v1/conversations/conversation-e2e/context' && request.method() === 'GET') {
      await json(route, {
        totalTokens: 24,
        contextWindow: 32_768,
        sources: [{ source: 'system', tokens: 24 }],
        compressed: false,
      });
      return;
    }
    if (path === '/api/v1/conversations/conversation-e2e/snapshots' && request.method() === 'GET') {
      await json(route, [
        {
          id: 'snapshot-e2e',
          conversationId: 'conversation-e2e',
          messageCount: 2,
          createdAt: now,
        },
      ]);
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-e2e/snapshots' &&
      request.method() === 'POST'
    ) {
      await json(
        route,
        {
          id: 'snapshot-e2e',
          conversationId: 'conversation-e2e',
          messageCount: 2,
          createdAt: now,
        },
        201,
      );
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-e2e/snapshots/snapshot-e2e/restore' &&
      request.method() === 'POST'
    ) {
      await json(route, {
        ...apiConversation,
        messageCount: 2,
        updatedAt: now,
      });
      return;
    }
    if (path === '/api/v1/conversations/conversation-e2e/branch' && request.method() === 'POST') {
      await json(
        route,
        {
          ...apiConversation,
          id: 'conversation-branch-e2e',
          parentConversationId: 'conversation-e2e',
          title: 'E2E conversation（分支）',
        },
        201,
      );
      return;
    }
    if (path === '/api/v1/conversations/conversation-branch-e2e' && request.method() === 'GET') {
      const messages = branchChatCompleted
        ? [
            {
              id: branchUserMessageId,
              conversationId: 'conversation-branch-e2e',
              role: 'user',
              content: 'Explain this function safely',
              reasoning: null,
              reasoningDurationMs: null,
              model: null,
              inputTokens: 0,
              outputTokens: 0,
              createdAt: now,
              toolCalls: [],
            },
            {
              id: 'message-assistant-branch-generated-e2e',
              conversationId: 'conversation-branch-e2e',
              role: 'assistant',
              content: 'Deterministic answer',
              reasoning: null,
              reasoningDurationMs: null,
              model: 'model-e2e',
              inputTokens: 4,
              outputTokens: 2,
              createdAt: now,
              toolCalls: [],
            },
          ]
        : [];
      await json(route, {
        ...apiConversation,
        id: 'conversation-branch-e2e',
        parentConversationId: 'conversation-e2e',
        title: 'E2E conversation（分支）',
        messageCount: messages.length,
        messages,
      });
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-branch-e2e/context' &&
      request.method() === 'GET'
    ) {
      await json(route, {
        totalTokens: 12,
        contextWindow: 32_768,
        sources: [{ source: 'history', tokens: 12 }],
        compressed: false,
      });
      return;
    }
    if (path === '/api/v1/queue/status') {
      await json(route, { active: 0, pending: 0 });
      return;
    }
    if (path === '/api/v1/usage/summary') {
      await json(route, {
        totals: {
          totalTokens: 6,
          estimatedCostUsd: 0,
          requestCount: 1,
          cachedTokens: 0,
        },
        buckets: [],
        costAlert: { thresholdUsd: 5, currentUsd: 0 },
      });
      return;
    }
    if (path === '/api/v1/skills') {
      await json(route, { skills: [] });
      return;
    }
    if (path === '/api/v1/providers' && request.method() === 'GET') {
      await json(route, { providers: [apiProvider, apiProviderAlt] });
      return;
    }
    if (path === '/api/v1/keys' && request.method() === 'GET') {
      await json(route, {
        providers: [apiProvider, apiProviderAlt],
        keys: [
          {
            ...apiKey,
            health: keyHealthChecked ? 'healthy' : 'unknown',
            lastCheckedAt: keyHealthChecked ? now : null,
          },
        ],
      });
      return;
    }
    if (path === '/api/v1/keys/check-all' && request.method() === 'POST') {
      keyHealthChecked = true;
      await json(route, {
        results: [
          {
            id: apiKey.id,
            health: 'healthy',
            latencyMs: 8,
            checkedAt: now,
            error: null,
          },
        ],
      });
      return;
    }
    if (path === '/api/v1/chat/completions' && request.method() === 'POST') {
      const requestBody = request.postDataJSON() as {
        conversationId?: string;
        userMessageId?: string;
        messages?: Array<{ content?: string }>;
      };
      if (requestBody.messages?.at(-1)?.content !== 'Explain this function safely') {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'UNEXPECTED_E2E_PROMPT',
              message: 'Unexpected synthetic prompt.',
            },
          }),
        });
        return;
      }
      if (requestBody.conversationId === 'conversation-branch-e2e') {
        branchChatCompleted = true;
        branchUserMessageId = requestBody.userMessageId ?? branchUserMessageId;
      } else {
        chatCompleted = true;
        firstMainPrompt ??= requestBody.messages?.at(-1)?.content;
        if (options.autoTitleScenario && firstMainPrompt !== undefined) {
          mainConversationTitle = firstMainPrompt;
        }
        mainUserMessageId = requestBody.userMessageId ?? mainUserMessageId;
      }
      await route.fulfill({
        status: 200,
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream; charset=utf-8',
        },
        body: [
          'event: start',
          'data: {"type":"start","requestId":"request-e2e"}',
          '',
          'event: delta',
          'data: {"type":"delta","content":"Deterministic "}',
          '',
          'event: delta',
          'data: {"type":"delta","content":"answer"}',
          '',
          'event: usage',
          'data: {"type":"usage","usage":{"inputTokens":4,"outputTokens":2,"totalTokens":6,"cachedTokens":0,"estimatedCostUsd":0},"durationMs":8,"cacheHit":false}',
          '',
          'event: done',
          'data: {"type":"done","finishReason":"stop","messageId":"message-e2e"}',
          '',
          '',
        ].join('\n'),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'E2E_ROUTE_NOT_MOCKED', message: path },
      }),
    });
  });
}
