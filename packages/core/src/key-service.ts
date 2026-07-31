import { OpenAICompatibleClient } from '@e-agent/ai-runtime';
import {
  isAllowedProviderBaseUrl,
  type ApiKeyHealthCheck,
  type CreateApiKeyRequest,
  type CreateProviderRequest,
  type KeyListResponse,
  type UpdateApiKeyRequest,
  type UpdateProviderRequest,
} from '@e-agent/contracts';
import type {
  ApiKeyRow,
  ApiKeysRepository,
  AuditRepository,
  ProvidersRepository,
} from '@e-agent/database';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  redactText,
  type MasterKey,
} from '@e-agent/security';

import { DomainError, assertFound } from './errors.js';
import { mapApiKey, mapProvider } from './mappers.js';

export type HealthCheckResult = ApiKeyHealthCheck;

function quotaExceeded(key: ApiKeyRow): boolean {
  return (
    (key.dailyLimit !== null && key.todayUsed >= key.dailyLimit) ||
    (key.monthlyLimit !== null && key.monthUsed >= key.monthlyLimit)
  );
}

function refreshQuotaPeriod(
  repository: ApiKeysRepository,
  key: ApiKeyRow,
  at = new Date(),
): ApiKeyRow {
  const day = at.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const patch: Parameters<ApiKeysRepository['update']>[1] = {};
  const projected = { ...key };
  if (key.usageDay !== day) {
    patch.usageDay = day;
    patch.todayUsed = 0;
    projected.usageDay = day;
    projected.todayUsed = 0;
  }
  if (key.usageMonth !== month) {
    patch.usageMonth = month;
    patch.monthUsed = 0;
    projected.usageMonth = month;
    projected.monthUsed = 0;
  }
  if (key.pausedReason === 'quota-exceeded' && !quotaExceeded(projected)) {
    patch.health = 'unknown';
    patch.pausedReason = null;
  }
  return Object.keys(patch).length === 0 ? key : (repository.update(key.id, patch) ?? key);
}

/** API Key 生命周期、健康检查和提供商配置服务。 */
export class ApiKeyService {
  #healthCheckRunning = false;

  public constructor(
    private readonly providers: ProvidersRepository,
    private readonly keys: ApiKeysRepository,
    private readonly masterKey: MasterKey,
    private readonly audit?: AuditRepository,
  ) {}

  public list(): KeyListResponse {
    const now = new Date();
    const providerRows = this.providers.list();
    const enabledProviderIds = new Set(
      providerRows.filter((provider) => provider.enabled).map((provider) => provider.id),
    );
    const keys = this.keys
      .list()
      .map((key) => refreshQuotaPeriod(this.keys, key, now))
      .map(mapApiKey);
    return {
      providers: providerRows.map(mapProvider),
      keys,
      totals: {
        available: keys.filter(
          (key) =>
            enabledProviderIds.has(key.providerId) &&
            key.enabled &&
            ['healthy', 'warning', 'unknown'].includes(key.health),
        ).length,
        todayUsed: keys.reduce((sum, key) => sum + key.todayUsed, 0),
        monthUsed: keys.reduce((sum, key) => sum + key.monthUsed, 0),
      },
    };
  }

  public createProvider(input: CreateProviderRequest, actorId: string | null = null) {
    if (!isAllowedProviderBaseUrl(input.type, input.baseUrl)) {
      throw new DomainError(
        'BAD_REQUEST',
        '提供商地址不能包含凭据或敏感查询；云端必须使用 HTTPS，HTTP 仅允许 Ollama 本机回环地址',
      );
    }
    const provider = this.providers.create({
      type: input.type,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      keyStrategy: input.keyStrategy,
    });
    this.audit?.record({
      actorId,
      action: 'provider.create',
      targetType: 'provider',
      targetId: provider.id,
      metadata: { type: provider.type, name: provider.name },
    });
    return mapProvider(provider);
  }

