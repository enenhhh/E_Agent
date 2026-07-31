import { describe, expect, it } from 'vitest';

import { inferContextWindow, inferModelCapabilities, normalizeProviderType } from '../src/index.js';

describe('model capability inference', () => {
  it.each([
    ['text-embedding-3-small', {}, ['embedding']],
    ['vendor-model', { type: 'EMBEDDING' }, ['embedding']],
    ['deepseek-r1-vision', {}, ['chat', 'code', 'vision', 'function-calling', 'reasoning']],
    ['plain-instruct-only', {}, ['chat']],
    ['gpt-4o', {}, ['chat', 'vision', 'function-calling']],
    ['thinking-codex', {}, ['chat', 'code', 'function-calling', 'reasoning']],
  ])('infers %s', (modelId, metadata, expected) => {
    expect(inferModelCapabilities(modelId, metadata)).toEqual(expected);
  });

  it.each([
    ['custom', { context_window: 4096 }, 4096],
    ['custom', { context_length: 8192 }, 8192],
    ['custom', { max_model_len: 16384 }, 16384],
    ['gpt-3.5-turbo', {}, 16_385],
    ['claude-4-sonnet', {}, 200_000],
    ['gemini-2-flash', {}, 1_000_000],
    ['llama-3.2', {}, 128_000],
    ['unknown', { context_window: -1 }, null],
  ])('infers context for %s', (modelId, metadata, expected) => {
    expect(inferContextWindow(modelId, metadata)).toBe(expected);
  });

  it.each(['openai', 'Anthropic', 'DEEPSEEK', 'groq', 'Google', 'ollama'] as const)(
    'normalizes known provider %s',
    (provider) => {
      expect(normalizeProviderType(provider)).toBe(provider.toLowerCase());
    },
  );

  it('maps unknown providers to custom', () => {
    expect(normalizeProviderType('AcmeAI')).toBe('custom');
  });
});
