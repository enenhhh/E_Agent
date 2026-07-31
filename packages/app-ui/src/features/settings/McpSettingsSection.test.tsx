import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useToastStore } from '../../stores/toast-store';
import type { AppMode, McpServerInput, McpServerState, McpServerSummary, User } from '../../types';

import { McpSettingsSection } from './McpSettingsSection';

type McpTransportMethods = Pick<
  EAgentTransport,
  | 'listMcpServers'
  | 'saveMcpServer'
  | 'setMcpServerEnabled'
  | 'refreshMcpServer'
  | 'removeMcpServer'
>;

function mcpServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: 'knowledge',
    displayName: '项目知识库',
    enabled: true,
    transport: 'stdio',
    endpoint: 'npx',
    state: 'connected',
    toolCount: 2,
    tools: ['search', 'read'],
    hasCredentials: false,
    ...overrides,
  };
}

function mcpTransport(overrides: Partial<McpTransportMethods> = {}): EAgentTransport {
  return {
    kind: 'desktop',
    listMcpServers: vi.fn(async () => []),
    saveMcpServer: vi.fn(async (input: McpServerInput) =>
      mcpServer({
        displayName: input.displayName,
        transport: input.transport,
        endpoint: input.transport === 'stdio' ? input.command : input.url,
      }),
    ),
    setMcpServerEnabled: vi.fn(async (id: string, enabled: boolean) => mcpServer({ id, enabled })),
    refreshMcpServer: vi.fn(async (id: string) => mcpServer({ id })),
    removeMcpServer: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as EAgentTransport;
}

function renderSection(
  transport: EAgentTransport,
  mode: AppMode = 'desktop',
): ReturnType<typeof render> {
  return render(
    <TransportProvider mode={mode} transport={transport}>
      <McpSettingsSection />
    </TransportProvider>,
  );
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

function openStdioForm(): void {
  fireEvent.click(screen.getByRole('button', { name: '添加 Server' }));
  fireEvent.change(screen.getByLabelText('显示名称'), {
    target: { value: '本地工具' },
  });
  fireEvent.change(screen.getByLabelText('启动命令'), {
    target: { value: 'node' },
  });
}

function acknowledgeStdioRisk(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: /我了解：保存会立即启动/ }));
}

function switchToHttpForm(): void {
  fireEvent.click(screen.getByRole('button', { name: '添加 Server' }));
  fireEvent.change(screen.getByLabelText('连接方式'), {
    target: { value: 'streamable-http' },
  });
  fireEvent.change(screen.getByLabelText('显示名称'), {
    target: { value: '远程工具' },
  });
  fireEvent.change(screen.getByLabelText('Server URL'), {
    target: { value: 'https://mcp.example.com/mcp' },
  });
}

function latestToast(): ReturnType<typeof useToastStore.getState>['messages'][number] | undefined {
  return useToastStore.getState().messages.at(-1);
}

