import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useExtensionStore } from '../../stores/extension-store';
import type { Plugin, User } from '../../types';

import { PluginsPage } from './PluginsPage';

const plugin: Plugin = {
  id: 'com.example.fixture',
  name: 'Fixture Plugin',
  description: '用于权限测试',
  version: '1.0.0',
  enabled: false,
  approved: false,
  source: 'local:fixture',
  types: ['tool'],
  permissions: ['network'],
  updateAvailable: '1.1.0',
};

function transport(): EAgentTransport {
  return {
    kind: 'desktop',
    listPlugins: vi.fn(async () => [plugin]),
    setPluginApproved: vi.fn(async (_id: string, approved: boolean) => ({
      ...plugin,
      approved,
    })),
    setPluginEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
      ...plugin,
      enabled,
    })),
    installPlugin: vi.fn(async () => plugin),
    uninstallPlugin: vi.fn(async () => undefined),
  } as unknown as EAgentTransport;
}

function setRole(role: User['role']): void {
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
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <TransportProvider mode="desktop" transport={transport()}>
      <PluginsPage />
    </TransportProvider>,
  );
}

describe('PluginsPage 角色权限', () => {
  beforeEach(() => {
    useExtensionStore.setState({ plugins: [], loading: false, error: null });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: 'idle', session: null, error: null });
  });

  it('Viewer 只能查看插件，不能安装、授权、启停、更新或卸载', async () => {
    setRole('viewer');
    renderPage();
    await screen.findByText('Fixture Plugin');

    expect(screen.getByRole('button', { name: '安装插件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '审查并授权' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /更新至 1\.1\.0/u })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '已停用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '卸载' })).toBeDisabled();
  });

  it('Owner 可以管理插件完整生命周期', async () => {
    setRole('owner');
    renderPage();
    await screen.findByText('Fixture Plugin');
    await waitFor(() => expect(screen.getByRole('button', { name: '安装插件' })).toBeEnabled());

    expect(screen.getByRole('button', { name: '审查并授权' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /更新至 1\.1\.0/u })).toBeEnabled();
    expect(screen.getByRole('button', { name: '卸载' })).toBeEnabled();
  });
});
