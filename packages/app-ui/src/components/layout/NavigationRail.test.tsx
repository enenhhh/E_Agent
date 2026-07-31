import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../context/I18nContext';
import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import type { User } from '../../types';

import { NavigationRail } from './NavigationRail';

function user(role: User['role']): User {
  return {
    id: `user-${role}`,
    name: role,
    email: `${role}@example.test`,
    role,
    active: true,
  };
}

function renderNavigation(
  role: User['role'] | null,
  transport = {} as EAgentTransport,
  route = '/workspace',
): void {
  useAuthStore.setState({
    status: role ? 'authenticated' : 'unauthenticated',
    session: role
      ? {
          user: user(role),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      : null,
    error: null,
  });
  render(
    <TransportProvider mode="web" transport={transport}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>
          <NavigationRail />
        </MemoryRouter>
      </I18nProvider>
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('NavigationRail', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('e-agent-locale', 'zh-CN');
    useAuthStore.setState({ status: 'unauthenticated', session: null, error: null });
  });

  it.each(['owner', 'admin'] as const)('%s 可以看到团队与审计入口', (role) => {
    renderNavigation(role, {} as EAgentTransport, '/admin');

    const adminLink = screen.getByRole('link', { name: '团队' });
    expect(adminLink).toBeInTheDocument();
    expect(adminLink).toHaveClass('is-active');
  });

  it.each(['member', 'viewer'] as const)('%s 看不到团队与审计入口', (role) => {
    renderNavigation(role);

    expect(screen.queryByRole('link', { name: '团队' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '工作台' })).toHaveClass('is-active');
  });

  it('未登录时隐藏管理入口，并完整展示常用导航', () => {
    renderNavigation(null);

    expect(screen.getByRole('complementary', { name: '主导航' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '团队' })).not.toBeInTheDocument();
    for (const label of ['工作台', '模型', '密钥', '成本', 'Skills', '插件', '教程', '设置']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('跟随已保存语言显示英文导航', () => {
    window.localStorage.setItem('e-agent-locale', 'en-US');
    renderNavigation('member', {} as EAgentTransport, '/credentials');

    expect(screen.getByRole('link', { name: 'API keys' })).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tutorial' })).toBeInTheDocument();
  });

  it('退出登录会调用传输层并清空本地会话', async () => {
    const logout = vi.fn(async () => undefined);
    renderNavigation('owner', { logout } as unknown as EAgentTransport);

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(useAuthStore.getState()).toMatchObject({
      status: 'unauthenticated',
      session: null,
      error: null,
    });
  });
});
