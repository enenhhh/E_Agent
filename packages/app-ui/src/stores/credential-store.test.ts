import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialInput, EAgentTransport, ProviderInput } from '../lib/transport';
import type { Credential, ProviderConfig } from '../types';

import { useCredentialStore } from './credential-store';

const input: CredentialInput = {
  name: 'Primary',
  provider: 'OpenAI',
  apiKey: 'test-only',
  strategy: 'round-robin',
  priority: 1,
};

const providerInput: ProviderInput = {
  type: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  keyStrategy: 'round-robin',
};

const provider: ProviderConfig = {
  id: 'provider-openai',
  ...providerInput,
  enabled: true,
};

const primary: Credential = {
  id: 'key-primary',
  name: 'Primary',
  provider: 'openai',
  lastFour: '1234',
  status: 'healthy',
  strategy: 'round-robin',
  priority: 1,
  dailyUsed: 0,
  monthlyUsed: 0,
  quotaUnit: 'usd',
  proxyMode: 'direct',
  enabled: true,
};

const backup: Credential = {
  ...primary,
  id: 'key-backup',
  name: 'Backup',
  lastFour: '5678',
};

function resetStore(): void {
  useCredentialStore.setState({
    providers: [],
    credentials: [],
    loading: false,
    checking: false,
    error: null,
  });
}

describe('useCredentialStore', () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('加载成功，并在 Error 与未知异常时恢复 loading 和友好错误', async () => {
    await useCredentialStore.getState().load({
      listProviders: vi.fn(async () => [provider]),
      listCredentials: vi.fn(async () => [primary]),
    } as unknown as EAgentTransport);
    expect(useCredentialStore.getState()).toMatchObject({
      credentials: [primary],
      providers: [provider],
      loading: false,
      error: null,
    });

    await useCredentialStore.getState().load({
      listProviders: vi.fn(async () => [provider]),
      listCredentials: vi.fn(async () => {
        throw new Error('list unavailable');
      }),
    } as unknown as EAgentTransport);
    expect(useCredentialStore.getState().error).toBe('list unavailable');

    await useCredentialStore.getState().load({
      listProviders: vi.fn(async () => [provider]),
      listCredentials: vi.fn(async () => {
        throw 'offline';
      }),
    } as unknown as EAgentTransport);
    expect(useCredentialStore.getState()).toMatchObject({
      loading: false,
      error: '服务商与密钥列表加载失败。',
    });
  });

  it('同步创建、更新、删除、单 Key 检查和全部检查结果', async () => {
    const checkedPrimary = { ...primary, status: 'warning' as const };
    const transport = {
      createProvider: vi.fn(async () => provider),
      updateProvider: vi.fn(async () => ({ ...provider, name: 'OpenAI Edited' })),
      createCredential: vi.fn(async () => primary),
      updateCredential: vi.fn(async () => ({ ...primary, name: 'Updated' })),
      deleteCredential: vi.fn(async () => undefined),
      checkCredential: vi.fn(async () => checkedPrimary),
      checkAllCredentials: vi.fn(async () => [checkedPrimary]),
    } as unknown as EAgentTransport;
    useCredentialStore.setState({ providers: [], credentials: [backup] });

    await useCredentialStore.getState().createProvider(transport, providerInput);
    await useCredentialStore
      .getState()
      .updateProvider(transport, provider.id, { name: 'OpenAI Edited' });
    expect(useCredentialStore.getState().providers).toEqual([
      expect.objectContaining({ id: provider.id, name: 'OpenAI Edited' }),
    ]);
    await useCredentialStore.getState().create(transport, input);
    await useCredentialStore.getState().update(transport, primary.id, { name: 'Updated' });
    expect(useCredentialStore.getState().credentials).toEqual([
      backup,
      expect.objectContaining({ id: primary.id, name: 'Updated' }),
    ]);

    await useCredentialStore.getState().check(transport, primary.id);
    expect(useCredentialStore.getState()).toMatchObject({
      credentials: [backup, checkedPrimary],
      checking: false,
    });
    await useCredentialStore.getState().check(transport);
    expect(useCredentialStore.getState().credentials).toEqual([checkedPrimary]);

    useCredentialStore.setState({ credentials: [backup, checkedPrimary] });
    await useCredentialStore.getState().remove(transport, backup.id);
    expect(useCredentialStore.getState().credentials).toEqual([checkedPrimary]);
  });

  it.each([
    {
      name: 'createProvider',
      expectedFallback: '服务商添加失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().createProvider(transport, providerInput),
      transportMethod: 'createProvider',
    },
    {
      name: 'updateProvider',
      expectedFallback: '服务商保存失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().updateProvider(transport, provider.id, {
          name: 'Updated',
        }),
      transportMethod: 'updateProvider',
    },
    {
      name: 'create',
      expectedFallback: '密钥添加失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().create(transport, input),
      transportMethod: 'createCredential',
    },
    {
      name: 'update',
      expectedFallback: '密钥保存失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().update(transport, primary.id, { name: 'Updated' }),
      transportMethod: 'updateCredential',
    },
    {
      name: 'remove',
      expectedFallback: '密钥删除失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().remove(transport, primary.id),
      transportMethod: 'deleteCredential',
    },
    {
      name: 'check',
      expectedFallback: '健康检查失败。',
      invoke: (transport: EAgentTransport) =>
        useCredentialStore.getState().check(transport, primary.id),
      transportMethod: 'checkCredential',
    },
  ])(
    '$name 同时保留 Error 信息并为未知异常提供回退文案',
    async ({ expectedFallback, invoke, transportMethod }) => {
      const failure = new Error('operation unavailable');
      await expect(
        invoke({
          [transportMethod]: vi.fn(async () => {
            throw failure;
          }),
        } as unknown as EAgentTransport),
      ).rejects.toBe(failure);
      expect(useCredentialStore.getState().error).toBe('operation unavailable');

      await expect(
        invoke({
          [transportMethod]: vi.fn(async () => {
            throw null;
          }),
        } as unknown as EAgentTransport),
      ).rejects.toBeNull();
      expect(useCredentialStore.getState()).toMatchObject({
        checking: false,
        error: expectedFallback,
      });
    },
  );
});
