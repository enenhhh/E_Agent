import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpTransport } from './http-transport';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function conversationDetail(conversationId: string, title: string, messageContent: string) {
  const now = new Date().toISOString();
  return {
    conversation: {
      id: conversationId,
      projectId: null,
      parentConversationId: null,
      branchedFromMessageId: null,
      forkKind: null,
      originMessageId: null,
      title,
      pinned: false,
      archived: false,
      messageCount: 1,
      updatedAt: now,
    },
    messages: [
      {
        id: `${conversationId}-message`,
        conversationId,
        role: 'assistant',
        content: messageContent,
        reasoning: null,
        reasoningDurationMs: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        feedback: null,
        createdAt: now,
        toolCalls: [],
      },
    ],
  };
}

describe('HttpTransport', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('对普通 HTTP 请求应用集中超时，避免消息操作锁被半开连接永久占用', async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new HttpTransport('http://127.0.0.1:4318', {
        requestTimeoutMs: 5,
      }).getQueueStatus(),
    ).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: '请求超时（5ms）',
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
    expect(
      () =>
        new HttpTransport('http://127.0.0.1:4318', {
          requestTimeoutMs: 0,
        }),
    ).toThrow('HTTP 请求超时必须是正数');
  });

  it('首启令牌只进入注册 Header，不进入正文或持久化存储', async () => {
    const bootstrapToken = 'web-bootstrap-proof-more-than-thirty-two-characters';
    const timestamp = new Date().toISOString();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          accessToken: 'signed-session-token',
          expiresAt: timestamp,
          user: {
            id: 'ee25b92d-3aa5-48e6-bd1b-a50ea2c8fb5a',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
            active: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        201,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new HttpTransport('http://127.0.0.1:4318').setup({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'valid-password',
      bootstrapToken,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('x-e-agent-bootstrap-token')).toBe(bootstrapToken);
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: 'Owner',
      email: 'owner@example.com',
      password: 'valid-password',
    });
    expect(String(init.body)).not.toContain(bootstrapToken);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(bootstrapToken);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(bootstrapToken);
  });

  it('保留模型记录 ID，并单独暴露上游模型 ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          {
            id: '815d105e-069d-4bd2-b1a0-416ad8b8d67e',
            providerId: '82f700aa-59dc-4a07-8251-f018f1b52765',
            provider: 'DeepSeek',
            remoteId: 'deepseek-v4-flash',
            displayName: 'DeepSeek V4 Flash',
            capabilities: ['chat', 'code', 'function-calling'],
            contextWindow: 64_000,
            inputPricePerMillion: 0.2,
            outputPricePerMillion: 0.8,
            enabled: true,
            metadata: { latencyMs: 128 },
          },
        ],
        cachedAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await new HttpTransport('http://127.0.0.1:4318/').listModels();

    expect(models[0]).toMatchObject({
      id: '815d105e-069d-4bd2-b1a0-416ad8b8d67e',
      remoteId: 'deepseek-v4-flash',
      provider: 'DeepSeek',
      available: true,
      latencyMs: 128,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/api/v1/models',
      expect.any(Object),
    );
  });

  it('按健康检查 DTO 接收结果，再读取完整密钥摘要', async () => {
    const keyId = '42aeb877-46ae-46ed-ac9b-ab92d7fe4b4a';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: keyId,
          health: 'healthy',
          latencyMs: 93,
          checkedAt: new Date().toISOString(),
          error: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          providers: [
            {
              id: 'a25715fd-3a9d-4539-9cd0-fae955edc3de',
              type: 'deepseek',
              name: 'DeepSeek',
              baseUrl: 'https://api.example.com/v1',
              enabled: true,
              keyStrategy: 'round-robin',
            },
          ],
          keys: [
            {
              id: keyId,
              providerId: 'a25715fd-3a9d-4539-9cd0-fae955edc3de',
              label: '主账号',
              maskedKey: 'sk-••••cdef',
              priority: 1,
              health: 'healthy',
              enabled: true,
              dailyLimit: 5,
              monthlyLimit: 50,
              quotaUnit: 'usd',
              todayUsed: 0.2,
              monthUsed: 3.4,
              proxyConfigured: false,
              lastCheckedAt: new Date().toISOString(),
            },
          ],
          totals: { available: 1, todayUsed: 0.2, monthUsed: 3.4 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const credential = await new HttpTransport('http://127.0.0.1:4318').checkCredential(keyId);

    expect(credential).toMatchObject({
      id: keyId,
      name: '主账号',
      provider: 'DeepSeek',
      status: 'healthy',
      lastFour: 'cdef',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('发送 modelId 并将标准 SSE 映射为界面事件', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            'event: queue',
            'data: {"type":"queue","position":2,"active":5,"pending":2}',
            '',
            'event: queue',
            'data: {"type":"queue","position":null,"active":5,"pending":1}',
            '',
            'event: start',
            'data: {"type":"start","requestId":"request-1","messageId":"assistant-message-1"}',
            '',
            'event: delta',
            'data: {"type":"delta","content":"你好"}',
            '',
            'event: tool_call_delta',
            'data: {"type":"tool_call_delta","index":0,"id":"call-1","name":"read_file","arguments":"{\\"path\\":"}',
            '',
            'event: tool_call_delta',
            'data: {"type":"tool_call_delta","index":0,"arguments":"\\"README.md\\"}"}',
            '',
            'event: usage',
            'data: {"type":"usage","usage":{"inputTokens":2,"outputTokens":3,"estimatedCostUsd":0.001},"durationMs":42}',
            '',
            'event: done',
            'data: {"type":"done","messageId":"message-1","finishReason":"stop"}',
            '',
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const userMessageId = crypto.randomUUID();

    const events = [];
    for await (const event of transport.streamChat({
      conversationId: 'conversation-1',
      userMessageId,
      content: '你好',
      model: '815d105e-069d-4bd2-b1a0-416ad8b8d67e',
      skill: '@code-review',
      contextMentions: ['@web:https://example.com/docs'],
    })) {
      events.push(event);
    }

    const queueEvents = events.splice(0, 2);
    expect(queueEvents.map((event) => event.type)).toEqual(['queue', 'queue']);
    expect(queueEvents[0]?.queue).toEqual({ position: 2, active: 5, pending: 2 });
    expect(queueEvents[1]?.queue).toEqual({ position: null, active: 5, pending: 1 });
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'delta',
      'tool_call',
      'tool_call',
      'usage',
      'done',
    ]);
    expect(events[0]).toMatchObject({
      type: 'start',
      requestId: 'request-1',
      messageId: 'assistant-message-1',
    });
    expect(events[1]).toMatchObject({ requestId: 'request-1', delta: '你好' });
    expect(events[3]?.toolCall).toMatchObject({
      id: 'call-1',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    });
    expect(events[4]?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cost: 0.001,
      latencyMs: 42,
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      userMessageId,
      modelId: '815d105e-069d-4bd2-b1a0-416ad8b8d67e',
      skill: '@code-review',
      contextMentions: ['@web:https://example.com/docs'],
      stream: true,
    });
  });

  it('取消 Web 流且 SSE 异常中断时等待服务端确认清理完成后才返回', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          new TextEncoder().encode(
            'event: start\ndata: {"type":"start","requestId":"request-1","messageId":"assistant-1"}\n\n',
          ),
        );
      },
    });
    let acknowledgeCancellation!: (response: Response) => void;
    const cancellationResponse = new Promise<Response>((resolve) => {
      acknowledgeCancellation = resolve;
    });
    let cancellationAttempt = 0;
    const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/cancel')) {
        cancellationAttempt += 1;
        if (cancellationAttempt === 1) {
          return Promise.reject(new Error('第一次取消请求失败'));
        }
        return cancellationResponse;
      }
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const abortController = new AbortController();
    const events: string[] = [];
    const completion = (async () => {
      for await (const event of new HttpTransport('http://127.0.0.1:4318').streamChat(
        {
          conversationId: 'conversation-1',
          content: '需要取消',
          model: 'model-1',
          contextMentions: [],
        },
        abortController.signal,
      )) {
        events.push(event.type);
      }
    })();
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(events).toEqual(['start']));
    const abortReason = new DOMException('用户停止生成', 'AbortError');
    abortController.abort(abortReason);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const mainRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(mainRequest.signal).toBeInstanceOf(AbortSignal);
    expect(mainRequest.signal).not.toBe(abortController.signal);
    const cancellationId = (JSON.parse(String(mainRequest.body)) as { cancellationId: string })
      .cancellationId;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/chat/completions/${cancellationId}/cancel`,
    );
    expect(settled).toBe(false);

    streamController.error(new Error('连接已中断'));
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeCancellation(
      jsonResponse({
        cancellationId,
        settled: true,
      }),
    );
    await expect(completion).rejects.toMatchObject({
      name: 'AbortError',
      message: '用户停止生成',
    });
    expect(settled).toBe(true);
  });

  it('取消接口暂时失败时以主 SSE 的正常 EOF 作为完成证明', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          new TextEncoder().encode(
            'event: start\ndata: {"type":"start","requestId":"request-1","messageId":"assistant-1"}\n\n',
          ),
        );
      },
    });
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith('/cancel')) return Promise.reject(new Error('临时网络故障'));
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const completion = (async () => {
      for await (const _event of new HttpTransport('http://127.0.0.1:4318').streamChat(
        {
          conversationId: 'conversation-1',
          content: '取消后等待 EOF',
          model: 'model-1',
          contextMentions: [],
        },
        controller.signal,
      )) {
        // 消费完整响应以验证完成屏障。
      }
    })();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('用户停止生成', 'AbortError'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    streamController.close();

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('响应头返回前收到取消时在流建立后补发取消并等待完成', async () => {
    let resolveMainResponse!: (response: Response) => void;
    const mainResponse = new Promise<Response>((resolve) => {
      resolveMainResponse = resolve;
    });
    let cancellationId = '';
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/cancel')) {
        return Promise.resolve(jsonResponse({ cancellationId, settled: true }));
      }
      cancellationId = (JSON.parse(String(init?.body)) as { cancellationId: string })
        .cancellationId;
      return mainResponse;
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const completion = (async () => {
      for await (const _event of new HttpTransport('http://127.0.0.1:4318').streamChat(
        {
          conversationId: 'conversation-1',
          content: '响应头前取消',
          model: 'model-1',
          contextMentions: [],
        },
        controller.signal,
      )) {
        // 不应产生有效业务事件。
      }
    })();
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('提前取消', 'AbortError'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/chat/completions/${cancellationId}/cancel`,
    );

    resolveMainResponse(
      new Response('', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await expect(completion).rejects.toMatchObject({
      name: 'AbortError',
      message: '提前取消',
    });
  });

  it('主请求在响应头前挂起时于取消确认后主动结束本地等待', async () => {
    let cancellationId = '';
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/cancel')) {
        return Promise.resolve(jsonResponse({ cancellationId, settled: true }));
      }
      cancellationId = (JSON.parse(String(init?.body)) as { cancellationId: string })
        .cancellationId;
      return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal;
        if (requestSignal?.aborted === true) {
          reject(requestSignal.reason);
          return;
        }
        requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const completion = (async () => {
      for await (const _event of new HttpTransport('http://127.0.0.1:4318').streamChat(
        {
          conversationId: 'conversation-1',
          content: '响应头永不返回',
          model: 'model-1',
          contextMentions: [],
        },
        controller.signal,
      )) {
        // 预取消确认后不应产生事件。
      }
    })();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('停止挂起请求', 'AbortError'));
    await expect(completion).rejects.toMatchObject({
      name: 'AbortError',
      message: '停止挂起请求',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/chat/completions/${cancellationId}/cancel`,
    );
  });

  it('已取消的 Web 流不会发起聊天请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort(new DOMException('已取消', 'AbortError'));

    const completion = (async () => {
      for await (const _event of new HttpTransport('http://127.0.0.1:4318').streamChat(
        {
          conversationId: 'conversation-1',
          content: '不应发送',
          model: 'model-1',
          contextMentions: [],
        },
        controller.signal,
      )) {
        // 不应产生事件。
      }
    })();

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('传递分支选项、删除并映射消息反馈', async () => {
    const timestamp = new Date().toISOString();
    const sourceId = 'conversation/root';
    const sourceMessageId = 'message/1';
    const branch = {
      id: 'conversation-branch',
      projectId: null,
      parentConversationId: sourceId,
      branchedFromMessageId: sourceMessageId,
      forkKind: 'retry',
      originMessageId: 'assistant/0',
      title: 'Retry branch',
      pinned: false,
      archived: false,
      messageCount: 2,
      updatedAt: timestamp,
    };
    const source = {
      ...branch,
      id: sourceId,
      parentConversationId: null,
      branchedFromMessageId: null,
      forkKind: null,
      originMessageId: null,
      title: 'Source',
      messageCount: 1,
    };
    const snapshot = {
      id: 'snapshot-1',
      conversationId: sourceId,
      messageCount: 4,
      createdAt: timestamp,
    };
    const message = {
      id: 'assistant/0',
      conversationId: sourceId,
      role: 'assistant',
      content: 'answer',
      reasoning: null,
      reasoningDurationMs: null,
      model: 'model-1',
      inputTokens: 2,
      outputTokens: 3,
      feedback: 'helpful',
      createdAt: timestamp,
      toolCalls: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(branch))
      .mockResolvedValueOnce(
        jsonResponse({
          conversation: source,
          snapshot,
          removedCount: 3,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(message))
      .mockResolvedValueOnce(jsonResponse({ ...message, feedback: null }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');

    await expect(
      transport.branchConversation(sourceId, sourceMessageId, {
        operationId: 'branch-operation-supplied',
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: 'assistant/0',
        title: 'Retry branch',
      }),
    ).resolves.toMatchObject({
      id: branch.id,
      parentConversationId: sourceId,
      branchedFromMessageId: sourceMessageId,
      forkKind: 'retry',
      originMessageId: 'assistant/0',
    });
    await expect(
      transport.deleteMessage(sourceId, sourceMessageId, {
        messageCount: 4,
        tailMessageId: 'assistant/0',
      }),
    ).resolves.toMatchObject({
      conversation: { id: sourceId, messageCount: 1 },
      snapshot,
      removedCount: 3,
    });
    await expect(
      transport.setMessageFeedback(sourceId, 'assistant/0', 'helpful'),
    ).resolves.toMatchObject({
      id: 'assistant/0',
      feedback: 'helpful',
      status: 'completed',
    });
    await expect(
      transport.setMessageFeedback(sourceId, 'assistant/0', null),
    ).resolves.toMatchObject({
      feedback: null,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:4318/api/v1/conversations/conversation%2Froot/branch',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual(
      expect.objectContaining({
        operationId: 'branch-operation-supplied',
        fromMessageId: sourceMessageId,
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: 'assistant/0',
        title: 'Retry branch',
      }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:4318\/api\/v1\/conversations\/conversation%2Froot\/messages\/message%2F1\?operationId=[^&]+&expectedMessageCount=4&expectedTailMessageId=assistant%2F0$/u,
      ),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'http://127.0.0.1:4318/api/v1/conversations/conversation%2Froot/messages/assistant%2F0/feedback',
    );
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      feedback: 'helpful',
    });
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toEqual({
      feedback: null,
    });
  });

  it('响应丢失后的第二次用户动作复用同一 operationId', async () => {
    const timestamp = new Date().toISOString();
    const branch = {
      id: 'branch-replayed',
      projectId: null,
      parentConversationId: 'conversation-1',
      branchedFromMessageId: 'message-1',
      forkKind: 'branch',
      originMessageId: 'message-1',
      title: 'Branch',
      pinned: false,
      archived: false,
      messageCount: 1,
      updatedAt: timestamp,
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockRejectedValueOnce(new TypeError('response lost again'))
      .mockResolvedValueOnce(jsonResponse(branch));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');

    await expect(transport.branchConversation('conversation-1', 'message-1')).rejects.toMatchObject(
      {
        code: 'NETWORK_ERROR',
      },
    );
    await expect(
      transport.branchConversation('conversation-1', 'message-1'),
    ).resolves.toMatchObject({
      id: branch.id,
    });

    const operationIds = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { operationId: string };
      return body.operationId;
    });
    expect(new Set(operationIds)).toEqual(new Set([operationIds[0]]));
  });

  it('删除响应连续丢失后再次调用仍复用原 operationId', async () => {
    const timestamp = new Date().toISOString();
    const response = {
      conversation: {
        id: 'conversation-1',
        projectId: null,
        parentConversationId: null,
        branchedFromMessageId: null,
        forkKind: null,
        originMessageId: null,
        title: 'Conversation',
        pinned: false,
        archived: false,
        messageCount: 0,
        updatedAt: timestamp,
      },
      snapshot: {
        id: 'snapshot-1',
        conversationId: 'conversation-1',
        messageCount: 1,
        createdAt: timestamp,
      },
      removedCount: 1,
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockRejectedValueOnce(new TypeError('response lost again'))
      .mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const precondition = { messageCount: 1, tailMessageId: 'message-1' };

    await expect(
      transport.deleteMessage('conversation-1', 'message-1', precondition),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(
      transport.deleteMessage('conversation-1', 'message-1', precondition),
    ).resolves.toMatchObject({ removedCount: 1, snapshot: { id: 'snapshot-1' } });

    const operationIds = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get('operationId'),
    );
    expect(operationIds[0]).toEqual(expect.any(String));
    expect(new Set(operationIds)).toEqual(new Set([operationIds[0]]));
  });

  it('映射 Skill 输入契约并完成 Workflow 的保存、运行和删除请求', async () => {
    const workflow = {
      schemaVersion: 1 as const,
      id: 'com.eagent.workflow.review',
      name: 'Review',
      steps: [
        {
          id: 'review-1',
          skillId: 'com.eagent.code-review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          skills: [
            {
              id: 'com.eagent.doc-gen',
              command: '@doc-gen',
              name: { 'zh-CN': '文档生成', 'en-US': 'Documentation Generator' },
              version: '1.0.0',
              description: { 'zh-CN': '生成文档', 'en-US': 'Generate documentation' },
              source: 'builtin',
              variables: [
                {
                  name: 'code',
                  description: '源码',
                  required: true,
                  maximumLength: 1_000_000,
                },
              ],
              enabled: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ workflow }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ workflowId: workflow.id, outputs: { 'review-1': 'ok' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');

    await expect(transport.listSkills()).resolves.toMatchObject([
      {
        command: '@doc-gen',
        source: 'builtin',
        variables: [{ name: 'code', required: true }],
      },
    ]);
    await expect(transport.saveWorkflow(workflow)).resolves.toEqual(workflow);
    await expect(
      transport.runWorkflow(workflow.id, { source: 'const value = 1;' }),
    ).resolves.toMatchObject({ outputs: { 'review-1': 'ok' } });
    await expect(transport.deleteWorkflow(workflow.id)).resolves.toBeUndefined();

    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      workflow,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      variables: { source: 'const value = 1;' },
      locale: 'zh-CN',
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/workflows/${workflow.id}`,
    );
  });

  it('退出时通知 Server 生命周期端点并清除本地凭据', async () => {
    window.sessionStorage.setItem('e-agent-access-token', 'fixture');
    window.sessionStorage.setItem('e-agent-token-expires-at', new Date().toISOString());
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');

    await expect(transport.logout()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer fixture' }),
      }),
    );
    expect(window.sessionStorage.getItem('e-agent-access-token')).toBeNull();
    expect(window.sessionStorage.getItem('e-agent-token-expires-at')).toBeNull();
  });

  it('按直接子分支聚合计数，并完成快照列表与恢复请求', async () => {
    const now = new Date().toISOString();
    const root = {
      id: 'conversation-root',
      projectId: null,
      parentConversationId: null,
      title: 'Root',
      pinned: false,
      archived: false,
      messageCount: 4,
      updatedAt: now,
    };
    const child = {
      ...root,
      id: 'conversation-child',
      parentConversationId: root.id,
      title: 'Child',
    };
    const secondChild = {
      ...child,
      id: 'conversation-child-2',
      title: 'Second child',
    };
    const grandchild = {
      ...child,
      id: 'conversation-grandchild',
      parentConversationId: child.id,
      title: 'Grandchild',
    };
    const snapshot = {
      id: 'snapshot-1',
      conversationId: root.id,
      messageCount: 2,
      createdAt: now,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          conversations: [root, child],
          pageInfo: { hasMore: true, nextCursor: 'page-2' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          conversations: [secondChild, grandchild],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ...root, title: 'Renamed' }))
      .mockResolvedValueOnce(jsonResponse([snapshot]))
      .mockResolvedValueOnce(jsonResponse({ ...root, messageCount: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');

    const conversations = await transport.listConversations();
    const updated = await transport.updateConversation(root.id, { title: 'Renamed' });
    const snapshots = await transport.listSnapshots(root.id);
    const restored = await transport.restoreSnapshot(root.id, snapshot.id);

    expect(conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: root.id, branchCount: 2 }),
        expect.objectContaining({ id: child.id, branchCount: 1 }),
        expect.objectContaining({ id: secondChild.id, branchCount: 0 }),
        expect.objectContaining({ id: grandchild.id, branchCount: 0 }),
      ]),
    );
    expect(updated).toMatchObject({ id: root.id, title: 'Renamed', branchCount: 2 });
    expect(snapshots).toEqual([snapshot]);
    expect(restored).toMatchObject({ id: root.id, messageCount: 2, branchCount: 2 });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://127.0.0.1:4318/api/v1/conversations?limit=100&cursor=page-2',
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/conversations/${root.id}/snapshots/${snapshot.id}/restore`,
    );
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('按 ID 通过会话详情端点读取单个会话摘要', async () => {
    const now = new Date().toISOString();
    const conversation = {
      id: 'conversation-single',
      projectId: null,
      parentConversationId: null,
      title: '自动生成的标题',
      pinned: false,
      archived: false,
      messageCount: 2,
      updatedAt: now,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        conversation,
        messages: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport('http://127.0.0.1:4318');
    const [summary, messages] = await Promise.all([
      transport.getConversation(conversation.id),
      transport.listMessages(conversation.id),
    ]);

    expect(summary).toMatchObject({
      id: conversation.id,
      title: conversation.title,
      messageCount: 2,
    });
    expect(messages).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:4318/api/v1/conversations/${conversation.id}`,
    );
  });

  it('切换账号后隔离同 ID 的进行中会话详情请求', async () => {
    const now = new Date().toISOString();
    const conversationId = 'shared-conversation-id';
    const detail = (title: string) => ({
      conversation: {
        id: conversationId,
        projectId: null,
        parentConversationId: null,
        branchedFromMessageId: null,
        forkKind: null,
        originMessageId: null,
        title,
        pinned: false,
        archived: false,
        messageCount: 0,
        updatedAt: now,
      },
      messages: [],
    });
    const oldDetail = deferred<Response>();
    const newDetail = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldDetail.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'new-account-token',
          expiresAt: now,
          user: {
            id: 'new-user',
            email: 'new@example.com',
            displayName: 'New user',
            role: 'owner',
            active: true,
            createdAt: now,
            updatedAt: now,
          },
        }),
      )
      .mockImplementationOnce(() => newDetail.promise);
    vi.stubGlobal('fetch', fetchMock);
    window.sessionStorage.setItem('e-agent-access-token', 'old-account-token');
    const transport = new HttpTransport('http://127.0.0.1:4318');

    const oldRequest = transport.getConversation(conversationId);
    await transport.login({ email: 'new@example.com', password: 'password-123' });
    const newRequest = transport.getConversation(conversationId);

    oldDetail.resolve(jsonResponse(detail('旧账号标题')));
    await expect(oldRequest).resolves.toMatchObject({ title: '旧账号标题' });
    const coalescedNewRequest = transport.listMessages(conversationId);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    newDetail.resolve(jsonResponse(detail('新账号标题')));
    await expect(newRequest).resolves.toMatchObject({ title: '新账号标题' });
    await expect(coalescedNewRequest).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer old-account-token',
    });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer new-account-token',
    });
  });

  it('流完成时失效流中悬挂的旧详情，并让新的摘要与消息读取合并为一次请求', async () => {
    const conversationId = 'stream-detail-success';
    const staleDetail = deferred<Response>();
    const freshDetail = deferred<Response>();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          new TextEncoder().encode(
            'event: start\ndata: {"type":"start","requestId":"stream-detail-success","messageId":"assistant-1"}\n\n',
          ),
        );
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockImplementationOnce(() => staleDetail.promise)
      .mockImplementationOnce(() => freshDetail.promise);
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const events: string[] = [];
    const completion = (async () => {
      for await (const event of transport.streamChat({
        conversationId,
        content: '生成新标题',
        model: 'model-1',
        contextMentions: [],
      })) {
        events.push(event.type);
      }
    })();
    await vi.waitFor(() => expect(events).toEqual(['start']));

    const staleRequest = transport.getConversation(conversationId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    streamController.enqueue(
      new TextEncoder().encode(
        'event: done\ndata: {"type":"done","messageId":"assistant-1","finishReason":"stop"}\n\n',
      ),
    );
    streamController.close();
    await completion;

    const freshConversation = transport.getConversation(conversationId);
    const freshMessages = transport.listMessages(conversationId);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    freshDetail.resolve(jsonResponse(conversationDetail(conversationId, '新标题', '新消息')));
    await expect(freshConversation).resolves.toMatchObject({ title: '新标题', messageCount: 1 });
    await expect(freshMessages).resolves.toMatchObject([{ content: '新消息' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    staleDetail.resolve(jsonResponse(conversationDetail(conversationId, '旧标题', '旧消息')));
    await expect(staleRequest).resolves.toMatchObject({ title: '旧标题' });
  });

  it('流启动后失败也会隔离此前悬挂的详情，并重新合并后续并发读取', async () => {
    const conversationId = 'stream-detail-failure';
    const staleDetail = deferred<Response>();
    const freshDetail = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => staleDetail.promise)
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'UPSTREAM_FAILED', message: '生成失败' } }, 503),
      )
      .mockImplementationOnce(() => freshDetail.promise);
    vi.stubGlobal('fetch', fetchMock);
    const transport = new HttpTransport('http://127.0.0.1:4318');
    const staleRequest = transport.getConversation(conversationId);

    await expect(
      (async () => {
        for await (const _event of transport.streamChat({
          conversationId,
          content: '失败请求',
          model: 'model-1',
          contextMentions: [],
        })) {
          // 失败响应不会产生业务事件。
        }
      })(),
    ).rejects.toMatchObject({ status: 503, message: '生成失败' });

    const freshConversation = transport.getConversation(conversationId);
    const freshMessages = transport.listMessages(conversationId);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    freshDetail.resolve(
      jsonResponse(conversationDetail(conversationId, '失败后标题', '已落库消息')),
    );
    await expect(freshConversation).resolves.toMatchObject({ title: '失败后标题' });
    await expect(freshMessages).resolves.toMatchObject([{ content: '已落库消息' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    staleDetail.resolve(jsonResponse(conversationDetail(conversationId, '失败前旧标题', '旧消息')));
    await expect(staleRequest).resolves.toMatchObject({ title: '失败前旧标题' });
  });
});
