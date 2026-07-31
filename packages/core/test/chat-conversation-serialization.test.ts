import { randomUUID } from 'node:crypto';

import type { ProviderStreamEvent, RuntimeChatRequest } from '@e-agent/ai-runtime';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { afterEach, describe, expect, it } from 'vitest';

import { createCoreServices, type ChatClientFactory, type CoreServices } from '../src/index.js';

const MASTER_KEY = 'test-master-key-that-is-at-least-thirty-two-characters';
const SESSION_SECRET = 'test-session-secret-that-is-at-least-thirty-two-chars';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('同一会话聊天串行化', () => {
  let database: DatabaseContext | undefined;

  afterEach(() => {
    if (database?.sqlite.open === true) database.close();
    database = undefined;
  });

  async function createFixture(clientFactory: ChatClientFactory): Promise<{
    services: CoreServices;
    actor: { id: string; role: 'owner' };
    conversationId: string;
    modelId: string;
  }> {
    database = openDatabase({ url: ':memory:' });
    const services = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
      chatClientFactory: clientFactory,
    });
    const auth = await services.auth.register({
      email: `${randomUUID()}@example.com`,
      displayName: 'Serialization Owner',
      password: 'correct horse battery staple',
    });
    const actor = { id: auth.user.id, role: 'owner' as const };
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Serialization Provider',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Serialization Key',
      apiKey: 'sk-test-serialization-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'serialization-model',
      displayName: 'Serialization Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    const conversation = services.conversations.create(
      { projectId: null, title: 'Serialization target' },
      actor,
    );
    return {
      services,
      actor,
      conversationId: conversation.id,
      modelId: model.id,
    };
  }

  it('不同客户端并发发送时完整保存 U1/A1/U2/A2，第二轮历史包含第一轮回答', async () => {
    const starts = [deferred(), deferred()];
    const gates = [deferred(), deferred()];
    const capturedRequests: RuntimeChatRequest[] = [];
    let invocationCount = 0;
    const fixture = await createFixture(() => {
      const invocation = invocationCount;
      invocationCount += 1;
      return {
        async *streamChat(request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent> {
          capturedRequests[invocation] = request;
          starts[invocation]?.resolve();
          await gates[invocation]?.promise;
          yield { type: 'delta', content: `answer-${invocation + 1}` };
          yield { type: 'done', finishReason: 'stop' };
        },
      };
    });

    const first = fixture.services.chat.complete(
      {
        conversationId: fixture.conversationId,
        userMessageId: randomUUID(),
        modelId: fixture.modelId,
        messages: [{ role: 'user', content: 'question-1' }],
        stream: false,
      },
      fixture.actor,
    );
    await starts[0]?.promise;

    const second = fixture.services.chat.complete(
      {
        conversationId: fixture.conversationId,
        userMessageId: randomUUID(),
        modelId: fixture.modelId,
        messages: [{ role: 'user', content: 'question-2' }],
        stream: false,
      },
      fixture.actor,
    );
    await Promise.resolve();

    expect(invocationCount).toBe(1);
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([{ role: 'user', content: 'question-1' }]);

    gates[0]?.resolve();
    await starts[1]?.promise;
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: 'user', content: 'question-1' },
      { role: 'assistant', content: 'answer-1' },
      { role: 'user', content: 'question-2' },
    ]);
    expect(
      capturedRequests[1]?.messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content),
    ).toEqual(['question-1', 'answer-1', 'question-2']);

    gates[1]?.resolve();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { content: 'answer-1' },
      { content: 'answer-2' },
    ]);
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ sequence, role, content }) => ({ sequence, role, content })),
    ).toEqual([
      { sequence: 1, role: 'user', content: 'question-1' },
      { sequence: 2, role: 'assistant', content: 'answer-1' },
      { sequence: 3, role: 'user', content: 'question-2' },
      { sequence: 4, role: 'assistant', content: 'answer-2' },
    ]);
  });

  it('活动生成中止后释放会话租约，排队的下一轮可以继续', async () => {
    const starts = [deferred(), deferred()];
    const secondGate = deferred();
    let invocationCount = 0;
    const fixture = await createFixture(() => {
      const invocation = invocationCount;
      invocationCount += 1;
      return {
        async *streamChat(request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent> {
          starts[invocation]?.resolve();
          if (invocation === 0) {
            await new Promise<never>((_resolve, reject) => {
              if (request.signal?.aborted === true) {
                reject(request.signal.reason);
                return;
              }
              request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
                once: true,
              });
            });
          }
          await secondGate.promise;
          yield { type: 'delta', content: 'answer-after-abort' };
          yield { type: 'done', finishReason: 'stop' };
        },
      };
    });
    const controller = new AbortController();
    const firstOutcome = fixture.services.chat
      .complete(
        {
          conversationId: fixture.conversationId,
          userMessageId: randomUUID(),
          modelId: fixture.modelId,
          messages: [{ role: 'user', content: 'cancel-me' }],
          stream: false,
        },
        fixture.actor,
        { signal: controller.signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await starts[0]?.promise;
    const second = fixture.services.chat.complete(
      {
        conversationId: fixture.conversationId,
        userMessageId: randomUUID(),
        modelId: fixture.modelId,
        messages: [{ role: 'user', content: 'run-after-cancel' }],
        stream: false,
      },
      fixture.actor,
    );

    controller.abort(new Error('cancel active generation'));
    await starts[1]?.promise;
    expect(await firstOutcome).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'cancel active generation',
    });
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: 'user', content: 'cancel-me' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'run-after-cancel' },
    ]);

    secondGate.resolve();
    await expect(second).resolves.toMatchObject({ content: 'answer-after-abort' });
  });

  it('排队请求中止时不写入用户消息，也不会遗留阻塞节点', async () => {
    const starts = [deferred(), deferred()];
    const gates = [deferred(), deferred()];
    let invocationCount = 0;
    const fixture = await createFixture(() => {
      const invocation = invocationCount;
      invocationCount += 1;
      return {
        async *streamChat(): AsyncGenerator<ProviderStreamEvent> {
          starts[invocation]?.resolve();
          await gates[invocation]?.promise;
          yield { type: 'delta', content: `answer-${invocation + 1}` };
          yield { type: 'done', finishReason: 'stop' };
        },
      };
    });
    const first = fixture.services.chat.complete(
      {
        conversationId: fixture.conversationId,
        userMessageId: randomUUID(),
        modelId: fixture.modelId,
        messages: [{ role: 'user', content: 'question-1' }],
        stream: false,
      },
      fixture.actor,
    );
    await starts[0]?.promise;

    const controller = new AbortController();
    const abortReason = new Error('cancel queued generation');
    const waitingOutcome = fixture.services.chat
      .complete(
        {
          conversationId: fixture.conversationId,
          userMessageId: randomUUID(),
          modelId: fixture.modelId,
          messages: [{ role: 'user', content: 'must-not-persist' }],
          stream: false,
        },
        fixture.actor,
        { signal: controller.signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    controller.abort(abortReason);
    await expect(waitingOutcome).resolves.toBe(abortReason);
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([{ role: 'user', content: 'question-1' }]);

    gates[0]?.resolve();
    await first;
    const next = fixture.services.chat.complete(
      {
        conversationId: fixture.conversationId,
        userMessageId: randomUUID(),
        modelId: fixture.modelId,
        messages: [{ role: 'user', content: 'question-3' }],
        stream: false,
      },
      fixture.actor,
    );
    await starts[1]?.promise;
    gates[1]?.resolve();
    await expect(next).resolves.toMatchObject({ content: 'answer-2' });
    expect(
      fixture.services.repositories.conversations
        .listMessages(fixture.conversationId)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: 'user', content: 'question-1' },
      { role: 'assistant', content: 'answer-1' },
      { role: 'user', content: 'question-3' },
      { role: 'assistant', content: 'answer-2' },
    ]);
  });
});
