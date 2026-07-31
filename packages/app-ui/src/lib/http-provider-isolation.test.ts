import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpTransport } from './http-transport';
import type { CredentialInput } from './transport';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const existingCustomProvider = {
  id: 'provider-a',
  type: 'custom',
  name: 'Gateway A',
  baseUrl: 'https://gateway-a.example/v1',
  enabled: true,
  keyStrategy: 'round-robin' as const,
};

function key(providerId: string) {
  return {
    id: `key-${providerId}`,
    providerId,
    label: 'Production Key',
    maskedKey: 'sk-••••cdef',
    priority: 1,
    health: 'unknown',
    enabled: true,
    dailyLimit: null,
    monthlyLimit: null,
    quotaUnit: 'usd',
    todayUsed: 0,
    monthUsed: 0,
    proxyConfigured: false,
    lastCheckedAt: null,
  };
}

describe('HttpTransport provider isolation', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('不会因为 provider type 相同而把新兼容服务商复用到旧服务商', async () => {
    const createdProvider = {
      ...existingCustomProvider,
      id: 'provider-b',
      name: 'Gateway B',
      baseUrl: 'https://gateway-b.example/v1',
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/providers' && init?.method !== 'POST') {
        return jsonResponse({ providers: [existingCustomProvider] });
      }
      if (path === '/api/v1/providers' && init?.method === 'POST') {
        return jsonResponse(createdProvider, 201);
      }
      if (path === '/api/v1/keys' && init?.method === 'POST') {
        return jsonResponse(key(createdProvider.id), 201);
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const input: CredentialInput = {
      name: 'Production Key',
      provider: 'OpenAI Compatible',
      providerName: 'Gateway B',
      apiKey: 'sk-test-provider-isolation',
      baseUrl: createdProvider.baseUrl,
      strategy: 'round-robin',
      priority: 1,
    };
    const credential = await new HttpTransport('http://127.0.0.1:4318').createCredential(input);

    expect(credential).toMatchObject({
      providerId: 'provider-b',
      providerName: 'Gateway B',
      providerType: 'custom',
      provider: 'Gateway B',
    });
    const createProviderCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).pathname === '/api/v1/providers' && init?.method === 'POST',
    );
    expect(JSON.parse(String(createProviderCall?.[1]?.body))).toMatchObject({
      type: 'custom',
      name: 'Gateway B',
      baseUrl: createdProvider.baseUrl,
    });
    const createKeyCall = fetchMock.mock.calls.find(
      ([url, init]) => new URL(String(url)).pathname === '/api/v1/keys' && init?.method === 'POST',
    );
    expect(JSON.parse(String(createKeyCall?.[1]?.body))).toMatchObject({
      providerId: 'provider-b',
    });
  });

  it('旧表单名称与内置服务商冲突时生成独立名称，而不是复用并覆盖内置配置', async () => {
    const builtInProvider = {
      ...existingCustomProvider,
      id: 'provider-openai',
      type: 'openai',
      name: 'OpenAI Compatible',
      baseUrl: 'https://api.openai.com/v1',
    };
    let createdName = '';
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/providers' && init?.method !== 'POST') {
        return jsonResponse({ providers: [builtInProvider] });
      }
      if (path === '/api/v1/providers' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          type: string;
          name: string;
          baseUrl: string;
        };
        createdName = body.name;
        return jsonResponse(
          {
            ...builtInProvider,
            id: 'provider-custom',
            type: body.type,
            name: body.name,
            baseUrl: body.baseUrl,
          },
          201,
        );
      }
      if (path === '/api/v1/keys' && init?.method === 'POST') {
        return jsonResponse(key('provider-custom'), 201);
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await new HttpTransport('http://127.0.0.1:4318').createCredential({
      name: 'Legacy Form Key',
      provider: 'OpenAI Compatible',
      apiKey: 'sk-test-legacy-provider',
      baseUrl: 'https://gateway-b.example/v1',
      strategy: 'round-robin',
      priority: 1,
    });

    expect(createdName).toContain('gateway-b.example');
    expect(createdName).not.toBe(builtInProvider.name);
  });
});
