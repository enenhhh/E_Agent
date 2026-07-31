import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EAgentTransport } from '../lib/transport';
import type { Model } from '../types';

import { modelProviderId, modelProviderName, useModelStore } from './model-store';

function model(id: string, providerId: string, providerName: string, available = true): Model {
  return {
    id,
    remoteId: id,
    providerId,
    providerName,
    provider: 'custom',
    displayName: id.toUpperCase(),
    contextWindow: 32_000,
    capabilities: ['chat', 'code'],
    available,
  };
}

function transportWith(models: Model[]): EAgentTransport {
  return {
    listModels: vi.fn().mockResolvedValue(models),
    discoverModels: vi.fn().mockResolvedValue(models),
    updateProviderModelSelection: vi.fn().mockResolvedValue(models),
  } as unknown as EAgentTransport;
}

function resetStore(): void {
  useModelStore.setState({
    models: [],
    modelsForSelectedProvider: [],
    selectedProviderId: '',
    selectedModel: '',
    selectedModelByProvider: {},
    routingMode: 'automatic',
    compareModels: [],
    loading: false,
    discovering: false,
    selectionSavingProviderId: null,
    error: null,
  });
}

describe('useModelStore provider selection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只暴露当前服务商模型，并分别记住每个服务商的最近选择', async () => {
    const models = [
      model('a-1', 'provider-a', 'Gateway A'),
      model('a-2', 'provider-a', 'Gateway A'),
      model('b-1', 'provider-b', 'Gateway B'),
      model('b-disabled', 'provider-b', 'Gateway B', false),
    ];

    await useModelStore.getState().load(transportWith(models));
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-a',
      selectedModel: 'a-1',
      routingMode: 'automatic',
    });
    expect(
      useModelStore.getState().modelsForSelectedProvider.map((candidate) => candidate.id),
    ).toEqual(['a-1', 'a-2']);

    useModelStore.getState().select('a-2');
    expect(useModelStore.getState().routingMode).toBe('explicit');
    useModelStore.getState().selectProvider('provider-b');
    expect(useModelStore.getState().selectedModel).toBe('b-1');

    useModelStore.getState().selectProvider('provider-a');
    expect(useModelStore.getState().selectedModel).toBe('a-2');
    expect(useModelStore.getState().selectedModelByProvider).toEqual({
      'provider-a': 'a-2',
      'provider-b': 'b-1',
    });
    expect(
      JSON.parse(window.localStorage.getItem('e-agent-model-selection-v1') ?? '{}'),
    ).toMatchObject({
      selectedProviderId: 'provider-a',
      selectedModelByProvider: {
        'provider-a': 'a-2',
        'provider-b': 'b-1',
      },
      routingMode: 'explicit',
    });

    useModelStore.getState().enableAutomaticRouting();
    expect(useModelStore.getState().routingMode).toBe('automatic');
    expect(
      JSON.parse(window.localStorage.getItem('e-agent-model-selection-v1') ?? '{}'),
    ).toMatchObject({ routingMode: 'automatic' });
  });

  it('保留嵌入模型供管理页展示，但不把嵌入专用模型加入聊天选择器', async () => {
    const embeddingOnly: Model = {
      ...model('embedding-1', 'provider-embedding', 'Embedding Gateway'),
      capabilities: ['embedding'],
    };
    const chat = model('chat-1', 'provider-chat', 'Chat Gateway');

    await useModelStore.getState().load(transportWith([embeddingOnly, chat]));

    expect(useModelStore.getState().models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'embedding-1' })]),
    );
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-chat',
      selectedModel: 'chat-1',
    });
    useModelStore.getState().select('embedding-1');
    useModelStore.getState().selectProvider('provider-embedding');
    useModelStore.getState().toggleCompare('embedding-1');
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-chat',
      selectedModel: 'chat-1',
      compareModels: [],
    });
  });

  it('刷新后清理不存在或不可用的记忆，并安全回退到同服务商可用模型', async () => {
    useModelStore.setState({
      selectedProviderId: 'provider-a',
      selectedModel: 'removed-model',
      selectedModelByProvider: {
        'provider-a': 'removed-model',
        'provider-b': 'b-disabled',
      },
      compareModels: ['removed-model', 'b-disabled'],
    });

    await useModelStore
      .getState()
      .load(
        transportWith([
          model('a-disabled', 'provider-a', 'Gateway A', false),
          model('a-live', 'provider-a', 'Gateway A'),
          model('b-disabled', 'provider-b', 'Gateway B', false),
        ]),
      );

    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-a',
      selectedModel: 'a-live',
      selectedModelByProvider: { 'provider-a': 'a-live' },
      compareModels: [],
    });
  });

  it('当前服务商全部停用时自动切换到仍有可用模型的服务商', async () => {
    useModelStore.setState({
      selectedProviderId: 'provider-a',
      selectedModel: 'a-live',
      selectedModelByProvider: { 'provider-a': 'a-live', 'provider-b': 'b-live' },
      routingMode: 'explicit',
    });

    await useModelStore
      .getState()
      .load(
        transportWith([
          model('a-live', 'provider-a', 'Gateway A', false),
          model('b-live', 'provider-b', 'Gateway B'),
        ]),
      );

    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-b',
      selectedModel: 'b-live',
      modelsForSelectedProvider: [expect.objectContaining({ id: 'b-live' })],
    });
  });

  it('同一 remoteId 位于不同 providerId 时仍保持两个独立选项', async () => {
    const first = model('model-a', 'provider-a', 'Gateway A');
    const second = {
      ...model('model-b', 'provider-b', 'Gateway B'),
      remoteId: first.remoteId,
    };

    await useModelStore.getState().discover(transportWith([first, second]));
    useModelStore.getState().selectProvider('provider-b');

    expect(useModelStore.getState().modelsForSelectedProvider).toEqual([
      expect.objectContaining({ id: 'model-b', providerId: 'provider-b' }),
    ]);
    expect(useModelStore.getState().selectedModel).toBe('model-b');
  });

  it('兼容旧服务商身份并安全处理加载与发现错误', async () => {
    const legacy = {
      ...model('legacy-model', 'ignored', 'ignored'),
      provider: 'openai' as const,
      providerId: '   ',
      providerName: '  ',
    };
    expect(modelProviderId(legacy)).toBe('legacy:openai');
    expect(modelProviderName(legacy)).toBe('openai');

    await useModelStore.getState().load({
      listModels: vi.fn().mockRejectedValue(new Error('模型服务离线')),
    } as unknown as EAgentTransport);
    expect(useModelStore.getState()).toMatchObject({
      loading: false,
      error: '模型服务离线',
    });

    await expect(
      useModelStore.getState().discover({
        discoverModels: vi.fn().mockRejectedValue('offline'),
      } as unknown as EAgentTransport),
    ).rejects.toBe('offline');
    expect(useModelStore.getState()).toMatchObject({
      discovering: false,
      error: '模型发现失败。',
    });

    await useModelStore.getState().load({
      listModels: vi.fn().mockRejectedValue('offline'),
    } as unknown as EAgentTransport);
    expect(useModelStore.getState().error).toBe('模型列表加载失败。');

    await expect(
      useModelStore.getState().discover({
        discoverModels: vi.fn().mockRejectedValue(new Error('发现服务离线')),
      } as unknown as EAgentTransport),
    ).rejects.toThrow('发现服务离线');
    expect(useModelStore.getState().error).toBe('发现服务离线');
  });

  it('拒绝不可用选择、限制四模型对比并支持移除对比项', async () => {
    const models = [
      model('a-1', 'provider-a', 'Gateway A'),
      model('a-disabled', 'provider-a', 'Gateway A', false),
      model('b-1', 'provider-b', 'Gateway B'),
      model('c-1', 'provider-c', 'Gateway C'),
      model('d-1', 'provider-d', 'Gateway D'),
      model('e-1', 'provider-e', 'Gateway E'),
    ];
    await useModelStore.getState().load(transportWith(models));

    useModelStore.getState().selectProvider('missing-provider');
    useModelStore.getState().select('a-disabled');
    useModelStore.getState().select('missing-model');
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-a',
      selectedModel: 'a-1',
    });

    useModelStore.getState().toggleCompare('a-disabled');
    for (const modelId of ['a-1', 'b-1', 'c-1', 'd-1', 'e-1']) {
      useModelStore.getState().toggleCompare(modelId);
    }
    expect(useModelStore.getState().compareModels).toEqual(['a-1', 'b-1', 'c-1', 'd-1']);

    useModelStore.getState().toggleCompare('b-1');
    expect(useModelStore.getState().compareModels).toEqual(['a-1', 'c-1', 'd-1']);
  });

  it('没有可用模型时不向路由暴露服务商或伪造模型选择', async () => {
    await useModelStore
      .getState()
      .load(
        transportWith([
          model('disabled-a', 'provider-a', 'Gateway A', false),
          model('disabled-b', 'provider-b', 'Gateway B', false),
        ]),
      );

    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: '',
      selectedModel: '',
      selectedModelByProvider: {},
      routingMode: 'automatic',
    });

    useModelStore.getState().selectProvider('provider-b');
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: '',
      selectedModel: '',
      selectedModelByProvider: {},
      routingMode: 'automatic',
    });
  });

  it('保存服务商启用模型后使用服务端返回结果重新协调路由', async () => {
    const before = [
      model('a-1', 'provider-a', 'Gateway A'),
      model('a-2', 'provider-a', 'Gateway A'),
      model('b-1', 'provider-b', 'Gateway B'),
    ];
    const after = [
      model('a-1', 'provider-a', 'Gateway A', false),
      model('a-2', 'provider-a', 'Gateway A', false),
      model('b-1', 'provider-b', 'Gateway B'),
    ];
    const transport = transportWith(before);
    vi.mocked(transport.updateProviderModelSelection).mockResolvedValue(after);
    await useModelStore.getState().load(transport);

    await useModelStore.getState().updateProviderSelection(transport, 'provider-a', []);

    expect(transport.updateProviderModelSelection).toHaveBeenCalledWith('provider-a', []);
    expect(useModelStore.getState()).toMatchObject({
      selectionSavingProviderId: null,
      selectedProviderId: 'provider-b',
      selectedModel: 'b-1',
    });
  });

  it('本地选择状态写入失败不会阻断当前会话', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await expect(
      useModelStore.getState().load(transportWith([model('a-1', 'provider-a', 'Gateway A')])),
    ).resolves.toBeUndefined();
    useModelStore.getState().select('a-1');

    expect(setItem).toHaveBeenCalled();
    expect(useModelStore.getState().selectedModel).toBe('a-1');
  });

  it('协调时优先保留有效的显式模型记忆和当前模型服务商', async () => {
    useModelStore.setState({
      selectedProviderId: 'missing-provider',
      selectedModel: 'b-1',
      selectedModelByProvider: { 'provider-a': 'a-2' },
      routingMode: 'explicit',
    });

    await useModelStore
      .getState()
      .load(
        transportWith([
          model('a-1', 'provider-a', 'Gateway A'),
          model('a-2', 'provider-a', 'Gateway A'),
          model('b-1', 'provider-b', 'Gateway B'),
        ]),
      );

    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-b',
      selectedModel: 'b-1',
      selectedModelByProvider: {
        'provider-a': 'a-2',
        'provider-b': 'b-1',
      },
      routingMode: 'explicit',
    });

    await useModelStore.getState().load(transportWith([]));
    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: '',
      selectedModel: '',
      selectedModelByProvider: {},
      routingMode: 'automatic',
    });
  });

  it('从合法缓存恢复服务商记忆并过滤异常条目', async () => {
    const longKey = 'p'.repeat(257);
    window.localStorage.setItem(
      'e-agent-model-selection-v1',
      JSON.stringify({
        version: 1,
        selectedProviderId: 'provider-a',
        selectedModelByProvider: {
          'provider-a': 'a-2',
          '': 'empty-provider',
          'provider-empty-model': '',
          [longKey]: 'too-long-provider',
          'provider-long-model': 'm'.repeat(257),
        },
        routingMode: 'explicit',
      }),
    );
    vi.resetModules();

    const freshModule = await import('./model-store');
    expect(freshModule.useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-a',
      selectedModelByProvider: { 'provider-a': 'a-2' },
      routingMode: 'explicit',
    });
  });

  it.each([
    JSON.stringify({
      version: 2,
      selectedProviderId: '',
      selectedModelByProvider: {},
    }),
    JSON.stringify({
      version: 1,
      selectedProviderId: 42,
      selectedModelByProvider: {},
    }),
    JSON.stringify({
      version: 1,
      selectedProviderId: 'p'.repeat(257),
      selectedModelByProvider: {},
    }),
    JSON.stringify({
      version: 1,
      selectedProviderId: '',
      selectedModelByProvider: null,
    }),
    'x'.repeat(65_537),
    '{invalid-json',
  ])('忽略损坏或超限的选择缓存 %#', async (cachedValue) => {
    window.localStorage.setItem('e-agent-model-selection-v1', cachedValue);
    vi.resetModules();

    const freshModule = await import('./model-store');
    expect(freshModule.useModelStore.getState()).toMatchObject({
      selectedProviderId: '',
      selectedModelByProvider: {},
      routingMode: 'automatic',
    });
  });
});
