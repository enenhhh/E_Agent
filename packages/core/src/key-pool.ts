import type { KeyStrategy } from '@e-agent/contracts';
import type {
  ApiKeyRow,
  ApiKeysRepository,
  ProviderRow,
  ProvidersRepository,
} from '@e-agent/database';
import { decryptSecret, type MasterKey } from '@e-agent/security';

import { DomainError } from './errors.js';

export interface SelectedApiKey {
  keyId: string | null;
  provider: ProviderRow;
  apiKey: string | undefined;
  proxyUrl: string | null;
}

function resetPeriods(repository: ApiKeysRepository, key: ApiKeyRow, at: Date): ApiKeyRow {
  const day = at.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const patch: Parameters<ApiKeysRepository['update']>[1] = {};
  if (key.usageDay !== day) {
    patch.usageDay = day;
    patch.todayUsed = 0;
  }
  if (key.usageMonth !== month) {
    patch.usageMonth = month;
    patch.monthUsed = 0;
  }
  return Object.keys(patch).length === 0 ? key : (repository.update(key.id, patch) ?? key);
}

function available(key: ApiKeyRow): boolean {
  if (!key.enabled || key.health === 'unhealthy' || key.health === 'paused') return false;
  if (key.dailyLimit !== null && key.todayUsed >= key.dailyLimit) return false;
  if (key.monthlyLimit !== null && key.monthUsed >= key.monthlyLimit) return false;
  return true;
}

function safeUsage(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sortCandidates(keys: ApiKeyRow[], strategy: KeyStrategy): ApiKeyRow[] {
  return [...keys].sort((left, right) => {
    if (strategy === 'priority' && left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    const leftTime = left.lastSelectedAt?.getTime() ?? 0;
    const rightTime = right.lastSelectedAt?.getTime() ?? 0;
    return (
      leftTime - rightTime ||
      left.priority - right.priority ||
      left.createdAt.getTime() - right.createdAt.getTime()
    );
  });
}

/** Key 池选择器，支持轮询、主备与日/月额度自动暂停。 */
export class KeyPool {
  public constructor(
    private readonly providers: ProvidersRepository,
    private readonly keys: ApiKeysRepository,
    private readonly masterKey: MasterKey,
  ) {}

  public select(providerId: string, at = new Date()): SelectedApiKey {
    const provider = this.providers.get(providerId);
    if (provider === undefined || !provider.enabled) {
      throw new DomainError('NOT_FOUND', '模型提供商不存在或已停用');
    }
    const normalized = this.keys.list(providerId).map((key) => resetPeriods(this.keys, key, at));
    for (const key of normalized) {
      if (
        (key.dailyLimit !== null && key.todayUsed >= key.dailyLimit) ||
        (key.monthlyLimit !== null && key.monthUsed >= key.monthlyLimit)
      ) {
        this.keys.update(key.id, {
          health: 'paused',
          pausedReason: 'quota-exceeded',
        });
      }
    }
    const selected = sortCandidates(normalized.filter(available), provider.keyStrategy)[0];
    if (selected === undefined && provider.type === 'ollama') {
      return { keyId: null, provider, apiKey: undefined, proxyUrl: null };
    }
    if (selected === undefined) {
      throw new DomainError('QUOTA_EXCEEDED', '该提供商没有可用 API Key', {
        retryable: false,
        details: { providerId },
      });
    }
    this.keys.update(selected.id, { lastSelectedAt: at });
    return {
      keyId: selected.id,
      provider,
      apiKey: decryptSecret(
        selected.encryptedSecret,
        this.masterKey,
        `provider:${provider.id}:api-key`,
      ),
      proxyUrl:
        selected.encryptedProxyUrl === null
          ? null
          : decryptSecret(
              selected.encryptedProxyUrl,
              this.masterKey,
              `provider:${provider.id}:proxy`,
            ),
    };
  }

  public recordUsage(keyId: string | null, usd: number, tokens: number, at = new Date()): void {
    if (keyId === null) return;
    const updated = this.keys.addUsage(keyId, safeUsage(usd), Math.trunc(safeUsage(tokens)), at);
    if (updated === undefined) return;
    if (
      (updated.dailyLimit !== null && updated.todayUsed >= updated.dailyLimit) ||
      (updated.monthlyLimit !== null && updated.monthUsed >= updated.monthlyLimit)
    ) {
      this.keys.update(keyId, { health: 'paused', pausedReason: 'quota-exceeded' });
    }
  }
}
