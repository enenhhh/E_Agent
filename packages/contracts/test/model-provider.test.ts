import { describe, expect, it } from 'vitest';

import { modelSchema } from '../src/models.js';

function modelRecord() {
  return {
    id: crypto.randomUUID(),
    providerId: crypto.randomUUID(),
    provider: 'custom',
    providerName: 'Gateway A',
    remoteId: 'shared-model',
    displayName: 'Shared Model',
    capabilities: ['chat', 'code'],
    contextWindow: 32_000,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    enabled: true,
    discoveredAt: new Date().toISOString(),
    metadata: {},
  };
}

describe('model provider identity', () => {
  it('同时保留 providerId、服务商名称和协议类型', () => {
    expect(modelSchema.parse(modelRecord())).toMatchObject({
      provider: 'custom',
      providerName: 'Gateway A',
      remoteId: 'shared-model',
    });
  });

  it('拒绝缺少服务商显示名称的模型响应', () => {
    const { providerName: _providerName, ...withoutProviderName } = modelRecord();
    expect(() => modelSchema.parse(withoutProviderName)).toThrow();
  });
});
