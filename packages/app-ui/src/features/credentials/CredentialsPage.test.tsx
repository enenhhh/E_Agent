import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useCredentialStore } from '../../stores/credential-store';
import { useToastStore } from '../../stores/toast-store';
import type { Credential, ProviderConfig, User } from '../../types';

import { CredentialsPage } from './CredentialsPage';

const provider: ProviderConfig = {
  id: 'provider-1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
  keyStrategy: 'round-robin',
};

const credential: Credential = {
  id: 'credential-1',
  name: 'Production gateway',
  providerId: provider.id,
  providerName: provider.name,
  providerType: provider.type,
  provider: provider.name,
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

function createTransport() {
  const checkAllCredentials = vi.fn(async () => [credential]);
  const transport = {
    listProviders: vi.fn(async () => [provider]),
    createProvider: vi.fn(async () => provider),
    updateProvider: vi.fn(async () => provider),
    listCredentials: vi.fn(async () => [credential]),
    checkAllCredentials,
    checkCredential: vi.fn(async () => credential),
    createCredential: vi.fn(async () => credential),
    updateCredential: vi.fn(async () => credential),
    deleteCredential: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    discoverModels: vi.fn(async () => []),
  };
  return transport as unknown as typeof transport & EAgentTransport;
}

function renderPage(role: User['role'], transport: EAgentTransport): void {
  useAuthStore.setState({
    status: 'authenticated',
    session: {
      user: {
        id: `${role}-1`,
        name: role,
        email: `${role}@example.com`,
        role,
        active: true,
      },
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    error: null,
  });
  render(
    <TransportProvider mode="desktop" transport={transport}>
      <CredentialsPage />
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('CredentialsPage', () => {
  beforeEach(() => {
    useCredentialStore.setState({
      providers: [],
      credentials: [],
      loading: false,
      checking: false,
      error: null,
    });
    useToastStore.setState({ messages: [] });
  });

  it.each([
    ['owner', true, true],
    ['admin', false, true],
    ['member', false, false],
    ['viewer', false, false],
  ] as const)('%s 的服务商、Key 与健康检查控件遵循角色权限', async (role, canManage, canCheck) => {
    const transport = createTransport();
    renderPage(role, transport);

    expect(await screen.findByText(credential.name)).toBeInTheDocument();
    const addProviderButton = screen.getByRole('button', { name: /添加服务商/ });
    const addKeyButton = screen.getByRole('button', { name: /添加 Key/ });
    const checkButton = screen.getByRole('button', { name: /健康检查/ });
    expect(addProviderButton).toHaveProperty('disabled', !canManage);
    expect(addKeyButton).toHaveProperty('disabled', !canManage);
    expect(checkButton).toHaveProperty('disabled', !canCheck);

    if (canCheck) {
      fireEvent.click(checkButton);
      await waitFor(() => expect(transport.checkAllCredentials).toHaveBeenCalledOnce());
    } else {
      fireEvent.click(checkButton);
      expect(transport.checkAllCredentials).not.toHaveBeenCalled();
    }

    fireEvent.click(screen.getByText(credential.name));
    expect(screen.getByRole('button', { name: '编辑' })).toHaveProperty('disabled', !canManage);
    expect(screen.getByRole('button', { name: /暂停密钥/ })).toHaveProperty('disabled', !canManage);
    expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', !canManage);
  });

  it('Owner 可编辑服务商、在其下新增 Key，并安全编辑已有 Key', async () => {
    const transport = createTransport();
    renderPage('owner', transport);
    await screen.findByText(credential.name);

    fireEvent.click(screen.getByRole('button', { name: '编辑服务商' }));
    const providerDialog = screen.getByRole('dialog');
    fireEvent.change(within(providerDialog).getByRole('textbox', { name: '服务商名称' }), {
      target: { value: 'Gateway Updated' },
    });
    fireEvent.click(within(providerDialog).getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(transport.updateProvider).toHaveBeenCalledWith(
        provider.id,
        expect.objectContaining({ name: 'Gateway Updated' }),
      );
      expect(transport.listModels).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: '添加 Key' }));
    const addKeyDialog = screen.getByRole('dialog');
    fireEvent.change(within(addKeyDialog).getByRole('textbox', { name: 'Key 名称' }), {
      target: { value: 'Backup' },
    });
    fireEvent.change(within(addKeyDialog).getByLabelText('API Key'), {
      target: { value: 'sk-backup-secret' },
    });
    fireEvent.click(within(addKeyDialog).getByRole('button', { name: '加密并保存' }));
    await waitFor(() => {
      expect(transport.createCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: provider.id,
          provider: provider.name,
          apiKey: 'sk-backup-secret',
        }),
      );
    });

    fireEvent.click(screen.getAllByText(credential.name)[0]!);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editKeyDialog = screen.getByRole('dialog');
    expect(within(editKeyDialog).getByLabelText('新 API Key（可选）')).toHaveValue('');
    fireEvent.click(within(editKeyDialog).getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(transport.updateCredential).toHaveBeenCalledWith(
        credential.id,
        expect.not.objectContaining({
          apiKey: expect.anything(),
          providerId: expect.anything(),
          proxyUrl: expect.anything(),
        }),
      );
    });
  });
});