  public updateProvider(id: string, input: UpdateProviderRequest, actorId: string | null = null) {
    const current = assertFound(this.providers.get(id), '提供商不存在');
    const nextType = input.type ?? current.type;
    const nextBaseUrl = input.baseUrl ?? current.baseUrl;
    if (!isAllowedProviderBaseUrl(nextType, nextBaseUrl)) {
      throw new DomainError(
        'BAD_REQUEST',
        '提供商地址不能包含凭据或敏感查询；云端必须使用 HTTPS，HTTP 仅允许 Ollama 本机回环地址',
      );
    }
    const provider = assertFound(
      this.providers.update(id, {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl.replace(/\/+$/, '') }),
        ...(input.keyStrategy === undefined ? {} : { keyStrategy: input.keyStrategy }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }),
      '提供商不存在',
    );
    this.audit?.record({
      actorId,
      action: 'provider.update',
      targetType: 'provider',
      targetId: id,
      metadata: { fields: Object.keys(input) },
    });
    return mapProvider(provider);
  }

  public create(input: CreateApiKeyRequest, actorId: string | null = null) {
    const provider = assertFound(this.providers.get(input.providerId), '提供商不存在');
    const key = this.keys.create({
      providerId: input.providerId,
      label: input.label,
      encryptedSecret: encryptSecret(
        input.apiKey,
        this.masterKey,
        `provider:${provider.id}:api-key`,
      ),
      maskedKey: maskSecret(input.apiKey),
      encryptedProxyUrl:
        input.proxyUrl === null
          ? null
          : encryptSecret(input.proxyUrl, this.masterKey, `provider:${provider.id}:proxy`),
      priority: input.priority,
      dailyLimit: input.dailyLimit,
      monthlyLimit: input.monthlyLimit,
      quotaUnit: input.quotaUnit,
    });
    this.audit?.record({
      actorId,
      action: 'api-key.create',
      targetType: 'api-key',
      targetId: key.id,
      metadata: { providerId: key.providerId, label: key.label },
    });
    return mapApiKey(key);
  }

  public update(id: string, input: UpdateApiKeyRequest, actorId: string | null = null) {
    const now = new Date();
    const current = refreshQuotaPeriod(
      this.keys,
      assertFound(this.keys.get(id), 'API Key 不存在'),
      now,
    );
    const patch: Parameters<ApiKeysRepository['update']>[1] = {
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
      ...(input.monthlyLimit === undefined ? {} : { monthlyLimit: input.monthlyLimit }),
      ...(input.quotaUnit === undefined ? {} : { quotaUnit: input.quotaUnit }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
    if (input.quotaUnit !== undefined && input.quotaUnit !== current.quotaUnit) {
      patch.todayUsed = 0;
      patch.monthUsed = 0;
      patch.usageDay = now.toISOString().slice(0, 10);
      patch.usageMonth = now.toISOString().slice(0, 7);
    }
    if (input.apiKey !== undefined) {
      patch.encryptedSecret = encryptSecret(
        input.apiKey,
        this.masterKey,
        `provider:${current.providerId}:api-key`,
      );
      patch.maskedKey = maskSecret(input.apiKey);
      patch.health = 'unknown';
      patch.lastError = null;
    }
    if (input.proxyUrl !== undefined) {
      patch.encryptedProxyUrl =
        input.proxyUrl === null
          ? null
          : encryptSecret(input.proxyUrl, this.masterKey, `provider:${current.providerId}:proxy`);
    }
    const projected = { ...current, ...patch };
    if (projected.enabled && quotaExceeded(projected)) {
      patch.health = 'paused';
      patch.pausedReason = 'quota-exceeded';
    } else if (
      projected.enabled &&
      (input.enabled === true ||
        current.pausedReason === 'quota-exceeded' ||
        input.quotaUnit !== undefined)
    ) {
      patch.health = 'unknown';
      patch.pausedReason = null;
    }
    const key = assertFound(this.keys.update(id, patch), 'API Key 不存在');
    this.audit?.record({
      actorId,
      action: 'api-key.update',
      targetType: 'api-key',
      targetId: id,
      metadata: { fields: Object.keys(input) },
    });
    return mapApiKey(key);
  }

  public delete(id: string, actorId: string | null = null): void {
    if (!this.keys.delete(id)) throw new DomainError('NOT_FOUND', 'API Key 不存在');
    this.audit?.record({
      actorId,
      action: 'api-key.delete',
      targetType: 'api-key',
      targetId: id,
    });
  }

  public async check(id: string, signal?: AbortSignal): Promise<HealthCheckResult> {
    const key = refreshQuotaPeriod(this.keys, assertFound(this.keys.get(id), 'API Key 不存在'));
    const provider = assertFound(this.providers.get(key.providerId), '提供商不存在');
    if (!provider.enabled) {
      throw new DomainError('BAD_REQUEST', '服务商已停用，无法执行 API Key 健康检查');
    }
    let secret: string;
    let proxyUrl: string | null;
    try {
      secret = decryptSecret(
        key.encryptedSecret,
        this.masterKey,
        `provider:${provider.id}:api-key`,
      );
      proxyUrl =
        key.encryptedProxyUrl === null
          ? null
          : decryptSecret(key.encryptedProxyUrl, this.masterKey, `provider:${provider.id}:proxy`);
    } catch (error) {
      this.keys.update(id, {
        health: 'unhealthy',
        lastCheckedAt: new Date(),
        lastError: '本地密钥无法解密',
      });
      throw new DomainError('INTERNAL_ERROR', '本地密钥无法解密', { cause: error });
    }
    const client = new OpenAICompatibleClient({
      baseUrl: provider.baseUrl,
      ...(provider.type === 'ollama' ? { allowInsecureLoopback: true } : {}),
      apiKey: secret,
      proxyUrl,
      timeoutMs: 20_000,
      maxAttempts: 1,
    });
    const health = await client.checkHealth(signal).finally(async () => {
      await client.close().catch(() => undefined);
    });
    const keyHealth = health.healthy
      ? 'healthy'
      : health.status === 429 || (health.status ?? 0) >= 500
        ? 'warning'
        : 'unhealthy';
    const checkedAt = new Date();
    const latestKey = refreshQuotaPeriod(this.keys, this.keys.get(id) ?? key, checkedAt);
    const isQuotaPaused = quotaExceeded(latestKey);
    this.keys.update(id, {
      health: isQuotaPaused ? 'paused' : keyHealth,
      lastCheckedAt: checkedAt,
      lastError: health.error === null ? null : redactText(health.error),
      ...(isQuotaPaused
        ? { pausedReason: 'quota-exceeded' }
        : latestKey.pausedReason === 'quota-exceeded' || keyHealth === 'healthy'
          ? { pausedReason: null }
          : {}),
    });
    return {
      id,
      health: keyHealth,
      latencyMs: health.latencyMs,
      checkedAt: checkedAt.toISOString(),
      error: health.error === null ? null : redactText(health.error),
    };
  }

  public async checkAll(signal?: AbortSignal): Promise<HealthCheckResult[]> {
    if (this.#healthCheckRunning) return [];
    this.#healthCheckRunning = true;
    try {
      const results: HealthCheckResult[] = [];
      const enabledProviderIds = new Set(this.providers.list(true).map((provider) => provider.id));
      for (const key of this.keys
        .list()
        .filter((candidate) => candidate.enabled && enabledProviderIds.has(candidate.providerId))) {
        if (signal?.aborted === true) break;
        try {
          results.push(await this.check(key.id, signal));
        } catch {
          // 单个密钥失败不应中断整个健康检查批次。
        }
      }
      return results;
    } finally {
      this.#healthCheckRunning = false;
    }
  }

  public startHealthChecks(intervalMs = 60 * 60 * 1_000): () => void {
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 1_000 ||
      intervalMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new Error('健康检查间隔必须在 1 秒到 7 天之间');
    }
    const timer = setInterval(() => void this.checkAll(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
