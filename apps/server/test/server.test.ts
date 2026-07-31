import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProviderStreamEvent, RuntimeChatRequest } from '@e-agent/ai-runtime';
import { loadConfig } from '@e-agent/config';
import { createCoreServices, type CoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import { TokenService } from '@e-agent/security';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initializeExtensions } from '../src/extensions.js';
import { buildServer } from '../src/server.js';

const SECRET = 'test-secret-with-more-than-thirty-two-characters';

describe('Fastify API', () => {
  let database: DatabaseContext;
  let services: CoreServices;
  let app: FastifyInstance;
  let extensionCleanup: (() => Promise<void>) | undefined;
  let runtimeRequests: RuntimeChatRequest[];

  beforeEach(async () => {
    runtimeRequests = [];
    database = openDatabase({ url: ':memory:' });
    services = createCoreServices({
      database,
      masterKey: SECRET,
      sessionSecret: SECRET,
      chatClientFactory: () => ({
        async *streamChat(request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent> {
          runtimeRequests.push(request);
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
    const config = loadConfig({
      NODE_ENV: 'test',
      E_AGENT_DATABASE_URL: ':memory:',
      E_AGENT_SESSION_SECRET: SECRET,
      E_AGENT_MASTER_KEY: SECRET,
    });
    app = await buildServer({
      config,
      database,
      services,
      logger: createLogger({ level: 'silent' }),
    });
  });

  afterEach(async () => {
    await app.close();
    await extensionCleanup?.();
    database.close();
  });

  async function register(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@example.com',
        displayName: 'Owner',
        password: 'correct horse battery staple',
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { accessToken: string }).accessToken;
  }

  it('报告健康状态并保护私有接口', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/models' })).statusCode).toBe(401);
    const token = await register();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/models',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/system/status',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('完成非流式聊天主流程', async () => {
    const token = await register();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Test',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Test Key',
      apiKey: 'sk-test-only-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'test-model',
      displayName: 'Test',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    services.settings.update({ defaultModels: { chat: model.id } });
    const userMessageId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userMessageId,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      },
    });
    expect(response.statusCode).toBe(200);
    const completion = response.json() as { content: string; conversationId: string };
    expect(completion.content).toBe('hello');
    const conversationDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${completion.conversationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(conversationDetail.statusCode).toBe(200);
    const persistedMessages = (
      conversationDetail.json() as { messages: Array<{ id: string; role: string }> }
    ).messages;
    expect(persistedMessages[0]).toMatchObject({ id: userMessageId, role: 'user' });
    const tailMessageId = persistedMessages.at(-1)?.id;
    expect(tailMessageId).toBeDefined();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${completion.conversationId}/context`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    const change = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${completion.conversationId}/file-changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { path: 'src/index.ts', diff: '@@ -1 +1 @@' },
    });
    expect(change.statusCode).toBe(201);
    const changeId = (change.json() as { id: string }).id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${completion.conversationId}/file-changes/${changeId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { decision: 'accept', acceptedLines: [1] },
        })
      ).statusCode,
    ).toBe(200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${completion.conversationId}/messages/${userMessageId}?expectedMessageCount=2&expectedTailMessageId=${tailMessageId ?? ''}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ removedCount: 2 });
  });

  it('流式取消确认等待服务端生成器 finally 完成', async () => {
    const token = await register();
    const cancellationId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    let signalReady!: () => void;
    const signalIsReady = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let cleanupStarted!: () => void;
    const cleanupHasStarted = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupFinished = false;

    vi.spyOn(services.chat, 'stream').mockImplementation(
      async function* (_request, _actor, options) {
        yield {
          type: 'start',
          requestId: crypto.randomUUID(),
          conversationId,
          messageId,
          model: 'test-model',
          createdAt: new Date().toISOString(),
        };
        try {
          const signal = options?.signal;
          if (signal === undefined) throw new Error('测试流缺少取消信号');
          signalReady();
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        } finally {
          cleanupStarted();
          await cleanupGate;
          cleanupFinished = true;
        }
      },
    );

    const streamResponsePromise = app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
      payload: {
        cancellationId,
        messages: [{ role: 'user', content: '等待取消' }],
        stream: true,
      },
    });
    await signalIsReady;

    let cancellationSettled = false;
    const cancellationResponsePromise = app
      .inject({
        method: 'POST',
        url: `/api/v1/chat/completions/${cancellationId}/cancel`,
        headers: { authorization: `Bearer ${token}` },
      })
      .then((response) => {
        cancellationSettled = true;
        return response;
      });
    await cleanupHasStarted;
    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    expect(cancellationSettled).toBe(false);

    releaseCleanup();
    const [cancellationResponse, streamResponse] = await Promise.all([
      cancellationResponsePromise,
      streamResponsePromise,
    ]);
    expect(cleanupFinished).toBe(true);
    expect(cancellationResponse.statusCode).toBe(200);
    expect(cancellationResponse.json()).toEqual({ cancellationId, settled: true });
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain('"type":"error"');
  });

  it('响应头返回前取消时记录预取消并阻止随后注册的流执行', async () => {
    const token = await register();
    const cancellationId = crypto.randomUUID();
    let observedAbortedSignal = false;
    vi.spyOn(services.chat, 'stream').mockImplementation(
      async function* (_request, _actor, options) {
        observedAbortedSignal = options?.signal?.aborted === true;
        if (options?.signal?.aborted === true) throw options.signal.reason;
        yield {
          type: 'start',
          requestId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          model: 'test-model',
          createdAt: new Date().toISOString(),
        };
      },
    );

    const cancellationResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/completions/${cancellationId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cancellationResponse.statusCode).toBe(200);
    expect(cancellationResponse.json()).toEqual({ cancellationId, settled: true });

    const streamResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
      payload: {
        cancellationId,
        messages: [{ role: 'user', content: '不应开始生成' }],
        stream: true,
      },
    });

    expect(observedAbortedSignal).toBe(true);
    expect(streamResponse.statusCode).not.toBe(200);
  });

  it('Owner 可管理成员，停用后旧 Token 立即失效', async () => {
    const ownerToken = await register();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        email: 'member@example.com',
        displayName: 'Member',
        password: 'correct horse battery staple',
        role: 'member',
      },
    });
    expect(created.statusCode).toBe(201);
    const member = created.json() as { id: string; active: boolean };
    expect(member.active).toBe(true);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'member@example.com',
        password: 'correct horse battery staple',
      },
    });
    expect(login.statusCode).toBe(200);
    const memberToken = (login.json() as { accessToken: string }).accessToken;

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${member.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { active: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ active: false });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(denied.statusCode).toBe(401);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(2);
  });

  it('安全安装并停用本地 Skill', async () => {
    const token = await register();
    const temporaryData = await mkdtemp(join(tmpdir(), 'e-agent-extension-test-'));
    const extensions = await initializeExtensions({
      services,
      logger: createLogger({ level: 'silent' }),
      developmentMode: false,
      applicationDataDirectory: temporaryData,
      builtInSkillPaths: [],
      hostEntryPath: resolve(import.meta.dirname, '../../plugin-host/dist/main.js'),
    });
    app.eAgent.extensions = extensions;
    extensionCleanup = async () => {
      await extensions.shutdown();
      await rm(temporaryData, { recursive: true, force: true });
    };
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/install',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: 'directory',
        path: resolve(import.meta.dirname, '../../../plugins/code-review'),
      },
    });
    expect(installed.statusCode).toBe(201);
    const skillId = (installed.json() as { skill: { id: string } }).skill.id;
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skills/${skillId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('健康检查返回诊断结果与刷新后的 Key 数据', async () => {
    const token = await register();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Health Test',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    const key = services.keys.create({
      providerId: provider.id,
      label: 'Health Key',
      apiKey: 'sk-test-only-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    vi.spyOn(services.keys, 'check').mockResolvedValue({
      id: key.id,
      health: 'healthy',
      latencyMs: 12,
      checkedAt: new Date().toISOString(),
      error: null,
    });

    const single = await app.inject({
      method: 'POST',
      url: `/api/v1/keys/${key.id}/check`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({
      id: key.id,
      providerId: provider.id,
      label: 'Health Key',
      health: 'healthy',
      latencyMs: 12,
    });

    const all = await app.inject({
      method: 'POST',
      url: '/api/v1/keys/check-all',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({
      results: [{ id: key.id, health: 'healthy' }],
      keys: [{ id: key.id, providerId: provider.id }],
    });
  });

  it('HTTP RBAC 阻止 Viewer 执行所有会话写操作', async () => {
    const viewer = services.repositories.users.create({
      email: 'viewer@example.com',
      displayName: 'Viewer',
      passwordHash: 'not-used-in-this-test',
      role: 'viewer',
    });
    const token = new TokenService(SECRET).issue({
      sub: viewer.id,
      email: viewer.email,
      role: viewer.role,
    }).token;
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: viewer.id,
      title: 'Read-only conversation',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'read-only',
    });
    const snapshot = services.repositories.conversations.createSnapshot(conversation.id);
    const change = services.repositories.conversations.createFileChange({
      conversationId: conversation.id,
      path: 'src/index.ts',
      diff: '@@ -1 +1 @@',
    });
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${conversation.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);

    const mutationRequests = [
      {
        method: 'POST' as const,
        url: '/api/v1/conversations',
        payload: { projectId: null, title: 'Denied' },
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/conversations/${conversation.id}`,
        payload: { title: 'Denied' },
      },
      {
        method: 'DELETE' as const,
        url: `/api/v1/conversations/${conversation.id}`,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${conversation.id}/branch`,
        payload: { fromMessageId: message.id, title: 'Denied' },
      },
      {
        method: 'DELETE' as const,
        url: `/api/v1/conversations/${conversation.id}/messages/${message.id}?expectedMessageCount=1&expectedTailMessageId=${message.id}`,
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/conversations/${conversation.id}/messages/${message.id}/feedback`,
        payload: { feedback: 'helpful' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${conversation.id}/snapshots`,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${conversation.id}/snapshots/${snapshot.id}/restore`,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${conversation.id}/file-changes`,
        payload: { path: 'src/denied.ts', diff: '@@ -0,0 +1 @@' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${conversation.id}/file-changes/${change.id}`,
        payload: { decision: 'accept' },
      },
    ];
    for (const mutation of mutationRequests) {
      const response = await app.inject({ ...mutation, headers });
      expect(response.statusCode, `${mutation.method} ${mutation.url}`).toBe(403);
    }
  });

  it('阻断低权限用户从全局用量 ID 读取其他项目记忆', async () => {
    const projectOwner = services.repositories.users.create({
      email: 'project-owner@example.com',
      displayName: 'Project Owner',
      passwordHash: 'not-used-in-this-test',
      role: 'member',
    });
    const attacker = services.repositories.users.create({
      email: 'attacker@example.com',
      displayName: 'Attacker',
      passwordHash: 'not-used-in-this-test',
      role: 'member',
    });
    const foreignProject = services.repositories.projects.create({
      ownerId: projectOwner.id,
      name: 'Private Project',
    });
    services.repositories.memories.upsert({
      projectId: foreignProject.id,
      category: 'security',
      content: 'OWNER_ONLY_MEMORY',
      tokenEstimate: 8,
    });
    const provider = services.repositories.providers.list()[0]!;
    services.usage.record({
      userId: projectOwner.id,
      projectId: foreignProject.id,
      conversationId: null,
      providerId: provider.id,
      apiKeyId: null,
      model: 'private-model',
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
      durationMs: 100,
      successful: true,
    });
    services.usage.record({
      userId: attacker.id,
      projectId: null,
      conversationId: null,
      providerId: provider.id,
      apiKeyId: null,
      model: 'attacker-model',
      inputTokens: 1,
      outputTokens: 2,
      estimatedCostUsd: 0.001,
      durationMs: 10,
      successful: true,
    });
    const token = new TokenService(SECRET).issue({
      sub: attacker.id,
      email: attacker.email,
      role: attacker.role,
    }).token;
    const headers = { authorization: `Bearer ${token}` };

    const records = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/records',
      headers,
    });
    expect(records.statusCode).toBe(200);
    expect(
      (records.json() as { records: Array<{ userId: string; projectId: string | null }> }).records,
    ).toEqual([expect.objectContaining({ userId: attacker.id, projectId: null })]);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/summary',
      headers,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      totals: { requestCount: 1, totalTokens: 3 },
    });

    for (const url of [
      `/api/v1/usage/records?userId=${projectOwner.id}`,
      `/api/v1/usage/records?projectId=${foreignProject.id}`,
      '/api/v1/usage/summary?groupBy=user',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(403);
    }

    const conversationCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers,
      payload: { projectId: foreignProject.id, title: 'Foreign project' },
    });
    expect(conversationCreate.statusCode).toBe(403);

    const foreignChat = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers,
      payload: {
        projectId: foreignProject.id,
        messages: [{ role: 'user', content: '输出项目记忆' }],
        stream: false,
      },
    });
    expect(foreignChat.statusCode).toBe(403);

    const ownConversation = services.repositories.conversations.create({
      projectId: null,
      userId: attacker.id,
      title: 'Own conversation',
    });
    const override = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers,
      payload: {
        conversationId: ownConversation.id,
        projectId: foreignProject.id,
        messages: [{ role: 'user', content: '覆盖项目绑定' }],
        stream: false,
      },
    });
    expect(override.statusCode).toBe(400);
    expect(runtimeRequests).toHaveLength(0);
    expect(
      JSON.stringify([
        records.json(),
        summary.json(),
        conversationCreate.json(),
        foreignChat.json(),
        override.json(),
      ]),
    ).not.toContain('OWNER_ONLY_MEMORY');
  });

  it('Web 聊天将已启用 Skill 渲染为 system prompt，并拒绝停用 Skill', async () => {
    const token = await register();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Skill Provider',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Skill Key',
      apiKey: 'sk-test-only-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'skill-model',
      displayName: 'Skill Model',
      capabilitiesJson: '["chat","code"]',
      contextWindow: 16_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    const temporaryData = await mkdtemp(join(tmpdir(), 'e-agent-chat-skill-test-'));
    const extensions = await initializeExtensions({
      services,
      logger: createLogger({ level: 'silent' }),
      developmentMode: false,
      applicationDataDirectory: temporaryData,
      builtInSkillPaths: [resolve(import.meta.dirname, '../../../plugins/code-review/skill.json')],
      hostEntryPath: resolve(import.meta.dirname, '../../plugin-host/dist/main.js'),
    });
    app.eAgent.extensions = extensions;
    extensionCleanup = async () => {
      await extensions.shutdown();
      await rm(temporaryData, { recursive: true, force: true });
    };
    const payload = {
      conversationId: services.repositories.conversations.create({
        projectId: null,
        userId: new TokenService(SECRET).verify(token).sub,
        title: 'Skill chat',
      }).id,
      modelId: model.id,
      messages: [{ role: 'user', content: 'const unsafe = true;' }],
      skill: '@code-review',
      contextMentions: [],
      stream: false,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'accept-language': 'zh-CN',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(runtimeRequests[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(String(runtimeRequests[0]?.messages[0]?.content)).toContain('const unsafe = true;');

    extensions.setSkillEnabled('com.eagent.code-review', false);
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(disabled.statusCode).toBe(403);
  });

  it('Web 上下文明确拒绝桌面文件提及与私网 @web 地址', async () => {
    const token = await register();
    for (const mention of ['@file:src/index.ts', '@folder:src', '@web:https://127.0.0.1/']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          modelId: crypto.randomUUID(),
          messages: [{ role: 'user', content: `inspect ${mention}` }],
          contextMentions: [mention],
          stream: false,
        },
      });
      expect(response.statusCode, mention).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'BAD_REQUEST' },
      });
    }
  });

  it('加载十一个内置 Skill 并完成 Workflow 保存、运行、审计和删除', async () => {
    const token = await register();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Workflow Provider',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Workflow Key',
      apiKey: 'sk-test-only-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'workflow-model',
      displayName: 'Workflow Model',
      capabilitiesJson: '["chat","code"]',
      contextWindow: 16_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    services.settings.update({ defaultModels: { chat: model.id } });
    const temporaryData = await mkdtemp(join(tmpdir(), 'e-agent-workflow-test-'));
    const skillNames = [
      'architect',
      'browser-research',
      'bug-fix',
      'computer-operator',
      'db-helper',
      'deploy',
      'doc-gen',
      'explain',
      'refactor',
      'security-audit',
      'test-gen',
    ];
    const extensions = await initializeExtensions({
      services,
      logger: createLogger({ level: 'silent' }),
      developmentMode: false,
      applicationDataDirectory: temporaryData,
      builtInSkillPaths: skillNames.map((name) =>
        resolve(import.meta.dirname, `../../../plugins/builtin-skills/skills/${name}/skill.json`),
      ),
      hostEntryPath: resolve(import.meta.dirname, '../../plugin-host/dist/main.js'),
    });
    app.eAgent.extensions = extensions;
    extensionCleanup = async () => {
      await extensions.shutdown();
      await rm(temporaryData, { recursive: true, force: true });
    };
    const headers = { authorization: `Bearer ${token}` };

    const skills = await app.inject({ method: 'GET', url: '/api/v1/skills', headers });
    expect(skills.statusCode).toBe(200);
    expect(
      (skills.json() as { skills: Array<{ command: string; source: string }> }).skills.map(
        (skill) => [skill.command, skill.source],
      ),
    ).toEqual([
      ['@architect', 'builtin'],
      ['@browser-research', 'builtin'],
      ['@bug-fix', 'builtin'],
      ['@computer-operator', 'builtin'],
      ['@db-helper', 'builtin'],
      ['@deploy', 'builtin'],
      ['@doc-gen', 'builtin'],
      ['@explain', 'builtin'],
      ['@refactor', 'builtin'],
      ['@security-audit', 'builtin'],
      ['@test-gen', 'builtin'],
    ]);

    const workflow = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.document-explain',
      name: 'Document and explain',
      steps: [
        {
          id: 'document',
          skillId: 'com.eagent.doc-gen',
          dependsOn: [],
          input: {
            code: '{{input.source}}',
            language: 'TypeScript',
          },
        },
        {
          id: 'explain',
          skillId: 'com.eagent.explain',
          dependsOn: ['document'],
          input: {
            code: '{{steps.document}}',
            language: 'Markdown',
          },
        },
      ],
    };
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: { workflow },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ workflow: { id: workflow.id } });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ workflows: [{ id: workflow.id }] });

    const executed = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflow.id}/run`,
      headers,
      payload: {
        variables: { source: 'export const value = 1;' },
        locale: 'zh-CN',
      },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      workflowId: workflow.id,
      outputs: { document: 'hello', explain: 'hello' },
    });
    expect(runtimeRequests).toHaveLength(2);
    expect(
      runtimeRequests[1]?.messages.some((message) => String(message.content).includes('hello')),
    ).toBe(true);
    expect(
      services.repositories.audit.list({ targetType: 'workflow' }).map((entry) => entry.action),
    ).toEqual(expect.arrayContaining(['workflow.save', 'workflow.run']));

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        workflow: {
          ...workflow,
          id: 'com.eagent.workflow.invalid-variable',
          steps: [{ ...workflow.steps[0], input: { unknown: 'value' } }],
        },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workflows/${workflow.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(extensions.workflows.get(workflow.id)).toBeUndefined();
  });

  it('SSE 在并发槽位繁忙时发送排队位置并在开始执行前清空', async () => {
    const token = await register();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Queue SSE Provider',
      baseUrl: 'https://example.test/v1',
      keyStrategy: 'round-robin',
    });
    services.keys.create({
      providerId: provider.id,
      label: 'Queue SSE Key',
      apiKey: 'sk-test-only-not-real',
      priority: 100,
      dailyLimit: null,
      monthlyLimit: null,
      quotaUnit: 'usd',
      proxyUrl: null,
    });
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'queue-sse-model',
      displayName: 'Queue SSE Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_000,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      metadataJson: '{}',
    });
    services.queue.setConcurrency(1);
    const blocker = await services.queue.acquire();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
      payload: {
        modelId: model.id,
        messages: [{ role: 'user', content: 'queued over HTTP' }],
        stream: true,
      },
    });
    for (let attempt = 0; attempt < 100 && services.queue.snapshot.pending === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(services.queue.snapshot.pending).toBe(1);
    blocker.release();

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: {"type":"queue","position":1,"active":1,"pending":1}');
    expect(response.body).toContain(
      'data: {"type":"queue","position":null,"active":1,"pending":0}',
    );
    expect(response.body.indexOf('"type":"queue","position":null')).toBeLessThan(
      response.body.indexOf('"type":"start"'),
    );
  });
});
