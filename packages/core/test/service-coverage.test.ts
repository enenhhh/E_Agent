import type { ProviderDiscoveryResult } from '@e-agent/ai-runtime';
import { discoverModels, OpenAICompatibleClient } from '@e-agent/ai-runtime';
import { createRepositories, openDatabase, type DatabaseContext } from '@e-agent/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../src/audit-service.js';
import { bootstrapDefaultProviders } from '../src/container.js';
import { KeyPool } from '../src/key-pool.js';
import { ApiKeyService } from '../src/key-service.js';
import { ModelService } from '../src/model-service.js';
import { UsageService } from '../src/usage-service.js';

const MASTER_KEY = 'coverage-master-key-that-is-at-least-thirty-two-characters';

vi.mock('@e-agent/ai-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverModels: vi.fn(),
    OpenAICompatibleClient: vi.fn(),
  };
});

describe('模型、密钥、用量与审计服务', () => {
  let database: DatabaseContext;
  let repositories: ReturnType<typeof createRepositories>;
  let keys: ApiKeyService;
  let keyPool: KeyPool;
  let models: ModelService;
  let usage: UsageService;
  let audit: AuditService;

  beforeEach(() => {
    database = openDatabase({ url: ':memory:' });
    repositories = createRepositories(database.db);
    keys = new ApiKeyService(
      repositories.providers,
      repositories.apiKeys,
      MASTER_KEY,
      repositories.audit,
    );
    keyPool = new KeyPool(repositories.providers, repositories.apiKeys, MASTER_KEY);
    models = new ModelService(repositories.providers, repositories.models, keyPool);
    usage = new UsageService(repositories.usage, repositories.settings, repositories.projects);
    audit = new AuditService(repositories.audit);
    vi.mocked(discoverModels).mockReset();
    vi.mocked(OpenAICompatibleClient).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  function createProvider(name = 'Provider', type: 'openai' | 'ollama' = 'openai') {
    return keys.createProvider(
      {
        type,
        name,
        baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434/v1///' : 'https://ai.test/v1///',
        keyStrategy: 'round-robin',
      },
      null,
    );
  }

  function createKey(providerId: string, overrides: Record<string, unknown> = {}) {
    return keys.create(
      {
        providerId,
        label: 'Primary',
        apiKey: 'coverage-only-key-not-real',
        priority: 10,
        dailyLimit: null,
        monthlyLimit: null,
        quotaUnit: 'usd',
        proxyUrl: 'http://127.0.0.1:8080',
        ...overrides,
      },
      null,
    );
  }

  function discoveryResult(
    providerId: string,
    overrides: Partial<ProviderDiscoveryResult> = {},
  ): ProviderDiscoveryResult {
    return {
      providerId,
      type: 'openai',
      models: [],
      discoveredAt: new Date('2026-07-28T08:00:00.000Z'),
      error: null,
      ...overrides,
    };
  }

  it('发现、缓存、读取并解析模型，同时隔离单个提供商失败', async () => {
    const provider = createProvider('Cloud');
    createKey(provider.id);
    const noKeyProvider = createProvider('No key');
    const ollama = createProvider('Local', 'ollama');

    vi.mocked(discoverModels).mockImplementation(async (candidate) => {
      if (candidate.id === provider.id) {
        return discoveryResult(provider.id, {
          models: [
            {
              id: 'code-model',
              displayName: 'Code Model',
              capabilities: ['chat', 'code', 'function-calling'],
              contextWindow: 32_000,
              metadata: {
                input_price_per_million: 1.25,
                output_price_per_million: Number.POSITIVE_INFINITY,
              },
            },
            {
              id: 'free-model',
              displayName: 'Free Model',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {
                input_price_per_million: -1,
                output_price_per_million: 1_000_001,
              },
            },
          ],
        });
      }
      return discoveryResult(candidate.id, {
        type: 'ollama',
        error: new Error('local discovery unavailable'),
      });
    });

    const results = await models.discover();
    expect(results).toEqual(
      expect.arrayContaining([
        { providerId: provider.id, discovered: 2, error: null },
        { providerId: noKeyProvider.id, discovered: 0, error: expect.any(String) },
        { providerId: ollama.id, discovered: 0, error: 'local discovery unavailable' },
      ]),
    );
    expect(discoverModels).toHaveBeenCalledTimes(2);

    const list = models.list(provider.id);
    expect(list.cachedAt).toBe('2026-07-28T08:00:00.000Z');
    expect(list.models).toHaveLength(2);
    const codeModel = list.models.find((model) => model.remoteId === 'code-model');
    expect(codeModel).toMatchObject({
      inputPricePerMillion: 1.25,
      outputPricePerMillion: null,
    });
    expect(models.get(codeModel!.id).provider).toBe('openai');
    expect(models.resolve({ modelId: codeModel!.id }).id).toBe(codeModel!.id);
    expect(models.resolve({ providerId: provider.id, remoteModel: 'code-model' }).id).toBe(
      codeModel!.id,
    );
    expect(() => models.resolve({ providerId: provider.id, remoteModel: 'missing' })).toThrow(
      /尚未发现/,
    );
    expect(() => models.resolve({})).toThrow(/必须指定/);
    expect(() => models.get('missing')).toThrow(/模型不存在/);
    await expect(models.discover('missing')).rejects.toThrow(/提供商不存在/);
  });

  it('持久化服务商模型选择，拒绝停用模型和停用服务商', () => {
    const provider = createProvider('Selectable');
    const first = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'first',
      displayName: 'First',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });
    const second = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'second',
      displayName: 'Second',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });

    expect(models.updateEnabledSelection(provider.id, [second.id]).models).toEqual([
      expect.objectContaining({ id: first.id, configuredEnabled: false, enabled: false }),
      expect.objectContaining({ id: second.id, configuredEnabled: true, enabled: true }),
    ]);
    expect(() => models.get(first.id)).toThrow(/模型已停用/);
    expect(() => models.resolve({ providerId: provider.id, remoteModel: first.remoteId })).toThrow(
      /模型已停用/,
    );
    expect(() => models.updateEnabledSelection(provider.id, [crypto.randomUUID()])).toThrow(
      /不属于该服务商/,
    );
    expect(() => models.updateEnabledSelection(crypto.randomUUID(), [])).toThrow(/提供商不存在/);

    keys.updateProvider(provider.id, { enabled: false });
    expect(models.list(provider.id).models).toEqual([
      expect.objectContaining({ id: first.id, configuredEnabled: false, enabled: false }),
      expect.objectContaining({ id: second.id, configuredEnabled: true, enabled: false }),
    ]);
    expect(() => models.get(second.id)).toThrow(/提供商已停用/);
    expect(() => models.resolve({ providerId: provider.id, remoteModel: second.remoteId })).toThrow(
      /提供商已停用/,
    );
  });

  it('发现结果会标记上游已下线模型，并在重新出现时恢复用户启用偏好', async () => {
    const provider = createProvider('Changing');
    createKey(provider.id);
    vi.mocked(discoverModels)
      .mockResolvedValueOnce(
        discoveryResult(provider.id, {
          models: [
            {
              id: 'temporary',
              displayName: 'Temporary',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {},
            },
            {
              id: 'stable',
              displayName: 'Stable',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        discoveryResult(provider.id, {
          models: [
            {
              id: 'stable',
              displayName: 'Stable',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        discoveryResult(provider.id, {
          models: [
            {
              id: 'temporary',
              displayName: 'Temporary',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {},
            },
            {
              id: 'stable',
              displayName: 'Stable',
              capabilities: ['chat'],
              contextWindow: null,
              metadata: {},
            },
          ],
        }),
      );

    await models.discover(provider.id);
    const initial = models.list(provider.id).models;
    const temporary = initial.find((model) => model.remoteId === 'temporary')!;
    const stable = initial.find((model) => model.remoteId === 'stable')!;
    models.updateEnabledSelection(provider.id, [temporary.id]);

    await models.discover(provider.id);
    expect(models.list(provider.id).models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: temporary.id,
          configuredEnabled: true,
          enabled: false,
          stale: true,
        }),
        expect.objectContaining({
          id: stable.id,
          configuredEnabled: false,
          enabled: false,
          stale: false,
        }),
      ]),
    );
    expect(() => models.get(temporary.id)).toThrow(/最新模型列表/);

    await models.discover(provider.id);
    expect(models.get(temporary.id)).toMatchObject({
      id: temporary.id,
      configuredEnabled: true,
      enabled: true,
      stale: false,
    });

    models.invalidateProvider(provider.id);
    expect(() => models.get(temporary.id)).toThrow(/最新模型列表/);
  });

  it('返回空模型缓存，并丢弃失去提供商关联的模型', () => {
    expect(models.list()).toEqual({ models: [], cachedAt: null });
    const provider = createProvider();
    repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'orphan',
      displayName: 'Orphan',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });
    database.sqlite.pragma('foreign_keys = OFF');
    database.sqlite.prepare('DELETE FROM providers WHERE id = ?').run(provider.id);
    expect(models.list().models).toEqual([]);
  });

  it('覆盖提供商与密钥的创建、更新、配额暂停、统计和删除', () => {
    expect(() =>
      keys.createProvider({
        type: 'openai',
        name: 'Clear text cloud',
        baseUrl: 'http://api.example.test/v1',
        keyStrategy: 'round-robin',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      keys.createProvider({
        type: 'ollama',
        name: 'Remote Ollama',
        baseUrl: 'http://192.168.1.20:11434/v1',
        keyStrategy: 'round-robin',
      }),
    ).toThrow(/回环/);
    expect(() =>
      keys.createProvider({
        type: 'custom',
        name: 'Embedded secret',
        baseUrl: 'https://user:password@example.test/v1',
        keyStrategy: 'round-robin',
      }),
    ).toThrow(/HTTPS|回环/);
    expect(() =>
      keys.createProvider({
        type: 'custom',
        name: 'Query secret',
        baseUrl: 'https://example.test/v1?api_key=secret',
        keyStrategy: 'round-robin',
      }),
    ).toThrow(/HTTPS|回环/);
    const provider = createProvider();
    expect(provider.baseUrl).toBe('https://ai.test/v1');
    const updatedProvider = keys.updateProvider(
      provider.id,
      {
        type: 'anthropic',
        name: 'Renamed',
        baseUrl: 'https://renamed.test///',
        keyStrategy: 'priority',
      },
      null,
    );
    expect(updatedProvider).toMatchObject({
      type: 'anthropic',
      name: 'Renamed',
      baseUrl: 'https://renamed.test',
      keyStrategy: 'priority',
    });
    expect(() =>
      keys.updateProvider(provider.id, {
        type: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).toThrow(/HTTPS/);
    expect(() => keys.updateProvider('missing', { name: 'Nope' })).toThrow(/提供商不存在/);
    expect(() => createKey('missing')).toThrow(/提供商不存在/);

    const key = createKey(provider.id, { dailyLimit: 2, monthlyLimit: 5 });
    const updated = keys.update(
      key.id,
      {
        label: 'Backup',
        apiKey: 'updated-coverage-key-not-real',
        proxyUrl: null,
        priority: 2,
        enabled: true,
        dailyLimit: 0,
        monthlyLimit: 4,
        quotaUnit: 'tokens',
      },
      null,
    );
    expect(updated).toMatchObject({
      label: 'Backup',
      priority: 2,
      health: 'paused',
      pausedReason: 'quota-exceeded',
      quotaUnit: 'tokens',
      todayUsed: 0,
      monthUsed: 0,
    });
    expect(updated.maskedKey).not.toContain('updated-coverage');
    expect(keys.list().totals).toMatchObject({ available: 0, todayUsed: 0, monthUsed: 0 });
    expect(() => keys.update('missing', { label: 'Nope' })).toThrow(/API Key 不存在/);

    expect(
      keys.update(key.id, { dailyLimit: 10, enabled: true, proxyUrl: 'http://proxy.test' }),
    ).toMatchObject({ health: 'unknown', pausedReason: null });
    keys.delete(key.id);
    expect(() => keys.delete(key.id)).toThrow(/API Key 不存在/);
    expect(
      repositories.audit
        .list({ limit: 20 })
        .map((entry) => entry.action)
        .sort(),
    ).toEqual(
      expect.arrayContaining([
        'api-key.create',
        'api-key.delete',
        'api-key.update',
        'provider.create',
        'provider.update',
      ]),
    );
  });

  it('将健康响应分为健康、警告和不可用，并清理客户端', async () => {
    const provider = createProvider();
    const key = createKey(provider.id);
    const close = vi.fn().mockRejectedValue(new Error('close failure'));
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, status: 200, latencyMs: 4, error: null })
      .mockResolvedValueOnce({
        healthy: false,
        status: 429,
        latencyMs: 8,
        error: 'rate limited sk-sensitive-value',
      })
      .mockResolvedValueOnce({
        healthy: false,
        status: 401,
        latencyMs: 6,
        error: 'unauthorized bearer secret',
      });
    vi.mocked(OpenAICompatibleClient).mockImplementation(function MockClient() {
      return { checkHealth, close } as unknown as OpenAICompatibleClient;
    });

    await expect(keys.check(key.id)).resolves.toMatchObject({ health: 'healthy', error: null });
    await expect(keys.check(key.id)).resolves.toMatchObject({ health: 'warning' });
    await expect(keys.check(key.id)).resolves.toMatchObject({ health: 'unhealthy' });
    expect(close).toHaveBeenCalledTimes(3);
    expect(repositories.apiKeys.get(key.id)?.lastError).not.toContain('sk-sensitive-value');

    repositories.apiKeys.update(key.id, {
      dailyLimit: 1,
      todayUsed: 1,
      usageDay: new Date().toISOString().slice(0, 10),
    });
    checkHealth.mockResolvedValueOnce({ healthy: true, status: 200, latencyMs: 2, error: null });
    await keys.check(key.id);
    expect(repositories.apiKeys.get(key.id)).toMatchObject({
      health: 'paused',
      pausedReason: 'quota-exceeded',
    });
    await expect(keys.check('missing')).rejects.toThrow(/API Key 不存在/);
  });

  it('密文损坏时安全失败，批量检查隔离故障并支持取消', async () => {
    const provider = createProvider();
    const broken = createKey(provider.id);
    repositories.apiKeys.update(broken.id, { encryptedSecret: 'not-an-encrypted-secret' });
    await expect(keys.check(broken.id)).rejects.toThrow(/无法解密/);
    expect(repositories.apiKeys.get(broken.id)).toMatchObject({
      health: 'unhealthy',
      lastError: '本地密钥无法解密',
    });

    const valid = createKey(provider.id, { label: 'Valid' });
    const checkHealth = vi.fn().mockResolvedValue({
      healthy: true,
      status: 200,
      latencyMs: 1,
      error: null,
    });
    vi.mocked(OpenAICompatibleClient).mockImplementation(function MockClient() {
      return {
        checkHealth,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpenAICompatibleClient;
    });
    await expect(keys.check(valid.id)).resolves.toMatchObject({ id: valid.id, health: 'healthy' });
    const results = await keys.checkAll();
    expect(results.map((result) => result.id)).toEqual([valid.id]);

    const controller = new AbortController();
    controller.abort();
    await expect(keys.checkAll(controller.signal)).resolves.toEqual([]);
  });

  it('停用服务商后 Key 不计为可用，单个与批量健康检查均不发起网络请求', async () => {
    const provider = createProvider('Disabled');
    const key = createKey(provider.id);
    keys.updateProvider(provider.id, { enabled: false });
    const checkHealth = vi.fn().mockResolvedValue({
      healthy: true,
      status: 200,
      latencyMs: 1,
      error: null,
    });
    vi.mocked(OpenAICompatibleClient).mockImplementation(function MockClient() {
      return {
        checkHealth,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpenAICompatibleClient;
    });

    expect(keys.list().totals.available).toBe(0);
    await expect(keys.check(key.id)).rejects.toThrow(/服务商已停用/);
    await expect(keys.checkAll()).resolves.toEqual([]);
    expect(OpenAICompatibleClient).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('健康检查定时器校验边界并可被停止', () => {
    expect(() => keys.startHealthChecks(999)).toThrow(/1 秒到 7 天/);
    expect(() => keys.startHealthChecks(1_500.5)).toThrow(/1 秒到 7 天/);
    expect(() => keys.startHealthChecks(7 * 24 * 60 * 60 * 1_000 + 1)).toThrow(/1 秒到 7 天/);

    vi.useFakeTimers();
    const checkAll = vi.spyOn(keys, 'checkAll').mockResolvedValue([]);
    const stop = keys.startHealthChecks(1_000);
    vi.advanceTimersByTime(1_000);
    expect(checkAll).toHaveBeenCalledOnce();
    stop();
    vi.advanceTimersByTime(2_000);
    expect(checkAll).toHaveBeenCalledOnce();
  });

  it('密钥池支持本地模型、优先级、轮询、代理、配额和安全用量', () => {
    const local = createProvider('Local', 'ollama');
    expect(keyPool.select(local.id)).toMatchObject({
      keyId: null,
      apiKey: undefined,
      proxyUrl: null,
    });
    const provider = createProvider();
    const first = createKey(provider.id, { label: 'First', priority: 1 });
    const second = createKey(provider.id, {
      label: 'Second',
      priority: 2,
      proxyUrl: null,
      quotaUnit: 'tokens',
      dailyLimit: 5,
    });
    expect(keyPool.select(provider.id).keyId).toBe(first.id);
    expect(keyPool.select(provider.id).keyId).toBe(second.id);
    expect(keyPool.select(provider.id).proxyUrl).toBe('http://127.0.0.1:8080');

    keyPool.recordUsage(second.id, Number.NaN, Number.POSITIVE_INFINITY);
    expect(repositories.apiKeys.get(second.id)).toMatchObject({
      health: 'paused',
      pausedReason: 'quota-exceeded',
    });
    keyPool.recordUsage(null, 1, 1);
    keyPool.recordUsage('missing', 1, 1);
    expect(() => keyPool.select('missing')).toThrow(/不存在或已停用/);

    repositories.apiKeys.update(first.id, { enabled: false });
    expect(() => keyPool.select(provider.id)).toThrow(/没有可用 API Key/);
  });

  it('按所有维度聚合用量，处理筛选、异常数字和成本告警', () => {
    const provider = createProvider();
    const today = new Date();
    today.setUTCHours(10, 15, 0, 0);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    usage.record({
      occurredAt: today,
      userId: null,
      projectId: null,
      conversationId: null,
      providerId: provider.id,
      apiKeyId: null,
      model: 'model,"one"',
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 50,
      estimatedCostUsd: 6,
      durationMs: 120,
      cacheHit: true,
      successful: true,
    });
    usage.record({
      occurredAt: yesterday,
      userId: null,
      projectId: null,
      conversationId: null,
      providerId: provider.id,
      apiKeyId: null,
      model: 'model-two',
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: Number.NaN,
      estimatedCostUsd: -1,
      durationMs: Number.POSITIVE_INFINITY,
      successful: false,
      errorCode: 'UPSTREAM',
    });

    expect(
      usage.records({
        from: yesterday.toISOString(),
        to: new Date(today.getTime() + 1_000).toISOString(),
        model: 'model,"one"',
        groupBy: 'day',
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(
      usage.records({
        projectId: 'missing-project',
        userId: 'missing-user',
        groupBy: 'day',
        limit: 10,
      }),
    ).toHaveLength(0);
    for (const groupBy of ['hour', 'day', 'week', 'month', 'model', 'project', 'user'] as const) {
      const summary = usage.summary({ groupBy, limit: 20 });
      expect(summary.totals.requestCount).toBe(2);
      expect(summary.buckets.length).toBeGreaterThan(0);
    }
    expect(usage.summary({ groupBy: 'day', limit: 20 }).costAlert).toMatchObject({
      currentUsd: 6,
      exceeded: true,
    });
    expect(
      new UsageService(repositories.usage, repositories.settings, repositories.projects).summary({
        from: '2000-01-01T00:00:00.000Z',
        to: '2000-01-02T00:00:00.000Z',
        groupBy: 'day',
        limit: 20,
      }).totals.averageDurationMs,
    ).toBe(0);
  });

  it('导出可解析的 JSON、转义 CSV 与跨页 PDF', async () => {
    const provider = createProvider();
    for (let index = 0; index < 45; index += 1) {
      usage.record({
        occurredAt: new Date(`2026-07-${String((index % 20) + 1).padStart(2, '0')}T08:00:00Z`),
        userId: null,
        projectId: null,
        conversationId: null,
        providerId: provider.id,
        apiKeyId: null,
        model: index === 0 ? '中文,"model"' : `model-${index}`,
        inputTokens: 1,
        outputTokens: 2,
        estimatedCostUsd: 0.000_001,
        durationMs: 3,
        successful: index % 2 === 0,
      });
    }

    const query = { groupBy: 'day' as const, limit: 200 };
    const json = await usage.export(query, 'json');
    expect(json.contentType).toContain('application/json');
    expect(JSON.parse(Buffer.from(json.data).toString('utf8')).records).toHaveLength(45);

    const csv = await usage.export(query, 'csv');
    const csvText = Buffer.from(csv.data).toString('utf8');
    expect(csvText.startsWith('\uFEFFoccurredAt,model')).toBe(true);
    expect(csvText).toContain('"中文,""model"""');

    const pdf = await usage.export(query, 'pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect(Buffer.from(pdf.data).subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(pdf.data.byteLength).toBeGreaterThan(1_000);
  });

  it('审计日志支持筛选、游标分页及无效游标回退', () => {
    for (let index = 0; index < 4; index += 1) {
      repositories.audit.record({
        actorId: null,
        action: index % 2 === 0 ? 'key.update' : 'session.create',
        targetType: index % 2 === 0 ? 'api-key' : 'session',
        targetId: `target-${index}`,
        metadata: { index },
        ipAddress: index === 0 ? '127.0.0.1' : null,
      });
    }
    const first = audit.list({ limit: 2 });
    expect(first.logs).toHaveLength(2);
    expect(first.pageInfo).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const second = audit.list({ limit: 2, cursor: first.pageInfo.nextCursor! });
    expect(second.logs).toHaveLength(2);
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(
      audit.list({ limit: 10, action: 'key.update', targetType: 'api-key' }).logs,
    ).toHaveLength(2);
    expect(audit.list({ limit: 1, cursor: 'bm90LWEtbnVtYmVy' }).logs).toHaveLength(1);
    expect(audit.list({ limit: 1, cursor: 'LTE' }).logs).toHaveLength(1);
    expect(
      audit.list({ limit: 1, cursor: Symbol('invalid') as unknown as string }).logs,
    ).toHaveLength(1);
  });

  it('仅在缺失时引导默认云端与本地提供商', () => {
    expect(() =>
      bootstrapDefaultProviders(repositories, {
        openAiBaseUrl: 'http://api.example.test/v1',
        ollamaUrl: 'http://127.0.0.1:11434',
      }),
    ).toThrow(/不安全/);
    expect(() =>
      bootstrapDefaultProviders(repositories, {
        openAiBaseUrl: 'https://openai.test/v1',
        ollamaUrl: 'http://192.168.1.20:11434',
      }),
    ).toThrow(/不安全/);
    expect(repositories.providers.list()).toEqual([]);
    bootstrapDefaultProviders(repositories, {
      openAiBaseUrl: 'https://openai.test/v1',
      ollamaUrl: 'http://127.0.0.1:11434///',
    });
    expect(
      repositories.providers
        .list()
        .map((provider) => provider.type)
        .sort(),
    ).toEqual(['ollama', 'openai']);
    expect(
      repositories.providers.list().find((provider) => provider.type === 'ollama')?.baseUrl,
    ).toBe('http://127.0.0.1:11434/v1');
    bootstrapDefaultProviders(repositories, {
      openAiBaseUrl: 'https://ignored.test/v1',
      ollamaUrl: 'http://127.0.0.2:11434',
    });
    expect(repositories.providers.list()).toHaveLength(2);
  });
});
