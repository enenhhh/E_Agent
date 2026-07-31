import { describe, expect, it, vi } from 'vitest';

import { discoverModels, discoverModelsForProviders, type FetchLike } from '../src/index.js';

function modelsResponse(id: string): Response {
  return Response.json({ data: [{ id }] });
}

describe('provider discovery', () => {
  it('returns discovered models with provider metadata', async () => {
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      return modelsResponse('gpt-4o');
    });

    const result = await discoverModels({
      id: 'provider-1',
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      proxyUrl: null,
      fetch,
    });

    expect(result).toMatchObject({
      providerId: 'provider-1',
      type: 'openai',
      error: null,
    });
    expect(result.discoveredAt).toBeInstanceOf(Date);
    expect(result.models.map((model) => model.id)).toEqual(['gpt-4o']);
  });

  it('returns an error result instead of rejecting', async () => {
    const result = await discoverModels({
      id: 'broken',
      type: 'custom',
      baseUrl: 'not a URL',
    });

    expect(result.models).toEqual([]);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('preserves input ordering under bounded concurrent discovery', async () => {
    let active = 0;
    let peak = 0;
    const providers = ['first', 'second', 'third', 'fourth'].map((id, index) => ({
      id,
      type: 'custom' as const,
      baseUrl: `https://${id}.test/v1`,
      fetch: vi.fn<FetchLike>(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 4 - index));
        active -= 1;
        return modelsResponse(`${id}-model`);
      }),
    }));

    const results = await discoverModelsForProviders(providers, { concurrency: 2 });

    expect(peak).toBe(2);
    expect(results.map((result) => result.providerId)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(results.map((result) => result.models[0]?.id)).toEqual([
      'first-model',
      'second-model',
      'third-model',
      'fourth-model',
    ]);
  });

  it('handles an empty provider collection', async () => {
    await expect(discoverModelsForProviders([], { concurrency: 0 })).resolves.toEqual([]);
  });
});
