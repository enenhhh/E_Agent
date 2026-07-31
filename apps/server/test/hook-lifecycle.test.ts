import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProviderStreamEvent, RuntimeChatRequest } from '@e-agent/ai-runtime';
import { loadConfig } from '@e-agent/config';
import { createCoreServices } from '@e-agent/core';
import { openDatabase } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeExtensions } from '../src/extensions.js';
import { buildServer } from '../src/server.js';

const SECRET = 'hook-lifecycle-test-secret-at-least-32-chars';

describe('Server 插件 Hook 生命周期', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('覆盖注册、登录、退出、非流式、流式和失败聊天，且不传递凭据或正文', async () => {
    const database = openDatabase({ url: ':memory:' });
    const logger = createLogger({ level: 'silent' });
    const services = createCoreServices({
      database,
      masterKey: SECRET,
      sessionSecret: SECRET,
      logger,
      chatClientFactory: () => ({
        async *streamChat(_request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent> {
          yield { type: 'delta', content: 'hello' };
          yield {
            type: 'usage',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              cachedTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done', finishReason: 'stop' };
        },
      }),
    });
    const applicationData = await mkdtemp(join(tmpdir(), 'e-agent-hook-lifecycle-'));
    const extensions = await initializeExtensions({
      services,
      logger,
      developmentMode: false,
      applicationDataDirectory: applicationData,
      builtInSkillPaths: [],
      hostEntryPath: resolve(import.meta.dirname, '../../plugin-host/dist/main.js'),
    });
    const runHook = vi.spyOn(extensions, 'runHook');
    const app = await buildServer({
      config: loadConfig({
        NODE_ENV: 'test',
        E_AGENT_DATABASE_URL: ':memory:',
        E_AGENT_SESSION_SECRET: SECRET,
        E_AGENT_MASTER_KEY: SECRET,
      }),
      database,
      services,
      logger,
      extensions,
    });
    cleanup.push(async () => {
      await app.close();
      database.close();
      await rm(applicationData, { recursive: true, force: true });
    });

    const password = 'correct horse battery staple';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@example.com',
        displayName: 'Owner',
        password,
      },
    });
    expect(registration.statusCode).toBe(201);
    const token = (registration.json() as { accessToken: string }).accessToken;

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password },
    });
    expect(login.statusCode).toBe(200);

    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Hook Provider',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Hook Key',
      apiKey: 'hook-test-key-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'hook-model',
      displayName: 'Hook Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    services.settings.update({ defaultModels: { chat: model.id } });
    const headers = {
      authorization: `Bearer ${token}`,
      'x-request-id': 'hook-request',
    };

    const nonStreaming = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers,
      payload: {
        messages: [{ role: 'user', content: 'private prompt body' }],
        stream: false,
      },
    });
    expect(nonStreaming.statusCode).toBe(200);

    const streaming = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { ...headers, 'x-request-id': 'hook-stream-request' },
      payload: {
        messages: [{ role: 'user', content: 'another private prompt body' }],
        stream: true,
      },
    });
    expect(streaming.statusCode).toBe(200);
    expect(streaming.headers['content-type']).toContain('text/event-stream');

    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { ...headers, 'x-request-id': 'hook-failed-request' },
      payload: {
        modelId: crypto.randomUUID(),
        messages: [{ role: 'user', content: 'failed private prompt body' }],
        stream: false,
      },
    });
    expect(failed.statusCode).toBe(404);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers,
    });
    expect(logout.statusCode).toBe(204);

    const names = runHook.mock.calls.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        'session:created',
        'session:closed',
        'request:before',
        'request:after',
      ]),
    );
    expect(names.filter((name) => name === 'session:created')).toHaveLength(2);
    expect(names.filter((name) => name === 'request:before')).toHaveLength(3);
    expect(names.filter((name) => name === 'request:after')).toHaveLength(3);

    const afterPayloads = runHook.mock.calls
      .filter(([name]) => name === 'request:after')
      .map(
        ([, payload]) =>
          payload as { requestId: string; outcome: { success: boolean; errorCode: string | null } },
      );
    expect(afterPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'hook-request',
          outcome: expect.objectContaining({ success: true, errorCode: null }),
        }),
        expect.objectContaining({
          requestId: 'hook-stream-request',
          outcome: expect.objectContaining({ success: true, errorCode: null }),
        }),
        expect.objectContaining({
          requestId: 'hook-failed-request',
          outcome: expect.objectContaining({ success: false, errorCode: 'NOT_FOUND' }),
        }),
      ]),
    );

    const serializedHookCalls = JSON.stringify(runHook.mock.calls);
    expect(serializedHookCalls).not.toContain(password);
    expect(serializedHookCalls).not.toContain(token);
    expect(serializedHookCalls).not.toContain('private prompt body');
    expect(serializedHookCalls).not.toContain('authorization');
    expect(serializedHookCalls).not.toContain('hook-test-key-not-real');
  });
});
