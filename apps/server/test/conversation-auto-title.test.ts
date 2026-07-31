import { loadConfig } from '@e-agent/config';
import { createCoreServices, type CoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';

const SECRET = 'server-auto-title-secret-with-more-than-thirty-two-characters';

describe('Web 对话自动标题链路', () => {
  let app: FastifyInstance;
  let database: DatabaseContext;
  let services: CoreServices;
  let headers: { authorization: string };
  let modelId: string;

  beforeEach(async () => {
    database = openDatabase({ url: ':memory:' });
    services = createCoreServices({
      database,
      masterKey: SECRET,
      sessionSecret: SECRET,
      chatClientFactory: () => ({
        async *streamChat() {
          yield { type: 'delta' as const, content: '已完成路由修复。' };
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: 6,
              outputTokens: 4,
              totalTokens: 10,
              cachedTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      }),
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
        email: 'web-auto-title@example.com',
        displayName: 'Owner',
        password: 'correct horse battery staple',
      },
    });
    headers = {
      authorization: `Bearer ${(registration.json() as { accessToken: string }).accessToken}`,
    };
    const provider = services.keys.createProvider({
      type: 'ollama',
      name: 'Web Auto Title Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      keyStrategy: 'round-robin',
    });
    modelId = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'web-auto-title-model',
      displayName: 'Web Auto Title Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_192,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    }).id;
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('通过会话与非流式聊天接口完成默认标题替换', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers,
      payload: { projectId: null, title: '新会话' },
    });
    expect(created.statusCode).toBe(201);
    const conversation = created.json() as { id: string };

    const completion = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers,
      payload: {
        conversationId: conversation.id,
        modelId,
        messages: [
          {
            role: 'user',
            content: '## 请帮我 @web:https://example.test 修复用户路由的 404 问题。',
          },
        ],
        stream: false,
      },
    });
    expect(completion.statusCode).toBe(200);
    expect(completion.json()).toMatchObject({ content: '已完成路由修复。' });

    await vi.waitFor(async () => {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversation.id}`,
        headers,
      });
      expect(detail.json()).toMatchObject({
        conversation: { title: '修复用户路由的 404 问题' },
      });
    });
  });
});
