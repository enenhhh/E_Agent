import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../context/I18nContext';
import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useModelStore } from '../../stores/model-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';
import type { AppMode, AppSettings, Model } from '../../types';

import { SettingsPage } from './SettingsPage';

const baseSettings: AppSettings = {
  locale: 'zh-CN',
  theme: 'ink',
  defaultModels: {
    code: 'model-a',
    chat: 'model-a',
    summarize: 'model-b',
  },
  maxConcurrency: 5,
  costAlertThreshold: 5,
  autoCompressContext: true,
  autoUpdate: true,
  telemetryEnabled: false,
  ollamaFallback: false,
  reasoningDisplay: 'collapsed',
  toolExecutionPolicy: 'always-ask',
  toolCommandTimeoutMs: 60_000,
  toolOutputLimitBytes: 131_072,
  tutorialCompletedVersion: 0,
  autoExpandRunningTools: true,
};

function model(id: string, providerId: string, providerName: string, available = true): Model {
  return {
    id,
    remoteId: id,
    providerId,
    providerName,
    provider: 'custom',
    displayName: id.toUpperCase(),
    contextWindow: 32_000,
    capabilities: ['chat', 'code'],
    available,
  };
}

function transportWith(
  overrides: Partial<EAgentTransport> = {},
): EAgentTransport & { updateSettings: ReturnType<typeof vi.fn> } {
  const updateSettings = vi.fn(async (input: Partial<AppSettings>) => ({
    ...useSettingsStore.getState().settings,
    ...input,
  }));
  return {
    listMcpServers: vi.fn(async () => []),
    updateSettings,
    runStartupCheck: vi.fn(async () => []),
    ...overrides,
  } as unknown as EAgentTransport & { updateSettings: ReturnType<typeof vi.fn> };
}

