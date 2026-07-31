import { loadConfig } from '@e-agent/config';
import { createCoreServices, type CoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

const SECRET = 'conversation-route-secret-with-more-than-32-characters';

describe('会话消息 HTTP 路由', () => {
  let app: FastifyInstance;
  let database: DatabaseContext;
  let services: CoreServices;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    database = openDatabase({ url: ':memory:' });
    services = createCoreServices({
      database,
      masterKey: SECRET,
      sessionSecret: SECRET,
    });
    app = await buildServer({
      config: loadConfig({
        NODE_ENV: 'test',
        E_AGENT_DATABASE_URL: ':memory:',
        E_AGENT_SESSION_SECRET: SECRET,
        E_AGENT_MASTER_KEY: SECRET,
      }),
      database,
      services,
      logger: createLogger({ level: 'silent' }),
    });
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'message-route-owner@example.com',
        displayName: 'Message Route Owner',
        password: 'correct horse battery staple',
      },
    });
    const body = registration.json() as { accessToken: string; user: { id: string } };
    token = body.accessToken;
    userId = body.user.id;
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  function headers(): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  it('通过 HTTP 创建带来源语义且排除原回答的重试分支', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Retry route',
    });
    services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });
    const assistant = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'First answer',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/branch`,
      headers: headers(),
      payload: {
        fromMessageId: assistant.id,
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: assistant.id,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      parentConversationId: conversation.id,
      branchedFromMessageId: assistant.id,
      forkKind: 'retry',
      originMessageId: assistant.id,
      messageCount: 1,
    });
  });

  it('通过 HTTP 重放相同 operationId 时返回同一分支', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Idempotent branch route',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });
    const request = {
      method: 'POST' as const,
      url: `/api/v1/conversations/${conversation.id}/branch`,
      headers: headers(),
      payload: {
        operationId: 'route-branch-operation',
        fromMessageId: message.id,
        includeFromMessage: true,
        kind: 'branch',
      },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
  });

  it('更新助手反馈并允许传入 null 撤销', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Feedback route',
    });
    const assistant = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Answer',
    });

    const helpful = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conversation.id}/messages/${assistant.id}/feedback`,
      headers: headers(),
      payload: { feedback: 'helpful' },
    });
    expect(helpful.statusCode).toBe(200);
    expect(helpful.json()).toMatchObject({ id: assistant.id, feedback: 'helpful' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conversation.id}/messages/${assistant.id}/feedback`,
      headers: headers(),
      payload: { feedback: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ id: assistant.id, feedback: null });
  });

  it('删除消息尾部并返回自动快照', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Delete route',
    });
    services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Keep',
    });
    const assistant = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Delete',
    });
    const tail = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Delete too',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conversation.id}/messages/${assistant.id}?expectedMessageCount=3&expectedTailMessageId=${tail.id}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversation: { id: conversation.id, messageCount: 1 },
      snapshot: { conversationId: conversation.id, messageCount: 3 },
      removedCount: 2,
    });
    expect(services.repositories.conversations.listMessages(conversation.id)).toHaveLength(1);
    expect(services.repositories.conversations.listSnapshots(conversation.id)).toHaveLength(1);
  });

  it('通过 HTTP 重放相同 operationId 时返回首次删除结果', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Idempotent delete route',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Delete',
    });
    const url = `/api/v1/conversations/${conversation.id}/messages/${message.id}?operationId=route-delete-operation&expectedMessageCount=1&expectedTailMessageId=${message.id}`;

    const first = await app.inject({ method: 'DELETE', url, headers: headers() });
    const replay = await app.inject({ method: 'DELETE', url, headers: headers() });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(services.repositories.conversations.listSnapshots(conversation.id)).toHaveLength(1);
  });

  it('将并发预条件映射为 409，并严格校验反馈目标与请求值', async () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId,
      title: 'Validation route',
    });
    const userMessage = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });

    const unsafeDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conversation.id}/messages/${userMessage.id}`,
      headers: headers(),
    });
    expect(unsafeDelete.statusCode).toBe(400);
    expect(services.repositories.conversations.listMessages(conversation.id)).toHaveLength(1);

    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conversation.id}/messages/${userMessage.id}?expectedMessageCount=0&expectedTailMessageId=${userMessage.id}`,
      headers: headers(),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CONFLICT' } });

    const wrongRole = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conversation.id}/messages/${userMessage.id}/feedback`,
      headers: headers(),
      payload: { feedback: 'helpful' },
    });
    expect(wrongRole.statusCode).toBe(400);
    expect(wrongRole.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

    const invalidFeedback = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conversation.id}/messages/${userMessage.id}/feedback`,
      headers: headers(),
      payload: { feedback: 'excellent' },
    });
    expect(invalidFeedback.statusCode).toBe(400);
    expect(invalidFeedback.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });
});
