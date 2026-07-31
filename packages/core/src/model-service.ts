import { discoverModels } from '@e-agent/ai-runtime';
import type { ModelListResponse } from '@e-agent/contracts';
import type { AuditRepository, ModelsRepository, ProvidersRepository } from '@e-agent/database';

import { DomainError, assertFound } from './errors.js';
import type { KeyPool } from './key-pool.js';
import { mapModel } from './mappers.js';

function safePrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

export interface DiscoveryProviderResult {
  providerId: string;
  discovered: number;
  error: string | null;
}

/** 模型缓存、解析与启动发现服务。 */
export class ModelService {
  public constructor(
    private readonly providers: ProvidersRepository,
    private readonly models: ModelsRepository,
    private readonly keyPool: KeyPool,
    private readonly audit?: AuditRepository,
  ) {}

  public list(providerId?: string): ModelListResponse {
    const providers = new Map(this.providers.list().map((provider) => [provider.id, provider]));
    const rows = this.models.list(providerId);
    const discoveredTimes = rows.map((row) => row.discoveredAt.getTime());
    return {
      models: rows.flatMap((row) => {
        const provider = providers.get(row.providerId);
        return provider === undefined ? [] : [mapModel(row, provider)];
      }),
      cachedAt:
        discoveredTimes.length === 0 ? null : new Date(Math.max(...discoveredTimes)).toISOString(),
    };
  }

  public get(id: string) {
    const row = assertFound(this.models.get(id), '模型不存在');
    const provider = assertFound(this.providers.get(row.providerId), '模型提供商不存在');
    if (!provider.enabled) {
      throw new DomainError('BAD_REQUEST', '模型提供商已停用，请先启用服务商');
    }
    if (!row.enabled) {
      throw new DomainError('BAD_REQUEST', '模型已停用，请先在服务商模型配置中启用');
    }
    if (row.stale) {
      throw new DomainError('BAD_REQUEST', '模型已不在服务商最新模型列表中，请重新发现模型');
    }
    return mapModel(row, provider);
  }

  public updateEnabledSelection(
    providerId: string,
    enabledModelIds: readonly string[],
    actorId: string | null = null,
  ): ModelListResponse {
    assertFound(this.providers.get(providerId), '提供商不存在');
    const providerModels = this.models.list(providerId);
    const providerModelIds = new Set(providerModels.map((model) => model.id));
    const unknownModelIds = enabledModelIds.filter((modelId) => !providerModelIds.has(modelId));
    if (unknownModelIds.length > 0) {
      throw new DomainError('BAD_REQUEST', '启用模型列表包含不属于该服务商的模型');
    }
    this.models.setEnabledSelection(providerId, enabledModelIds);
    this.audit?.record({
      actorId,
      action: 'provider.models.update',
      targetType: 'provider',
      targetId: providerId,
      metadata: {
        enabledModelCount: enabledModelIds.length,
        totalModelCount: providerModels.length,
      },
    });
    return this.list(providerId);
  }

  public invalidateProvider(providerId: string): void {
    assertFound(this.providers.get(providerId), '提供商不存在');
    this.models.markProviderStale(providerId);
  }

  public async discover(
    providerId?: string,
    signal?: AbortSignal,
  ): Promise<DiscoveryProviderResult[]> {
    const candidates =
      providerId === undefined
        ? this.providers.list(true)
        : [assertFound(this.providers.get(providerId), '提供商不存在')];
    const results: DiscoveryProviderResult[] = [];
    for (const provider of candidates) {
      let credentials: { apiKey?: string; proxyUrl?: string | null } = {};
      if (provider.type !== 'ollama') {
        try {
          const selected = this.keyPool.select(provider.id);
          credentials = {
            ...(selected.apiKey === undefined ? {} : { apiKey: selected.apiKey }),
            proxyUrl: selected.proxyUrl,
          };
        } catch (error) {
          results.push({
            providerId: provider.id,
            discovered: 0,
            error: error instanceof Error ? error.message : '没有可用 API Key',
          });
          continue;
        }
      }
      const result = await discoverModels(
        {
          id: provider.id,
          type: provider.type,
          baseUrl: provider.baseUrl,
          ...credentials,
        },
        signal,
      );
      if (result.error !== null) {
        results.push({ providerId: provider.id, discovered: 0, error: result.error.message });
        continue;
      }
      for (const model of result.models) {
        const metadata = model.metadata;
        const inputPrice = safePrice(metadata['input_price_per_million']);
        const outputPrice = safePrice(metadata['output_price_per_million']);
        this.models.upsert({
          providerId: provider.id,
          remoteId: model.id,
          displayName: model.displayName,
          capabilitiesJson: JSON.stringify(model.capabilities),
          contextWindow: model.contextWindow,
          inputPricePerMillion: inputPrice,
          outputPricePerMillion: outputPrice,
          metadataJson: JSON.stringify(metadata),
          discoveredAt: result.discoveredAt,
        });
      }
      this.models.reconcileDiscovery(
        provider.id,
        result.models.map((model) => model.id),
      );
      results.push({ providerId: provider.id, discovered: result.models.length, error: null });
    }
    return results;
  }

  public resolve(input: { modelId?: string; providerId?: string; remoteModel?: string }) {
    if (input.modelId !== undefined) return this.get(input.modelId);
    if (input.providerId !== undefined && input.remoteModel !== undefined) {
      const row = this.models.findByRemoteId(input.providerId, input.remoteModel);
      if (row !== undefined) {
        const provider = assertFound(this.providers.get(row.providerId), '模型提供商不存在');
        if (!provider.enabled) {
          throw new DomainError('BAD_REQUEST', '模型提供商已停用，请先启用服务商');
        }
        if (!row.enabled) {
          throw new DomainError('BAD_REQUEST', '模型已停用，请先在服务商模型配置中启用');
        }
        if (row.stale) {
          throw new DomainError('BAD_REQUEST', '模型已不在服务商最新模型列表中，请重新发现模型');
        }
        return mapModel(row, provider);
      }
      throw new DomainError('NOT_FOUND', '指定模型尚未发现，请先刷新模型列表');
    }
    throw new DomainError('BAD_REQUEST', '必须指定 modelId，或同时指定 providerId 与 model');
  }
}
