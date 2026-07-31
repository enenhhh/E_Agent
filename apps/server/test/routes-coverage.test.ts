import { ProviderError } from '@e-agent/ai-runtime';
import { loadConfig } from '@e-agent/config';
import { createCoreServices, type CoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';

const SECRET = 'server-route-test-secret-with-more-than-32-chars';

describe('服务端管理与诊断路由', () => {
  let app: FastifyInstance;
  let database: DatabaseContext;
  let services: CoreServices;
  let token: string;

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
        E_AGENT_ALLOWED_ORIGINS: 'https://allowed.example',
      }),
      database,
      services,
      logger: createLogger({ level: 'silent' }),
    });
    app.get('/test/provider-error', async () => {
      throw new ProviderError('upstream failed', {
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
      });
    });
    app.get('/test/rate-limit', async () => {
      throw Object.assign(new Error('rate limited'), { statusCode: 429 });
    });
    app.get('/test/internal-error', async () => {
      throw new Error('unexpected failure');
    });
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@example.com',
        displayName: 'Owner',
        password: 'correct horse battery staple',
      },
    });
    token = (registration.json() as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  function authorizedHeaders(): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  it('完成 Provider 与 API Key 的完整管理生命周期', async () => {
    const headers = authorizedHeaders();
    const createdProvider = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers,
      payload: {
        type: 'openai',
        name: 'Managed Provider',
        baseUrl: 'https://api.example.test/v1/',
        keyStrategy: 'round-robin',
      },
    });
    expect(createdProvider.statusCode).toBe(201);
    const provider = createdProvider.json() as { id: string };

    const providers = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers,
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ id: provider.id })]),
    });

    const updatedProvider = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${provider.id}`,
      headers,
      payload: { name: 'Primary Provider', keyStrategy: 'priority' },
    });
    expect(updatedProvider.statusCode).toBe(200);
    expect(updatedProvider.json()).toMatchObject({
      id: provider.id,
      name: 'Primary Provider',
      keyStrategy: 'priority',
    });

    const createdKey = await app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers,
      payload: {
        providerId: provider.id,
        label: 'Primary Key',
        apiKey: 'sk-route-test-not-real',
        priority: 10,
        dailyLimit: 5,
        monthlyLimit: 50,
        quotaUnit: 'usd',
        proxyUrl: null,
      },
    });
    expect(createdKey.statusCode).toBe(201);
    const key = createdKey.json() as { id: string };

    const updatedKey = await app.inject({
      method: 'PATCH',
      url: `/api/v1/keys/${key.id}`,
      headers,
      payload: {
        label: 'Backup Key',
        enabled: false,
        quotaUnit: 'tokens',
        proxyUrl: 'https://proxy.example.test',
      },
    });
    expect(updatedKey.statusCode).toBe(200);
    expect(updatedKey.json()).toMatchObject({
      id: key.id,
      label: 'Backup Key',
      enabled: false,
      quotaUnit: 'tokens',
      proxyConfigured: true,
    });

    const keys = await app.inject({ method: 'GET', url: '/api/v1/keys', headers });
    expect(keys.statusCode).toBe(200);
    expect(keys.json()).toMatchObject({
      keys: [expect.objectContaining({ id: key.id })],
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/keys/${key.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/keys', headers })).json(),
    ).toMatchObject({
      keys: [],
    });
  });

  it('读取并更新设置、模型、上下文、队列、审计与用量', async () => {
    const headers = authorizedHeaders();
    const provider = services.keys.createProvider({
      type: 'openai',
      name: 'Discovery Provider',
      baseUrl: 'https://discovery.example.test/v1',
      keyStrategy: 'round-robin',
    });
    const discover = vi
      .spyOn(services.models, 'discover')
      .mockResolvedValue([{ providerId: provider.id, discovered: 0, error: null }]);
    const model = services.repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'route-model',
      displayName: 'Route Model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_192,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });

    const modelList = await app.inject({
      method: 'GET',
      url: `/api/v1/models?providerId=${provider.id}`,
      headers,
    });
    expect(modelList.statusCode).toBe(200);

    const discovery = await app.inject({
      method: 'POST',
      url: '/api/v1/models/discover',
      headers,
      payload: { providerId: provider.id, force: true },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discover).toHaveBeenCalledWith(provider.id);
    expect(discovery.json()).toMatchObject({
      results: [{ providerId: provider.id, discovered: 0, error: null }],
    });

    const modelSelection = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${provider.id}/models`,
      headers,
      payload: { enabledModelIds: [model.id] },
    });
    expect(modelSelection.statusCode).toBe(200);
    expect(modelSelection.json()).toMatchObject({
      models: [
        expect.objectContaining({
          id: model.id,
          configuredEnabled: true,
          enabled: true,
        }),
      ],
    });

    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers })).statusCode).toBe(
      200,
    );
    const settings = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers,
      payload: {
        language: 'en-US',
        theme: 'cyberpunk',
        maxConcurrentRequests: 3,
        dailyCostAlertUsd: 9,
      },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      language: 'en-US',
      theme: 'cyberpunk',
      maxConcurrentRequests: 3,
      dailyCostAlertUsd: 9,
    });

    const queue = await app.inject({
      method: 'GET',
      url: '/api/v1/queue/status',
      headers,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({ concurrency: 3, active: 0, pending: 0 });

    const context = await app.inject({
      method: 'POST',
      url: '/api/v1/context/estimate',
      headers,
      payload: {
        messages: [{ role: 'user', content: 'Estimate this context.' }],
        contextWindow: 4096,
        maxOutputTokens: 512,
        threshold: 0.75,
        sources: [{ source: 'file', content: 'export const answer = 42;' }],
      },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      messages: expect.any(Array),
      breakdown: expect.objectContaining({ contextWindow: 4096 }),
    });

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=50',
      headers,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({
      logs: expect.any(Array),
      pageInfo: expect.any(Object),
    });

    const records = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/records?groupBy=model&limit=20',
      headers,
    });
    expect(records.statusCode).toBe(200);
    expect(records.json()).toEqual({ records: [] });

    const summary = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/summary?groupBy=day',
      headers,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      totals: { requestCount: 0, totalTokens: 0 },
      buckets: [],
    });

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/export?format=json&groupBy=month',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/json');
    expect(exported.headers['content-disposition']).toContain('e-agent-usage-');
    expect(JSON.parse(exported.body)).toMatchObject({ records: [] });
  });

  it('报告存活、就绪和指标，并在数据库异常时返回不可就绪', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok', service: 'e-agent-server' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      database: 'ok',
      queue: expect.any(Object),
      runtime: expect.any(Object),
    });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');

    const prepare = vi.spyOn(database.sqlite, 'prepare').mockImplementationOnce(() => {
      throw new Error('simulated database failure');
    });
    const unavailable = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ status: 'not-ready', database: 'error' });
    prepare.mockRestore();
  });

  it('管理当前用户和团队成员，并执行删除', async () => {
    const headers = authorizedHeaders();
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'owner@example.com', role: 'owner' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers,
      payload: {
        email: 'admin@example.com',
        displayName: 'Initial Admin',
        password: 'correct horse battery staple',
        role: 'admin',
      },
    });
    expect(created.statusCode).toBe(201);
    const member = created.json() as { id: string };

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${member.id}`,
      headers,
      payload: { displayName: 'Updated Admin', role: 'member' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: member.id,
      displayName: 'Updated Admin',
      role: 'member',
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${member.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
  });

  it('统一映射校验、上游、限流、未知和 404 错误', async () => {
    const headers = authorizedHeaders();

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers,
      payload: { maxConcurrentRequests: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: {
        code: 'BAD_REQUEST',
        retryable: false,
        details: { issues: expect.any(Array) },
      },
    });

    const provider = await app.inject({ method: 'GET', url: '/test/provider-error', headers });
    expect(provider.statusCode).toBe(502);
    expect(provider.json()).toMatchObject({
      error: {
        code: 'PROVIDER_ERROR',
        retryable: true,
        details: { providerCode: 'UPSTREAM_UNAVAILABLE' },
      },
    });

    const limited = await app.inject({ method: 'GET', url: '/test/rate-limit', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true },
    });

    const internal = await app.inject({ method: 'GET', url: '/test/internal-error', headers });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/not-a-real-route',
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
    });
  });

  it('应用 CORS 白名单，并支持由服务自身管理数据库生命周期', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/models',
      headers: {
        origin: 'https://allowed.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example');
    expect(allowed.headers['access-control-allow-methods']).toContain('PATCH');
    expect(allowed.headers['access-control-allow-methods']).toContain('DELETE');
    expect(allowed.headers['access-control-allow-methods']).toContain('PUT');

    const rejected = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/models',
      headers: {
        origin: 'https://blocked.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ error: 'Forbidden', statusCode: 403 });

    const owned = await buildServer({
      config: loadConfig({
        NODE_ENV: 'test',
        E_AGENT_DATABASE_URL: ':memory:',
        E_AGENT_SESSION_SECRET: SECRET,
        E_AGENT_MASTER_KEY: SECRET,
      }),
      logger: createLogger({ level: 'silent' }),
    });
    expect((await owned.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    await owned.close();
  });
});
