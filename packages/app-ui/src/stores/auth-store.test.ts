import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportError, type EAgentTransport } from '../lib/transport';
import type { SessionInfo } from '../types';

import { useAuthStore } from './auth-store';

const session = {
  user: {
    id: 'owner-1',
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    active: true,
  },
} as SessionInfo;

function transport(overrides: Partial<EAgentTransport>): EAgentTransport {
  return overrides as EAgentTransport;
}

describe('auth store', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'idle',
      session: null,
      error: null,
      bootstrapTokenRequired: false,
    });
  });

  it('启动时区分已登录、未登录与首次初始化状态', async () => {
    await useAuthStore
      .getState()
      .bootstrap(transport({ getSession: vi.fn().mockResolvedValue(session) }));
    expect(useAuthStore.getState()).toMatchObject({
      status: 'authenticated',
      session,
      error: null,
    });

    await useAuthStore
      .getState()
      .bootstrap(transport({ getSession: vi.fn().mockResolvedValue(null) }));
    expect(useAuthStore.getState()).toMatchObject({
      status: 'unauthenticated',
      session: null,
    });

    await useAuthStore.getState().bootstrap(
      transport({
        getSession: vi.fn().mockRejectedValue(
          new TransportError('setup required', {
            code: 'SETUP_REQUIRED',
            bootstrapTokenRequired: true,
          }),
        ),
      }),
    );
    expect(useAuthStore.getState()).toMatchObject({
      status: 'setup-required',
      session: null,
      bootstrapTokenRequired: true,
    });
  });

  it('启动失败时保存 Error 与未知错误的友好提示', async () => {
    await useAuthStore
      .getState()
      .bootstrap(transport({ getSession: vi.fn().mockRejectedValue(new Error('offline')) }));
    expect(useAuthStore.getState()).toMatchObject({
      status: 'unauthenticated',
      error: 'offline',
    });

    await useAuthStore
      .getState()
      .bootstrap(transport({ getSession: vi.fn().mockRejectedValue('offline') }));
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toEqual(expect.any(String));
    expect(useAuthStore.getState().error).not.toBe('');
  });

  it('登录成功后保存会话，失败后保留可恢复状态并继续抛出错误', async () => {
    const input = { email: ' owner@example.com ', password: 'password-123' };
    const login = vi.fn().mockResolvedValue(session);
    await useAuthStore.getState().login(transport({ login }), input);
    expect(login).toHaveBeenCalledWith(input);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'authenticated',
      session,
    });

    const expected = new Error('invalid credentials');
    await expect(
      useAuthStore
        .getState()
        .login(transport({ login: vi.fn().mockRejectedValue(expected) }), input),
    ).rejects.toBe(expected);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'unauthenticated',
      session: null,
      error: 'invalid credentials',
    });

    await expect(
      useAuthStore.getState().login(transport({ login: vi.fn().mockRejectedValue(null) }), input),
    ).rejects.toBeNull();
    expect(useAuthStore.getState().error).toEqual(expect.any(String));
  });

  it('初始化 Owner 成功与失败时更新正确状态', async () => {
    const input = {
      name: 'Owner',
      email: 'owner@example.com',
      password: 'password-123',
    };
    await useAuthStore
      .getState()
      .setup(transport({ setup: vi.fn().mockResolvedValue(session) }), input);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'authenticated',
      session,
    });

    const expected = new Error('already initialized');
    await expect(
      useAuthStore
        .getState()
        .setup(transport({ setup: vi.fn().mockRejectedValue(expected) }), input),
    ).rejects.toBe(expected);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'setup-required',
      session: null,
      error: 'already initialized',
    });

    await expect(
      useAuthStore
        .getState()
        .setup(transport({ setup: vi.fn().mockRejectedValue(undefined) }), input),
    ).rejects.toBeUndefined();
    expect(useAuthStore.getState().error).toEqual(expect.any(String));
  });

  it('退出即使后端失败也清除本地会话，并支持清除错误', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      session,
      error: 'stale error',
    });
    const expected = new Error('network failed');

    await expect(
      useAuthStore.getState().logout(transport({ logout: vi.fn().mockRejectedValue(expected) })),
    ).rejects.toBe(expected);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'unauthenticated',
      session: null,
      error: null,
    });

    useAuthStore.setState({ error: 'another error' });
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
  });
});
