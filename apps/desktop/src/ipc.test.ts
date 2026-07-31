import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  return {
    handlers,
    listeners,
    dialog: {
      showOpenDialog: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(
        (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      ),
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listeners.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  dialog: electronMock.dialog,
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { registerIpcHandlers, type IpcServices } from './ipc.js';

function createServices(role: 'admin' | 'member' | 'owner' | 'viewer' | null) {
  const binding = {
    bindingId: '0327ca10-5ff3-4cac-8d47-021371785425',
    root: 'D:\\workspace',
    name: 'workspace',
  };
  const services = {
    windows: {
      isTrustedSender: vi.fn(() => true),
      get: vi.fn(() => undefined),
      emit: vi.fn(),
    },
    workspace: {
      getBinding: vi.fn(() => undefined),
      bind: vi.fn(async () => binding),
      list: vi.fn(async () => []),
      read: vi.fn(async () => ({ path: 'README.md', content: 'test' })),
      proposeWrite: vi.fn(async () => ({ id: 'proposal' })),
      listProposals: vi.fn(() => []),
      applyProposal: vi.fn(async () => ({ id: 'proposal' })),
      rejectProposal: vi.fn(async () => undefined),
    },
    plugins: {
      setWorkspaceRoot: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    },
    notifications: {
      show: vi.fn(async () => undefined),
    },
    updates: {
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      installAndRestart: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
    },
    getSelfCheck: vi.fn(async () => ({ healthy: true, items: [] })),
    applicationHandlers: {
      'auth:get-session': vi.fn(async () =>
        role === null
          ? null
          : {
              user: {
                role,
              },
            },
      ),
      'models:list': vi.fn(async () => [{ id: 'model-1' }]),
    },
  } as unknown as IpcServices;
  return { binding, services };
}

async function invokeChannel(
  channel: string,
  payload: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} handler was not registered`);
  }
  return (await handler({ sender: {} }, payload)) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string };
  };
}

async function invokeWorkspaceChoose(): Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code: string };
}> {
  return invokeChannel('workspace:choose', {});
}

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.listeners.clear();
  vi.clearAllMocks();
});

describe('workspace:choose IPC authorization', () => {
  it.each(['member', 'viewer'] as const)(
    'rejects %s before opening the native directory picker',
    async (role) => {
      const { services } = createServices(role);
      registerIpcHandlers(services);

      const result = await invokeWorkspaceChoose();

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
      expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(services.workspace.bind).not.toHaveBeenCalled();
      expect(services.plugins.setWorkspaceRoot).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'admin'] as const)('allows %s to choose and bind a workspace', async (role) => {
    const { binding, services } = createServices(role);
    electronMock.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [binding.root],
    });
    registerIpcHandlers(services);

    const result = await invokeWorkspaceChoose();

    expect(result).toEqual({ ok: true, data: binding });
    expect(services.workspace.bind).toHaveBeenCalledWith(binding.root);
    expect(services.plugins.setWorkspaceRoot).toHaveBeenCalledWith(binding.root);
    expect(services.windows.emit).toHaveBeenCalledWith('workspace:changed', {
      type: 'binding',
      binding,
    });
  });
});

describe('workspace raw IPC authorization', () => {
  const calls = [
    ['workspace:get-binding', {}],
    ['workspace:list', { path: '', depth: 1 }],
    ['workspace:read', { path: 'README.md' }],
    ['workspace:propose-write', { path: 'new.txt', content: 'test' }],
    ['workspace:list-proposals', {}],
    ['workspace:apply-proposal', { proposalId: '11111111-1111-4111-8111-111111111111' }],
    ['workspace:reject-proposal', { proposalId: '11111111-1111-4111-8111-111111111111' }],
  ] as const;

  it.each([null, 'viewer'] as const)('拒绝 %s 会话读取或修改本机工作区', async (role) => {
    const { services } = createServices(role);
    registerIpcHandlers(services);

    for (const [channel, payload] of calls) {
      await expect(invokeChannel(channel, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
    }
    expect(services.workspace.list).not.toHaveBeenCalled();
    expect(services.workspace.read).not.toHaveBeenCalled();
    expect(services.workspace.proposeWrite).not.toHaveBeenCalled();
    expect(services.workspace.applyProposal).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin', 'member'] as const)('允许 %s 访问受控工作区 IPC', async (role) => {
    const { services } = createServices(role);
    registerIpcHandlers(services);

    for (const [channel, payload] of calls) {
      await expect(invokeChannel(channel, payload)).resolves.toMatchObject({ ok: true });
    }
    expect(services.workspace.list).toHaveBeenCalledOnce();
    expect(services.workspace.read).toHaveBeenCalledOnce();
    expect(services.workspace.proposeWrite).toHaveBeenCalledOnce();
    expect(services.workspace.applyProposal).toHaveBeenCalledOnce();
  });
});

describe('application IPC session boundary', () => {
  it('未登录时拒绝业务读取，并且不会调用底层 handler', async () => {
    const { services } = createServices(null);
    registerIpcHandlers(services);

    await expect(invokeChannel('models:list', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(services.applicationHandlers?.['models:list']).not.toHaveBeenCalled();
  });

  it.each(['auth:get-session', 'auth:logout'] as const)(
    '未登录时仍允许公开身份通道 %s',
    async (channel) => {
      const { services } = createServices(null);
      if (channel === 'auth:logout') {
        services.applicationHandlers = {
          ...services.applicationHandlers,
          'auth:logout': vi.fn(async () => undefined),
        };
      }
      registerIpcHandlers(services);

      await expect(invokeChannel(channel, {})).resolves.toMatchObject({ ok: true });
    },
  );

  it('登录后允许业务读取', async () => {
    const { services } = createServices('member');
    registerIpcHandlers(services);

    await expect(invokeChannel('models:list', {})).resolves.toEqual({
      ok: true,
      data: [{ id: 'model-1' }],
    });
    expect(services.applicationHandlers?.['models:list']).toHaveBeenCalledOnce();
  });

  it('未登录时拒绝读取插件清单', async () => {
    const { services } = createServices(null);
    registerIpcHandlers(services);

    await expect(invokeChannel('plugins:list', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(services.plugins.list).not.toHaveBeenCalled();
  });
});

describe('desktop update IPC authorization', () => {
  it('未登录时不能检查、下载或安装更新', async () => {
    const { services } = createServices(null);
    registerIpcHandlers(services);

    for (const channel of ['updates:check', 'updates:download', 'updates:install'] as const) {
      await expect(invokeChannel(channel, {})).resolves.toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
    }
    expect(services.updates.check).not.toHaveBeenCalled();
    expect(services.updates.download).not.toHaveBeenCalled();
    expect(services.updates.installAndRestart).not.toHaveBeenCalled();
  });

  it.each(['member', 'viewer'] as const)('%s 只能检查更新，不能下载或安装', async (role) => {
    const { services } = createServices(role);
    registerIpcHandlers(services);

    await expect(invokeChannel('updates:check', {})).resolves.toMatchObject({ ok: true });
    await expect(invokeChannel('updates:download', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    await expect(invokeChannel('updates:install', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(services.updates.check).toHaveBeenCalledOnce();
    expect(services.updates.download).not.toHaveBeenCalled();
    expect(services.updates.installAndRestart).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('允许 %s 完成更新生命周期', async (role) => {
    const { services } = createServices(role);
    registerIpcHandlers(services);

    await expect(invokeChannel('updates:check', {})).resolves.toMatchObject({ ok: true });
    await expect(invokeChannel('updates:download', {})).resolves.toMatchObject({ ok: true });
    await expect(invokeChannel('updates:install', {})).resolves.toMatchObject({ ok: true });
    expect(services.updates.check).toHaveBeenCalledOnce();
    expect(services.updates.download).toHaveBeenCalledOnce();
    expect(services.updates.installAndRestart).toHaveBeenCalledOnce();
  });
});

describe('application stream abort acknowledgement', () => {
  it('等待流处理器清理完成后向 renderer 发送 complete', async () => {
    const { services } = createServices('owner');
    services.applicationStreamHandlers = {
      'chat:stream': async function* (_input, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield null;
      },
    };
    registerIpcHandlers(services);

    const startListener = electronMock.listeners.get('application:stream-start');
    const abortListener = electronMock.listeners.get('application:stream-abort');
    expect(startListener).toBeDefined();
    expect(abortListener).toBeDefined();
    const streamId = crypto.randomUUID();
    const replies: unknown[] = [];
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const sender = {
      id: 41,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const event = {
      sender,
      reply: vi.fn((_channel: string, payload: unknown) => {
        replies.push(payload);
        if (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { type?: string }).type === 'complete'
        ) {
          acknowledge();
        }
      }),
    };

    startListener?.(event, {
      streamId,
      channel: 'chat:stream',
      payload: {
        conversationId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(),
        content: 'abort me',
        model: 'model',
        contextMentions: [],
      },
    });
    abortListener?.(event, { streamId });
    await acknowledged;

    expect(replies).toContainEqual({ streamId, type: 'complete' });
  });
});
