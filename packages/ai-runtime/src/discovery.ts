import type { ProviderType } from '@e-agent/contracts';

import { OpenAICompatibleClient, type FetchLike } from './client.js';
import type { RuntimeModel } from './types.js';

export interface ProviderDiscoveryConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  proxyUrl?: string | null;
  fetch?: FetchLike;
}

export interface ProviderDiscoveryResult {
  providerId: string;
  type: ProviderType;
  models: RuntimeModel[];
  discoveredAt: Date;
  error: Error | null;
}

/** 发现单个 OpenAI-compatible 提供商的模型。 */
export async function discoverModels(
  provider: ProviderDiscoveryConfig,
  signal?: AbortSignal,
): Promise<ProviderDiscoveryResult> {
  let client: OpenAICompatibleClient | undefined;
  try {
    client = new OpenAICompatibleClient({
      baseUrl: provider.baseUrl,
      ...(provider.type === 'ollama' ? { allowInsecureLoopback: true } : {}),
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      ...(provider.proxyUrl === undefined ? {} : { proxyUrl: provider.proxyUrl }),
      ...(provider.fetch === undefined ? {} : { fetch: provider.fetch }),
      maxAttempts: 2,
      timeoutMs: 30_000,
    });
    return {
      providerId: provider.id,
      type: provider.type,
      models: await client.listModels(signal),
      discoveredAt: new Date(),
      error: null,
    };
  } catch (error) {
    return {
      providerId: provider.id,
      type: provider.type,
      models: [],
      discoveredAt: new Date(),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

/** 以有限并发发现多个提供商，避免启动时放大网络压力。 */
export async function discoverModelsForProviders(
  providers: readonly ProviderDiscoveryConfig[],
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<ProviderDiscoveryResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, providers.length || 1));
  const results = new Array<ProviderDiscoveryResult>(providers.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < providers.length) {
        const index = nextIndex;
        nextIndex += 1;
        const provider = providers[index];
        if (provider !== undefined) results[index] = await discoverModels(provider, options.signal);
      }
    }),
  );
  return results;
}