function renderSettings(transport: EAgentTransport, mode: AppMode = 'desktop'): void {
  render(
    <TransportProvider mode={mode} transport={transport}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route element={<SettingsPage />} path="/settings" />
            <Route element={<div>教程页已打开</div>} path="/tutorial" />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('SettingsPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('e-agent-locale', 'zh-CN');
    document.documentElement.dataset.theme = '';
    document.documentElement.lang = 'zh-CN';
    useSettingsStore.setState({
      settings: {
        ...baseSettings,
        defaultModels: { ...baseSettings.defaultModels },
      },
      loading: false,
      error: null,
    });
    const models = [
      model('model-a', 'provider-a', 'Gateway A'),
      model('model-a-disabled', 'provider-a', 'Gateway A', false),
      model('model-b', 'provider-b', 'Gateway B'),
    ];
    useModelStore.setState({
      models,
      modelsForSelectedProvider: models.slice(0, 2),
      selectedProviderId: 'provider-a',
      selectedModel: 'model-a',
      selectedModelByProvider: { 'provider-a': 'model-a' },
      compareModels: [],
      loading: false,
      discovering: false,
      error: null,
    });
    useToastStore.setState({ messages: [] });
    useAuthStore.setState({
      status: 'authenticated',
      session: {
        user: {
          id: 'owner-1',
          name: 'Owner',
          email: 'owner@example.com',
          role: 'owner',
          active: true,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      error: null,
    });
  });

  it('默认模型按服务商级联筛选，并保存当前场景的模型', async () => {
    const transport = transportWith();
    renderSettings(transport);

    const providerSelect = screen.getByLabelText('@code 服务商');
    const modelSelect = screen.getByLabelText('@code 模型');
    expect(
      within(modelSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['未设置', 'MODEL-A', 'MODEL-A-DISABLED']);
    expect(within(modelSelect).getByRole('option', { name: 'MODEL-A-DISABLED' })).toBeDisabled();

    fireEvent.change(providerSelect, { target: { value: 'provider-b' } });

    await waitFor(() => {
      expect(
        within(modelSelect)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['未设置', 'MODEL-B']);
    });
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledTimes(1);
      expect(transport.updateSettings).toHaveBeenCalledWith({
        defaultModels: expect.objectContaining({ code: 'model-b' }),
      });
    });
    expect(modelSelect).toHaveValue('model-b');
    expect(transport.updateSettings).not.toHaveBeenCalledWith({
      defaultModels: expect.objectContaining({ code: '' }),
    });
  });

  it('没有服务商时展示空状态并禁用模型选择', () => {
    useModelStore.setState({
      models: [],
      modelsForSelectedProvider: [],
      selectedProviderId: '',
      selectedModel: '',
      selectedModelByProvider: {},
    });

    renderSettings(transportWith());

    expect(
      within(screen.getByLabelText('@code 服务商')).getByRole('option', {
        name: '暂无服务商',
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('@code 模型')).toBeDisabled();
    expect(screen.getByLabelText('@chat 模型')).toBeDisabled();
    expect(screen.getByLabelText('上下文压缩 模型')).toBeDisabled();
  });

  it('切换主题和语言后立即更新界面，并保存设置', async () => {
    const transport = transportWith();
    renderSettings(transport);

    fireEvent.click(screen.getByRole('button', { name: '暖阳' }));
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ theme: 'sunrise' });
    });
    expect(document.documentElement.dataset.theme).toBe('sunrise');

    fireEvent.change(screen.getByRole('combobox', { name: '界面语言' }), {
      target: { value: 'en-US' },
    });
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenLastCalledWith({ locale: 'en-US' });
    });
    expect(document.documentElement.lang).toBe('en-US');
    expect(window.localStorage.getItem('e-agent-locale')).toBe('en-US');
    expect(screen.getByText('当前主题：Sunrise')).toBeInTheDocument();
  });

  it('主题保存失败时回滚主题、设置状态和本地偏好', async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error('主题保存失败');
    });
    renderSettings(transportWith({ updateSettings }));

    fireEvent.click(screen.getByRole('button', { name: '暖阳' }));

    await waitFor(() => {
      expect(useToastStore.getState().messages.at(-1)).toMatchObject({
        kind: 'error',
        description: '主题保存失败',
      });
    });
    expect(useSettingsStore.getState().settings.theme).toBe('ink');
    expect(document.documentElement.dataset.theme).toBe('ink');
    expect(window.localStorage.getItem('e-agent-theme')).toBe('ink');
  });

  it('保存推理和工具策略，并在禁用工具后隐藏安全说明', async () => {
    const transport = transportWith();
    renderSettings(transport);

    fireEvent.change(screen.getByLabelText('推理过程显示方式'), {
      target: { value: 'hidden' },
    });
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ reasoningDisplay: 'hidden' });
    });

    expect(screen.getByText(/命令确认不是 OS 沙箱/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('本地工具'), {
      target: { value: 'disabled' },
    });
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenLastCalledWith({
        toolExecutionPolicy: 'disabled',
      });
    });
    expect(screen.queryByText(/命令确认不是 OS 沙箱/)).not.toBeInTheDocument();
  });

  it('将命令超时和输出上限限制在安全范围内', async () => {
    const transport = transportWith();
    renderSettings(transport);

    const timeout = screen.getByRole('spinbutton', { name: '命令超时（秒）' });
    fireEvent.change(timeout, { target: { value: '999' } });
    fireEvent.blur(timeout);
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ toolCommandTimeoutMs: 300_000 });
    });

    const outputLimit = screen.getByRole('spinbutton', { name: '单次输出上限（KiB）' });
    fireEvent.change(outputLimit, { target: { value: '0' } });
    fireEvent.blur(outputLimit);
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenLastCalledWith({ toolOutputLimitBytes: 4_096 });
    });
  });

  it('保存性能字段和所有布尔偏好', async () => {
    const transport = transportWith();
    renderSettings(transport);

    const concurrency = screen.getByRole('spinbutton', { name: '最大并发请求' });
    fireEvent.change(concurrency, { target: { value: '9' } });
    fireEvent.blur(concurrency);

    const cost = screen.getByRole('spinbutton', { name: '今日成本预警（USD）' });
    fireEvent.change(cost, { target: { value: '12.5' } });
    fireEvent.blur(cost);

    for (const label of ['自动压缩上下文', '自动展开活跃工具', '自动检查更新']) {
      fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(label) }));
    }

    expect(screen.getByRole('checkbox', { name: /Ollama 离线兜底/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /匿名性能遥测/ })).toBeDisabled();

    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ maxConcurrency: 9 });
      expect(transport.updateSettings).toHaveBeenCalledWith({ costAlertThreshold: 12.5 });
      expect(transport.updateSettings).toHaveBeenCalledWith({ autoCompressContext: false });
      expect(transport.updateSettings).toHaveBeenCalledWith({ autoExpandRunningTools: false });
      expect(transport.updateSettings).toHaveBeenCalledWith({ autoUpdate: false });
    });
    expect(transport.updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ ollamaFallback: expect.any(Boolean) }),
    );
    expect(transport.updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ telemetryEnabled: expect.any(Boolean) }),
    );
  });

  it('Web 端明确禁用桌面专属工具设置，桌面端保持可配置', async () => {
    const webTransport = transportWith();
    const { unmount } = render(
      <TransportProvider mode="web" transport={webTransport}>
        <I18nProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </I18nProvider>
      </TransportProvider>,
    );

    expect(screen.getByLabelText('本地工具')).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '命令超时（秒）' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '单次输出上限（KiB）' })).toBeDisabled();
    expect(screen.getByText(/本地文件读取、修改和命令执行仅在桌面端可用/)).toBeInTheDocument();
    expect(screen.getByText(/快捷键重绑即将开放/)).toBeInTheDocument();
    expect(webTransport.updateSettings).not.toHaveBeenCalled();

    unmount();
    const desktopTransport = transportWith();
    renderSettings(desktopTransport, 'desktop');
    expect(screen.getByLabelText('本地工具')).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: '命令超时（秒）' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('本地工具'), {
      target: { value: 'disabled' },
    });
    await waitFor(() => {
      expect(desktopTransport.updateSettings).toHaveBeenCalledWith({
        toolExecutionPolicy: 'disabled',
      });
    });
  });

  it.each(['member', 'viewer'] as const)('%s 只能只读查看全局设置', (role) => {
    const currentSession = useAuthStore.getState().session;
    if (currentSession === null) throw new Error('测试会话未初始化');
    useAuthStore.setState({
      session: {
        ...currentSession,
        user: { ...currentSession.user, role },
      },
    });

    const transport = transportWith();
    renderSettings(transport);

    expect(screen.getByRole('button', { name: '暖阳' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '界面语言' })).toBeDisabled();
    expect(screen.getByLabelText('@code 服务商')).toBeDisabled();
    expect(screen.getByLabelText('@code 模型')).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '最大并发请求' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '今日成本预警（USD）' })).toBeDisabled();
    expect(screen.getByLabelText('推理过程显示方式')).toBeDisabled();
    expect(screen.getByLabelText('本地工具')).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '命令超时（秒）' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '单次输出上限（KiB）' })).toBeDisabled();
    expect(screen.getByText(/工具安全策略由 Owner 或 Admin 管理/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /自动压缩上下文/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /自动展开活跃工具/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /自动检查更新/ })).toBeDisabled();
    expect(transport.updateSettings).not.toHaveBeenCalled();
  });

  it('桌面端可以添加 stdio MCP Server，Web 端仅展示能力边界', async () => {
    const saveMcpServer = vi.fn(async () => ({
      id: 'project-memory',
      displayName: '项目记忆',
      enabled: true,
      transport: 'stdio' as const,
      endpoint: 'npx',
      state: 'connected' as const,
      toolCount: 2,
      tools: ['search', 'read'],
      hasCredentials: false,
    }));
    const desktopTransport = transportWith({
      listMcpServers: vi.fn(async () => []),
      saveMcpServer,
    });
    const { unmount } = render(
      <TransportProvider mode="desktop" transport={desktopTransport}>
        <I18nProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </I18nProvider>
      </TransportProvider>,
    );

    expect(await screen.findByText(/尚未配置 MCP Server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加 Server' }));
    fireEvent.change(screen.getByLabelText('显示名称'), {
      target: { value: '项目记忆' },
    });
    fireEvent.change(screen.getByLabelText('连接方式'), {
      target: { value: 'stdio' },
    });
    fireEvent.change(await screen.findByLabelText('启动命令'), {
      target: { value: 'npx' },
    });
    fireEvent.change(screen.getByLabelText('参数（JSON 数组）'), {
      target: { value: '["-y","example-mcp"]' },
    });
    fireEvent.click(screen.getByLabelText(/我了解：保存会立即启动/));
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith({
        displayName: '项目记忆',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'example-mcp'],
        inheritEnv: false,
      });
    });

    unmount();
    renderSettings(transportWith(), 'web');
    expect(screen.getByText(/MCP 进程与本地工具仅在桌面端运行/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加 Server' })).not.toBeInTheDocument();
  });

  it('运行启动自检并区分通过项与警告项', async () => {
    const runStartupCheck = vi.fn(async () => [
      { name: 'Node.js', ok: true, message: '版本符合要求' },
      { name: '系统密钥环', ok: false, message: '当前环境不可用' },
    ]);
    const transport = transportWith({ runStartupCheck });
    renderSettings(transport);

    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));

    expect(await screen.findByText('版本符合要求')).toBeInTheDocument();
    expect(screen.getByText('当前环境不可用')).toBeInTheDocument();
    expect(screen.getByText('Node.js').closest('.is-ok')).toBeInTheDocument();
    expect(screen.getByText('系统密钥环').closest('.is-warning')).toBeInTheDocument();
  });

  it('启动自检和设置保存失败时显示友好错误', async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error('设置服务离线');
    });
    const runStartupCheck = vi.fn(async () => {
      throw new Error('自检服务离线');
    });
    const transport = transportWith({ updateSettings, runStartupCheck });
    renderSettings(transport);

    fireEvent.change(screen.getByLabelText('推理过程显示方式'), {
      target: { value: 'expanded' },
    });
    await waitFor(() => {
      expect(useToastStore.getState().messages).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          title: '设置保存失败',
          description: '设置服务离线',
        }),
      );
    });
    expect(useSettingsStore.getState().settings.reasoningDisplay).toBe('collapsed');

    fireEvent.click(screen.getByRole('button', { name: '立即检查' }));
    await waitFor(() => {
      expect(useToastStore.getState().messages).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          title: '启动自检失败',
          description: '自检服务离线',
        }),
      );
    });
  });

  it('显示教程完成状态并可重新打开教程', () => {
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, tutorialCompletedVersion: 2 },
    }));
    renderSettings(transportWith());

    expect(screen.getByText('已完成第 2 版教程。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新打开教程' }));
    expect(screen.getByText('教程页已打开')).toBeInTheDocument();
  });
});
