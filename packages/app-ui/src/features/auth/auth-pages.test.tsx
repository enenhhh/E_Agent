import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import type { SessionInfo } from '../../types';

import { AuthGate } from './AuthGate';
import { LoginPage } from './LoginPage';
import { SetupPage } from './SetupPage';

const session = {
  user: {
    id: 'owner-1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    active: true,
  },
} as SessionInfo;

const originalActions = {
  bootstrap: useAuthStore.getState().bootstrap,
  login: useAuthStore.getState().login,
  setup: useAuthStore.getState().setup,
  logout: useAuthStore.getState().logout,
  clearError: useAuthStore.getState().clearError,
};

function resetAuth(): void {
  useAuthStore.setState({
    status: 'unauthenticated',
    session: null,
    error: null,
    bootstrapTokenRequired: false,
    ...originalActions,
  });
}

function renderAuthRoute(
  element: React.ReactNode,
  transport: EAgentTransport,
  initialEntry: Parameters<typeof MemoryRouter>[0]['initialEntries'] = ['/login'],
  mode: 'desktop' | 'web' = 'web',
): void {
  render(
    <TransportProvider mode={mode} transport={transport}>
      <MemoryRouter initialEntries={initialEntry}>
        <Routes>
          <Route element={element} path="/login" />
          <Route element={element} path="/setup" />
          <Route element={<div>workspace destination</div>} path="/workspace" />
          <Route element={<div>original destination</div>} path="/original" />
        </Routes>
      </MemoryRouter>
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('AuthGate', () => {
  beforeEach(resetAuth);

  it('空闲状态自动恢复会话并展示受保护内容', async () => {
    useAuthStore.setState({ status: 'idle' });
    const getSession = vi.fn().mockResolvedValue(session);

    render(
      <TransportProvider mode="desktop" transport={{ getSession } as unknown as EAgentTransport}>
        <MemoryRouter initialEntries={['/workspace']}>
          <Routes>
            <Route
              element={
                <AuthGate>
                  <div>protected workspace</div>
                </AuthGate>
              }
              path="/workspace"
            />
            <Route element={<div>login destination</div>} path="/login" />
            <Route element={<div>setup destination</div>} path="/setup" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    expect(document.querySelector('.boot-screen')).toBeInTheDocument();
    expect(await screen.findByText('protected workspace')).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledOnce();
  });

  it.each([
    ['setup-required', 'setup destination'],
    ['unauthenticated', 'login destination'],
  ] as const)('将 %s 状态定向到正确入口', async (status, destination) => {
    useAuthStore.setState({ status });

    render(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter initialEntries={['/workspace']}>
          <Routes>
            <Route
              element={
                <AuthGate>
                  <div>protected workspace</div>
                </AuthGate>
              }
              path="/workspace"
            />
            <Route element={<div>login destination</div>} path="/login" />
            <Route element={<div>setup destination</div>} path="/setup" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    expect(await screen.findByText(destination)).toBeInTheDocument();
  });

  it('加载中持续展示安全启动界面且不重复调用 bootstrap', () => {
    const bootstrap = vi.fn();
    useAuthStore.setState({ status: 'loading', bootstrap });

    render(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter>
          <AuthGate>
            <div>protected workspace</div>
          </AuthGate>
        </MemoryRouter>
      </TransportProvider>,
    );

    expect(document.querySelector('.boot-screen')).toBeInTheDocument();
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

describe('LoginPage', () => {
  beforeEach(resetAuth);

  it('已登录用户直接进入工作台', async () => {
    useAuthStore.setState({ status: 'authenticated', session });
    renderAuthRoute(<LoginPage />, {} as EAgentTransport);

    expect(await screen.findByText('workspace destination')).toBeInTheDocument();
  });

  it('校验表单后清理输入并返回原始受保护页面', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const clearError = vi.fn();
    useAuthStore.setState({ login, clearError, error: 'old error' });
    const initialEntries = [
      {
        pathname: '/login',
        state: { from: { pathname: '/original' } },
      },
    ];
    renderAuthRoute(<LoginPage />, {} as EAgentTransport, initialEntries);

    const email = document.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).toBeDisabled();

    fireEvent.change(email, { target: { value: ' owner@example.com ' } });
    fireEvent.change(password, { target: { value: 'password-123' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(expect.anything(), {
        email: 'owner@example.com',
        password: 'password-123',
      });
    });
    expect(clearError).toHaveBeenCalledOnce();
    expect(await screen.findByText('original destination')).toBeInTheDocument();
  });

  it('认证失败时展示 store 保存的错误', async () => {
    const login = vi.fn(async () => {
      useAuthStore.setState({ status: 'unauthenticated', error: 'invalid credentials' });
      throw new Error('invalid credentials');
    });
    useAuthStore.setState({ login });
    renderAuthRoute(<LoginPage />, {} as EAgentTransport);

    fireEvent.change(document.querySelector('input[type="email"]')!, {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(document.querySelector('input[type="password"]')!, {
      target: { value: 'password-123' },
    });
    fireEvent.submit(document.querySelector('form')!);

    expect(await screen.findByText('invalid credentials')).toBeInTheDocument();
  });
});

describe('SetupPage', () => {
  beforeEach(resetAuth);

  it('已完成初始化时直接进入工作台', async () => {
    useAuthStore.setState({ status: 'authenticated', session });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);

    expect(await screen.findByText('workspace destination')).toBeInTheDocument();
  });

  it('密码不一致时阻止提交并显示字段错误', () => {
    const setup = vi.fn();
    useAuthStore.setState({ setup });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    fireEvent.change(inputs[0]!, { target: { value: ' Owner ' } });
    fireEvent.change(inputs[1]!, { target: { value: ' owner@example.com ' } });
    fireEvent.change(inputs[2]!, { target: { value: 'password-1234' } });
    fireEvent.change(inputs[3]!, { target: { value: 'password-9999' } });

    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
    expect(document.querySelector('.field__error')).toBeInTheDocument();
    fireEvent.submit(document.querySelector('form')!);
    expect(setup).not.toHaveBeenCalled();
  });

  it('仅在 Web 服务端要求时显示必填的一次性部署初始化令牌字段', () => {
    useAuthStore.setState({ bootstrapTokenRequired: true });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);
    expect(screen.getByLabelText('部署初始化令牌')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('部署初始化令牌')).toBeRequired();
    cleanup();

    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup'], 'desktop');
    expect(screen.queryByLabelText('部署初始化令牌')).not.toBeInTheDocument();
    cleanup();

    useAuthStore.setState({ bootstrapTokenRequired: false });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);
    expect(screen.queryByLabelText('部署初始化令牌')).not.toBeInTheDocument();
  });

  it('创建 Owner 时修剪名称和邮箱并进入工作台', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ setup, bootstrapTokenRequired: true });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    fireEvent.change(inputs[0]!, { target: { value: ' Owner ' } });
    fireEvent.change(inputs[1]!, { target: { value: ' owner@example.com ' } });
    fireEvent.change(inputs[2]!, { target: { value: 'password-1234' } });
    fireEvent.change(inputs[3]!, { target: { value: 'password-1234' } });
    fireEvent.change(screen.getByLabelText('部署初始化令牌'), {
      target: { value: 'web-bootstrap-proof-more-than-thirty-two-characters' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => {
      expect(setup).toHaveBeenCalledWith(expect.anything(), {
        name: 'Owner',
        email: 'owner@example.com',
        password: 'password-1234',
        bootstrapToken: 'web-bootstrap-proof-more-than-thirty-two-characters',
      });
    });
    expect(await screen.findByText('workspace destination')).toBeInTheDocument();
  });

  it('初始化失败时展示可读错误并停留在表单', async () => {
    const setup = vi.fn(async () => {
      useAuthStore.setState({ status: 'setup-required', error: 'workspace exists' });
      throw new Error('workspace exists');
    });
    useAuthStore.setState({ setup, bootstrapTokenRequired: true });
    renderAuthRoute(<SetupPage />, {} as EAgentTransport, ['/setup']);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    for (const [index, value] of [
      [0, 'Owner'],
      [1, 'owner@example.com'],
      [2, 'password-1234'],
      [3, 'password-1234'],
    ] as const) {
      fireEvent.change(inputs[index]!, { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('部署初始化令牌'), {
      target: { value: 'wrong-bootstrap-proof-more-than-thirty-two-characters' },
    });
    fireEvent.submit(document.querySelector('form')!);

    expect(await screen.findByText('workspace exists')).toBeInTheDocument();
    expect(screen.getByLabelText('部署初始化令牌')).toHaveValue('');
    expect(document.querySelector('form')).toBeInTheDocument();
  });
});
