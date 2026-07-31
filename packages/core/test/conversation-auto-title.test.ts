import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContextManager,
  createCoreServices,
  deriveConversationTitle,
  type CoreServices,
} from '../src/index.js';

const MASTER_KEY = 'auto-title-master-key-that-is-at-least-thirty-two-characters';
const SESSION_SECRET = 'auto-title-session-secret-that-is-at-least-thirty-two-characters';

describe('对话自动标题', () => {
  let database: DatabaseContext;
  let services: CoreServices;
  let actor: { id: string; role: 'owner' };
  let modelId: string;
  let pauseAfterFirstDelta: boolean;
  let failAfterFirstDelta: boolean;
  let upstreamPaused: Promise<void>;
  let signalUpstreamPaused!: () => void;
  let resumeUpstream: (() => void) | undefined;

  beforeEach(async () => {
    pauseAfterFirstDelta = false;
    failAfterFirstDelta = false;
    resumeUpstream = undefined;
    upstreamPaused = new Promise<void>((resolve) => {
      signalUpstreamPaused = resolve;
    });
    database = openDatabase({ url: ':memory:' });
    services = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
      chatClientFactory: () => ({
        async *streamChat() {
          yield { type: 'delta' as const, content: '已定位问题并给出修复方案。' };
          if (pauseAfterFirstDelta) {
            await new Promise<void>((resolve) => {
              resumeUpstream = resolve;
              signalUpstreamPaused();
            });
          }
          if (failAfterFirstDelta) throw new Error('simulated provider failure');
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: 10,
              outputTokens: 8,
              totalTokens: 18,
              cachedTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
    });
    const registered = await services.auth.register({
      email: 'auto-title@example.com',
      displayName: 'Auto Title Owner',
      password: 'correct horse battery staple',
    });
    actor = { id: registered.user.id, role: 'owner' };
    const provider = services.keys.createProvider({
      type: 'ollama',
      name: 'Auto Title Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      keyStrategy: 'round-robin',
    });
    modelId = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'auto-title-model',
      displayName: 'Auto Title Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_192,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  it('首轮成功后清理 Markdown 与上下文提及并替换默认标题', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    expect(services.repositories.conversations.get(conversation.id)?.autoTitlePending).toBe(true);
    const completion = await services.chat.complete(
      {
        conversationId: conversation.id,
        modelId,
        messages: [
          {
            role: 'user',
            content: '# 请帮我 @file:"src/auth.ts"\n修复 **登录接口** 的 TypeError，并补充测试。',
          },
        ],
        stream: false,
      },
      actor,
    );

    expect(completion.content).toBe('已定位问题并给出修复方案。');
    expect(services.repositories.conversations.get(conversation.id)?.title).toBe(
      '修复 登录接口 的 TypeError，并补充测试',
    );
    expect(services.repositories.conversations.get(conversation.id)?.autoTitlePending).toBe(false);
  });

  it('事务 CAS 幂等，且流中并发的手动重命名不会被覆盖', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新对话' }, actor);
    pauseAfterFirstDelta = true;
    const consume = (async () => {
      for await (const _event of services.chat.stream(
        {
          conversationId: conversation.id,
          modelId,
          messages: [{ role: 'user', content: '请分析支付回调重复入账问题' }],
          stream: true,
        },
        actor,
      )) {
        // 消费完整流。
      }
    })();
    await upstreamPaused;
    services.conversations.update(conversation.id, { title: '新会话' }, actor);
    resumeUpstream?.();
    await consume;

    expect(services.repositories.conversations.get(conversation.id)).toMatchObject({
      title: '新会话',
      autoTitlePending: false,
    });
    expect(
      services.repositories.conversations.updateTitleAfterFirstExchange(
        conversation.id,
        '不应覆盖',
        ['新会话', '新对话'],
      ),
    ).toBeUndefined();
  });

  it('本地生成清理纯提及、链接和过长文本，并提供稳定兜底', () => {
    const title = deriveConversationTitle([
      {
        role: 'user',
        content:
          '@folder:src 请帮我 [重构认证模块](https://example.test) ' +
          'and make the implementation production ready with complete regression coverage',
      },
    ]);
    expect(title).not.toContain('@folder');
    expect(title).not.toContain('https://');
    expect(Array.from(title).length).toBeLessThanOrEqual(32);
    expect(
      deriveConversationTitle([{ role: 'user', content: '@file:"src/only-context.ts"' }], ''),
    ).toBe('新任务');
    expect(
      deriveConversationTitle(
        [{ role: 'user', content: '[image:https://example.test/private.png]' }],
        '已分析上传的截图',
      ),
    ).toBe('已分析上传的截图');
    expect(deriveConversationTitle([{ role: 'user', content: '请假系统需要补充审批测试' }])).toBe(
      '请假系统需要补充审批测试',
    );
    expect(deriveConversationTitle([{ role: 'user', content: '请问如何修复登录超时' }])).toBe(
      '如何修复登录超时',
    );
    expect(
      deriveConversationTitle([
        { role: 'user', content: '请帮我 Re\u0301sume\u202e\u200b parser tests' },
      ]),
    ).toBe('Résume parser tests');
    expect(
      deriveConversationTitle([{ role: 'user', content: `${' '.repeat(4_096)}越界内容` }]),
    ).toBe('新任务');
  });

  it('标题存储异常只降级保留默认标题，不改变成功聊天事件', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    vi.spyOn(
      services.repositories.conversations,
      'updateTitleAfterFirstExchange',
    ).mockImplementation(() => {
      throw new Error('simulated title storage failure');
    });
    const events = [];
    for await (const event of services.chat.stream(
      {
        conversationId: conversation.id,
        modelId,
        messages: [{ role: 'user', content: '修复不会阻断回复的标题异常' }],
        stream: true,
      },
      actor,
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delta', content: '已定位问题并给出修复方案。' }),
        expect.objectContaining({ type: 'done' }),
      ]),
    );
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(services.repositories.conversations.get(conversation.id)?.title).toBe('新会话');
  });

  it('失败回复在 finally 落库后仍会基于首轮持久化消息生成标题', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    failAfterFirstDelta = true;
    const events = [];
    for await (const event of services.chat.stream(
      {
        conversationId: conversation.id,
        modelId,
        messages: [{ role: 'user', content: '请修复失败路径永久错过自动标题的问题' }],
        stream: true,
      },
      actor,
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delta' }),
        expect.objectContaining({ type: 'error', message: 'simulated provider failure' }),
      ]),
    );
    expect(services.repositories.conversations.listFirstMessages(conversation.id)).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ role: 'assistant', content: '已定位问题并给出修复方案。' }),
    ]);
    expect(services.repositories.conversations.get(conversation.id)).toMatchObject({
      messageCount: 2,
      title: '修复失败路径永久错过自动标题的问题',
    });
  });

  it('助手已落库后的用量后处理异常仍会由最外层补偿标题', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    vi.spyOn(services.usage, 'record').mockImplementationOnce(() => {
      throw new Error('usage post-processing failed');
    });
    const events = [];

    for await (const event of services.chat.stream(
      {
        conversationId: conversation.id,
        modelId,
        messages: [{ role: 'user', content: '请修复用量记录异常后的标题补偿' }],
        stream: true,
      },
      actor,
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delta' }),
        expect.objectContaining({ type: 'error', message: 'usage post-processing failed' }),
      ]),
    );
    expect(services.repositories.conversations.get(conversation.id)).toMatchObject({
      messageCount: 2,
      title: '修复用量记录异常后的标题补偿',
      autoTitlePending: false,
    });
    expect(services.repositories.conversations.listFirstMessages(conversation.id)).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ role: 'assistant' }),
    ]);
  });

  it.each(['context', 'key', 'queue'] as const)(
    '%s 预检失败时仍会用已持久化的首条用户消息生成标题',
    async (failurePoint) => {
      const conversation = services.conversations.create(
        { projectId: null, title: '新会话' },
        actor,
      );
      if (failurePoint === 'context') {
        vi.spyOn(ContextManager.prototype, 'prepare').mockRejectedValueOnce(
          new Error('context preflight failed'),
        );
      } else if (failurePoint === 'key') {
        vi.spyOn(services.keyPool, 'select').mockImplementationOnce(() => {
          throw new Error('key preflight failed');
        });
      } else {
        vi.spyOn(services.queue, 'acquire').mockRejectedValueOnce(
          new Error('queue preflight failed'),
        );
      }

      const consume = async (): Promise<void> => {
        for await (const _event of services.chat.stream(
          {
            conversationId: conversation.id,
            modelId,
            messages: [{ role: 'user', content: `请修复 ${failurePoint} 预检失败后的标题` }],
            stream: true,
          },
          actor,
        )) {
          // 预检失败前不会产生聊天事件。
        }
      };

      await expect(consume()).rejects.toThrow(`${failurePoint} preflight failed`);
      expect(services.repositories.conversations.get(conversation.id)).toMatchObject({
        messageCount: 1,
        title: `修复 ${failurePoint} 预检失败后的标题`,
        autoTitlePending: false,
      });
      expect(services.repositories.conversations.listFirstMessages(conversation.id)).toEqual([
        expect.objectContaining({ role: 'user' }),
      ]);
    },
  );

  it('遗留 user,user 时间线可从首条用户消息补偿标题', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '请修复最初遗留的库存一致性问题',
    });
    services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '这是一条不应参与标题的后续输入',
    });
    vi.spyOn(services.keyPool, 'select').mockImplementationOnce(() => {
      throw new Error('legacy timeline preflight failed');
    });

    const consume = async (): Promise<void> => {
      for await (const _event of services.chat.stream(
        {
          conversationId: conversation.id,
          modelId,
          messages: [{ role: 'user', content: '第三条也不应参与标题' }],
          stream: true,
        },
        actor,
      )) {
        // 预检失败前不会产生聊天事件。
      }
    };

    await expect(consume()).rejects.toThrow('legacy timeline preflight failed');
    expect(services.repositories.conversations.get(conversation.id)).toMatchObject({
      messageCount: 3,
      title: '修复最初遗留的库存一致性问题',
      autoTitlePending: false,
    });
  });

  it('缓存重放只使用原会话首轮消息，并能为较长的默认标题会话补偿', async () => {
    const conversation = services.conversations.create({ projectId: null, title: '新会话' }, actor);
    const repository = services.repositories.conversations;
    const updateTitle = repository.updateTitleAfterFirstExchange.bind(repository);
    vi.spyOn(repository, 'updateTitleAfterFirstExchange')
      .mockImplementationOnce(() => {
        throw new Error('first auto title attempt failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('outer auto title compensation failed');
      })
      .mockImplementation(updateTitle);
    const idempotencyKey = 'auto-title-cache-replay';
    await services.chat.complete(
      {
        conversationId: conversation.id,
        modelId,
        idempotencyKey,
        messages: [{ role: 'user', content: '请修复最初的订单幂等问题' }],
        stream: false,
      },
      actor,
    );
    expect(repository.get(conversation.id)?.title).toBe('新会话');
    repository.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '后续无关问题',
    });
    repository.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '后续无关回答',
    });
    const fullList = vi.spyOn(repository, 'listMessages').mockImplementation(() => {
      throw new Error('自动标题不应全量读取长会话');
    });

    const replay = await services.chat.complete(
      {
        conversationId: conversation.id,
        modelId,
        idempotencyKey,
        messages: [{ role: 'user', content: '完全不同的缓存重放提示' }],
        stream: false,
      },
      actor,
    );

    expect(replay.cacheHit).toBe(true);
    expect(fullList).not.toHaveBeenCalled();
    expect(repository.get(conversation.id)).toMatchObject({
      messageCount: 4,
      title: '修复最初的订单幂等问题',
    });
  });
});
