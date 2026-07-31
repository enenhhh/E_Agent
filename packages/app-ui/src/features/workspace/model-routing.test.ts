import { describe, expect, it } from 'vitest';

import type { Model } from '../../types';

import { detectPromptScene, resolvePromptModel } from './model-routing';

function model(id: string, available = true): Model {
  return {
    id,
    remoteId: id,
    providerId: 'provider',
    providerName: 'Provider',
    provider: 'custom',
    displayName: id,
    contextWindow: 32_000,
    capabilities: ['chat'],
    available,
  };
}

describe('workspace model routing', () => {
  const models = [model('topbar'), model('code-default'), model('chat-default')];
  const defaultModels = {
    code: 'code-default',
    chat: 'chat-default',
    summarize: '',
  };

  it('普通对话和显式 @chat 使用聊天默认模型，@code 使用代码默认模型', () => {
    expect(
      resolvePromptModel({
        content: '解释这段代码',
        selectedModel: 'topbar',
        routingMode: 'automatic',
        defaultModels,
        models,
      }),
    ).toBe('chat-default');
    expect(
      resolvePromptModel({
        content: '@chat 解释这段代码',
        selectedModel: 'topbar',
        routingMode: 'automatic',
        defaultModels,
        models,
      }),
    ).toBe('chat-default');
    expect(
      resolvePromptModel({
        content: '  @code: 修复这个函数',
        selectedModel: 'topbar',
        routingMode: 'automatic',
        defaultModels,
        models,
      }),
    ).toBe('code-default');
  });

  it('显式顶部栏选择优先于场景默认模型', () => {
    expect(
      resolvePromptModel({
        content: '@code 修复这个函数',
        selectedModel: 'topbar',
        routingMode: 'explicit',
        defaultModels,
        models,
      }),
    ).toBe('topbar');
  });

  it('不把 Skill 命令误判为 @code，并在默认模型不可用时安全回退', () => {
    expect(detectPromptScene('@code-review 检查 PR')).toBe('chat');
    expect(
      resolvePromptModel({
        content: '@code-review 检查 PR',
        selectedModel: 'topbar',
        routingMode: 'automatic',
        defaultModels: { code: 'missing', chat: 'disabled' },
        models: [model('topbar'), model('disabled', false)],
      }),
    ).toBe('topbar');
  });
});