beforeEach(() => {
  setRole('owner');
  useToastStore.setState({ messages: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('McpSettingsSection', () => {
  it('Web 模式仅展示能力边界，不读取或管理桌面 MCP Server', () => {
    const listMcpServers = vi.fn(async () => []);
    renderSection(mcpTransport({ listMcpServers }), 'web');

    expect(
      screen.getByText(/MCP 进程与本地工具仅在桌面端运行；Web 协作端不会/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加 Server' })).not.toBeInTheDocument();
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('%s 可以打开和取消新增表单', async (role) => {
    setRole(role);
    renderSection(mcpTransport());
    await screen.findByText(/尚未配置 MCP Server/);

    const addButton = screen.getByRole('button', { name: '添加 Server' });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeDisabled();
    expect(screen.getByText(/MCP Server 不在 OS 沙箱中/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByLabelText('启动命令')).not.toBeInTheDocument();
  });

  it.each(['member', 'viewer'] as const)('%s 只能查看列表，所有管理入口均被禁用', async (role) => {
    setRole(role);
    const existing = mcpServer();
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [existing]),
      }),
    );

    expect(await screen.findByText('项目知识库')).toBeInTheDocument();
    expect(screen.getByText(/当前角色只能查看 MCP 状态/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 Server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新 项目知识库' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除 项目知识库' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /项目知识库 · 已启用/ })).toBeDisabled();
  });

  it('先展示读取状态，再展示空状态', async () => {
    let resolveList!: (servers: McpServerSummary[]) => void;
    const pendingList = new Promise<McpServerSummary[]>((resolve) => {
      resolveList = resolve;
    });
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(() => pendingList),
      }),
    );

    expect(screen.getByText('正在读取 MCP Server…')).toBeInTheDocument();
    await act(async () => resolveList([]));
    expect(await screen.findByText(/尚未配置 MCP Server/)).toBeInTheDocument();
  });

  it('读取失败时显示 Error 详情并回落到空状态', async () => {
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => {
          throw new Error('配置文件不可读');
        }),
      }),
    );

    await screen.findByText(/尚未配置 MCP Server/);
    expect(latestToast()).toMatchObject({
      kind: 'error',
      title: 'MCP Server 读取失败',
      description: '配置文件不可读',
    });
  });

  it('读取抛出非 Error 值时不泄露无意义的错误详情', async () => {
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => {
          throw 'offline';
        }),
      }),
    );

    await screen.findByText(/尚未配置 MCP Server/);
    expect(latestToast()).toMatchObject({
      kind: 'error',
      title: 'MCP Server 读取失败',
    });
    expect(latestToast()?.description).toBeUndefined();
  });

  it('完整展示连接状态、工具摘要、凭据与服务端错误', async () => {
    const states: McpServerState[] = [
      'connected',
      'error',
      'connecting',
      'disconnected',
      'disabled',
    ];
    const servers = states.map((state, index) =>
      mcpServer({
        id: state,
        displayName: `Server ${state}`,
        enabled: state !== 'disabled',
        transport: index % 2 === 0 ? 'stdio' : 'streamable-http',
        endpoint: `endpoint-${state}`,
        state,
        toolCount: index === 0 ? 5 : index === 1 ? 2 : 0,
        tools:
          index === 0
            ? ['one', 'two', 'three', 'four', 'five']
            : index === 1
              ? ['read', 'write']
              : [],
        hasCredentials: index === 0,
        lastError: index === 1 ? '握手失败' : undefined,
      }),
    );
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => servers),
      }),
    );

    expect(await screen.findByText('Server connected')).toBeInTheDocument();
    for (const label of ['已连接', '连接失败', '连接中', '未连接', '已停用']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByText(/5 个工具 · one · two · three · four … · 凭据已加密/),
    ).toBeInTheDocument();
    expect(screen.getByText('2 个工具 · read · write')).toBeInTheDocument();
    expect(screen.getAllByText('尚未发现工具')).toHaveLength(3);
    expect(screen.getByText('握手失败')).toBeInTheDocument();
    expect(screen.getByTitle('endpoint-connected')).toHaveTextContent('endpoint-connected');
  });

  it('保存 stdio Server 时解析参数、裁剪目录并加密提交环境变量', async () => {
    const saveMcpServer = vi.fn(async (input: McpServerInput) =>
      mcpServer({ displayName: input.displayName }),
    );
    const listMcpServers = vi
      .fn<() => Promise<McpServerSummary[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mcpServer({ displayName: '本地工具' })]);
    renderSection(mcpTransport({ listMcpServers, saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    openStdioForm();

    fireEvent.change(screen.getByLabelText('参数（JSON 数组）'), {
      target: { value: '["worker.js","--safe"]' },
    });
    fireEvent.change(screen.getByLabelText('工作目录（可选）'), {
      target: { value: '  D:\\workspace  ' },
    });
    fireEvent.change(screen.getByLabelText('环境变量（加密，可选）'), {
      target: { value: '{"API_TOKEN":"secret","MODE":"test"}' },
    });
    acknowledgeStdioRisk();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith({
        displayName: '本地工具',
        transport: 'stdio',
        command: 'node',
        args: ['worker.js', '--safe'],
        cwd: 'D:\\workspace',
        env: { API_TOKEN: 'secret', MODE: 'test' },
        inheritEnv: false,
      });
    });
    expect(await screen.findByText('本地工具')).toBeInTheDocument();
    expect(screen.queryByLabelText('启动命令')).not.toBeInTheDocument();
    expect(latestToast()).toMatchObject({ kind: 'success', title: 'MCP Server 已保存' });
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });

  it('stdio 可省略参数、目录和环境变量，并在确认风险前阻止保存', async () => {
    const saveMcpServer = vi.fn(async () => mcpServer());
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    openStdioForm();

    expect(screen.getByRole('button', { name: '保存并连接' })).toBeDisabled();
    expect(saveMcpServer).not.toHaveBeenCalled();
    acknowledgeStdioRisk();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith({
        displayName: '本地工具',
        transport: 'stdio',
        command: 'node',
        args: [],
        inheritEnv: false,
      });
    });
  });

  it.each([
    ['损坏 JSON', '{'],
    ['非数组', '{"arg":"x"}'],
    ['超过 64 项', JSON.stringify(Array.from({ length: 65 }, () => 'x'))],
    ['包含非字符串', '["ok",1]'],
    ['字符串过长', JSON.stringify(['x'.repeat(4_097)])],
  ])('拒绝无效 stdio 参数：%s', async (_caseName, value) => {
    const saveMcpServer = vi.fn(async () => mcpServer());
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    openStdioForm();
    fireEvent.change(screen.getByLabelText('参数（JSON 数组）'), {
      target: { value },
    });
    acknowledgeStdioRisk();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 保存失败',
      });
    });
    expect(saveMcpServer).not.toHaveBeenCalled();
  });

  it.each([
    ['损坏 JSON', '{'],
    ['null', 'null'],
    ['数组', '["secret"]'],
    [
      '超过 64 项',
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`K${index}`, 'x'])),
      ),
    ],
    ['值不是字符串', '{"COUNT":1}'],
    ['值过长', JSON.stringify({ TOKEN: 'x'.repeat(32_769) })],
  ])('拒绝无效 stdio 环境变量：%s', async (_caseName, value) => {
    const saveMcpServer = vi.fn(async () => mcpServer());
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    openStdioForm();
    fireEvent.change(screen.getByLabelText('环境变量（加密，可选）'), {
      target: { value },
    });
    acknowledgeStdioRisk();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 保存失败',
      });
    });
    expect(saveMcpServer).not.toHaveBeenCalled();
  });

  it('保存远程 HTTP Server 时提交加密 Header，且不要求 stdio 风险确认', async () => {
    const saveMcpServer = vi.fn(async (input: McpServerInput) =>
      mcpServer({
        displayName: input.displayName,
        transport: input.transport,
        endpoint: input.transport === 'streamable-http' ? input.url : input.command,
      }),
    );
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    switchToHttpForm();

    expect(screen.getByText(/远程 MCP Server 属于不可信外部服务/)).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /我了解：保存会立即启动/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('HTTP Headers（加密，可选）'), {
      target: { value: '{"Authorization":"Bearer secret","X-Tenant":"demo"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith({
        displayName: '远程工具',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          Authorization: 'Bearer secret',
          'X-Tenant': 'demo',
        },
      });
    });
  });

  it('远程 HTTP Server 可省略 Header', async () => {
    const saveMcpServer = vi.fn(async () => mcpServer({ transport: 'streamable-http' }));
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    switchToHttpForm();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith({
        displayName: '远程工具',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
      });
    });
  });

  it.each([
    ['损坏 JSON', '{'],
    ['null', 'null'],
    ['数组', '["Bearer secret"]'],
    ['值不是字符串', '{"Authorization":false}'],
  ])('拒绝无效 HTTP Header：%s', async (_caseName, value) => {
    const saveMcpServer = vi.fn(async () => mcpServer());
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    switchToHttpForm();
    fireEvent.change(screen.getByLabelText('HTTP Headers（加密，可选）'), {
      target: { value },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 保存失败',
      });
    });
    expect(saveMcpServer).not.toHaveBeenCalled();
  });

  it('保存请求期间禁用操作，并在服务失败后恢复表单', async () => {
    let rejectSave!: (reason: Error) => void;
    const saveMcpServer = vi.fn(
      () =>
        new Promise<McpServerSummary>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    renderSection(mcpTransport({ saveMcpServer }));
    await screen.findByText(/尚未配置 MCP Server/);
    switchToHttpForm();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    expect(screen.getByRole('button', { name: '保存并连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    await act(async () => rejectSave(new Error('远端拒绝配置')));

    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 保存失败',
        description: '远端拒绝配置',
      });
    });
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeEnabled();
    expect(screen.getByLabelText('Server URL')).toHaveValue('https://mcp.example.com/mcp');
  });

  it('保存抛出非 Error 值时不写入错误详情', async () => {
    renderSection(
      mcpTransport({
        saveMcpServer: vi.fn(async () => {
          throw { code: 'SAVE_FAILED' };
        }),
      }),
    );
    await screen.findByText(/尚未配置 MCP Server/);
    switchToHttpForm();
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 保存失败',
      });
    });
    expect(latestToast()?.description).toBeUndefined();
  });

  it.each([
    [true, false],
    [false, true],
  ])('成功将 enabled=%s 切换为 %s', async (initialEnabled, nextEnabled) => {
    const existing = mcpServer({ enabled: initialEnabled });
    const setMcpServerEnabled = vi.fn(async (id: string, enabled: boolean) => ({
      ...existing,
      id,
      enabled,
    }));
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [existing]),
        setMcpServerEnabled,
      }),
    );

    const toggle = await screen.findByRole('checkbox', {
      name: new RegExp(`项目知识库 · ${initialEnabled ? '已启用' : '已停用'}`),
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('knowledge', nextEnabled);
      const updatedToggle = screen.getByRole('checkbox', {
        name: new RegExp(`项目知识库 · ${nextEnabled ? '已启用' : '已停用'}`),
      });
      if (nextEnabled) {
        expect(updatedToggle).toBeChecked();
      } else {
        expect(updatedToggle).not.toBeChecked();
      }
    });
  });

  it.each([
    [false, 'MCP Server 启用失败', new Error('启动失败'), '启动失败'],
    [true, 'MCP Server 停用失败', 'offline', undefined],
  ])(
    '切换失败时保留原状态并显示对应提示（当前 enabled=%s）',
    async (enabled, title, failure, description) => {
      const existing = mcpServer({ enabled });
      renderSection(
        mcpTransport({
          listMcpServers: vi.fn(async () => [existing]),
          setMcpServerEnabled: vi.fn(async () => {
            throw failure;
          }),
        }),
      );

      const toggle = await screen.findByRole('checkbox', {
        name: new RegExp(`项目知识库 · ${enabled ? '已启用' : '已停用'}`),
      });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(latestToast()).toMatchObject({
          kind: 'error',
          title,
          ...(description ? { description } : {}),
        });
      });
      expect(toggle).toHaveProperty('checked', enabled);
      if (!description) expect(latestToast()?.description).toBeUndefined();
    },
  );

  it('刷新成功后仅替换目标 Server 并展示发现的工具数', async () => {
    const first = mcpServer({ id: 'first', displayName: '第一个', toolCount: 0, tools: [] });
    const second = mcpServer({ id: 'second', displayName: '第二个' });
    const refreshMcpServer = vi.fn(async () => ({
      ...first,
      toolCount: 3,
      tools: ['a', 'b', 'c'],
    }));
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [first, second]),
        refreshMcpServer,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '刷新 第一个' }));

    await waitFor(() => {
      expect(refreshMcpServer).toHaveBeenCalledWith('first');
      expect(screen.getByText('3 个工具 · a · b · c')).toBeInTheDocument();
      expect(screen.getByText('2 个工具 · search · read')).toBeInTheDocument();
      expect(latestToast()).toMatchObject({
        kind: 'success',
        title: 'MCP 工具已刷新',
        description: '发现 3 个工具。',
      });
    });
  });

  it('刷新失败后报告 Error 并重新读取权威列表', async () => {
    const existing = mcpServer();
    const listMcpServers = vi
      .fn<() => Promise<McpServerSummary[]>>()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([mcpServer({ state: 'error', lastError: '新的连接错误' })]);
    renderSection(
      mcpTransport({
        listMcpServers,
        refreshMcpServer: vi.fn(async () => {
          throw new Error('刷新超时');
        }),
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '刷新 项目知识库' }));

    await waitFor(() => {
      expect(listMcpServers).toHaveBeenCalledTimes(2);
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP 工具刷新失败',
        description: '刷新超时',
      });
      expect(screen.getByText('新的连接错误')).toBeInTheDocument();
    });
  });

  it('刷新抛出非 Error 值时不写入详情，但仍重新加载', async () => {
    const listMcpServers = vi.fn(async () => [mcpServer()]);
    renderSection(
      mcpTransport({
        listMcpServers,
        refreshMcpServer: vi.fn(async () => {
          throw 'timeout';
        }),
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '刷新 项目知识库' }));
    await waitFor(() => expect(listMcpServers).toHaveBeenCalledTimes(2));
    expect(latestToast()).toMatchObject({ kind: 'error', title: 'MCP 工具刷新失败' });
    expect(latestToast()?.description).toBeUndefined();
  });

  it('用户取消确认时不会移除 Server', async () => {
    const removeMcpServer = vi.fn(async () => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [mcpServer()]),
        removeMcpServer,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '移除 项目知识库' }));
    expect(window.confirm).toHaveBeenCalledWith('移除 MCP Server「项目知识库」？');
    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(screen.getByText('项目知识库')).toBeInTheDocument();
  });

  it('确认后移除目标 Server，保留其余 Server 并显示成功提示', async () => {
    const removeMcpServer = vi.fn(async () => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [
          mcpServer({ id: 'first', displayName: '第一个' }),
          mcpServer({ id: 'second', displayName: '第二个' }),
        ]),
        removeMcpServer,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '移除 第一个' }));
    await waitFor(() => {
      expect(removeMcpServer).toHaveBeenCalledWith('first');
      expect(screen.queryByText('第一个')).not.toBeInTheDocument();
      expect(screen.getByText('第二个')).toBeInTheDocument();
      expect(latestToast()).toMatchObject({
        kind: 'success',
        title: 'MCP Server 已移除',
      });
    });
  });

  it.each([
    [new Error('文件被占用'), '文件被占用'],
    ['locked', undefined],
  ])('移除失败时保留 Server 并安全显示错误', async (failure, description) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSection(
      mcpTransport({
        listMcpServers: vi.fn(async () => [mcpServer()]),
        removeMcpServer: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '移除 项目知识库' }));
    await waitFor(() => {
      expect(latestToast()).toMatchObject({
        kind: 'error',
        title: 'MCP Server 移除失败',
        ...(description ? { description } : {}),
      });
    });
    expect(screen.getByText('项目知识库')).toBeInTheDocument();
    if (!description) expect(latestToast()?.description).toBeUndefined();
  });

  it('每 15 秒静默轮询状态，静默刷新不切回 loading，卸载时清理定时器', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (servers: McpServerSummary[]) => void;
    const listMcpServers = vi
      .fn<() => Promise<McpServerSummary[]>>()
      .mockResolvedValueOnce([mcpServer()])
      .mockImplementationOnce(
        () =>
          new Promise<McpServerSummary[]>((resolve) => {
            resolvePoll = resolve;
          }),
      );
    const view = renderSection(mcpTransport({ listMcpServers }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('项目知识库')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(15_000));
    expect(listMcpServers).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('正在读取 MCP Server…')).not.toBeInTheDocument();
    await act(async () => resolvePoll([mcpServer({ state: 'error', lastError: '轮询发现错误' })]));
    expect(screen.getByText('轮询发现错误')).toBeInTheDocument();

    view.unmount();
    act(() => vi.advanceTimersByTime(15_000));
    expect(listMcpServers).toHaveBeenCalledTimes(2);
  });
});
