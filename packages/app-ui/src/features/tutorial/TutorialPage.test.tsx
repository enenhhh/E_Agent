import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';

import { TUTORIAL_VERSION, TutorialPage } from './TutorialPage';

afterEach(cleanup);

describe('TutorialPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, tutorialCompletedVersion: 0 },
      loading: false,
      error: null,
    }));
    useToastStore.setState({ messages: [] });
  });

  it('浏览七个步骤并在完成后保存教程版本', async () => {
    const updateSettings = vi.fn(async (input: Record<string, unknown>) => ({
      ...useSettingsStore.getState().settings,
      ...input,
    }));
    const transport = { updateSettings } as unknown as EAgentTransport;

    render(
      <TransportProvider mode="web" transport={transport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <Routes>
            <Route element={<TutorialPage />} path="/tutorial" />
            <Route element={<div>工作台已打开</div>} path="/workspace" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    expect(screen.getByRole('heading', { name: '从一枚安全的密钥开始' })).toBeInTheDocument();
    for (let index = 0; index < 6; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    }
    expect(screen.getByRole('heading', { name: '看得见成本，也掌握每次执行' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /完成并进入工作台/ }));
    await waitFor(() => {
      expect(screen.getByText('工作台已打开')).toBeInTheDocument();
    });
    expect(updateSettings).toHaveBeenCalledWith({
      tutorialCompletedVersion: TUTORIAL_VERSION,
    });
    expect(useSettingsStore.getState().settings.tutorialCompletedVersion).toBe(TUTORIAL_VERSION);
  }, 10_000);

  it('保存失败时停留在教程并显示友好错误', async () => {
    const transport = {
      updateSettings: async () => {
        throw new Error('无法保存设置');
      },
    } as unknown as EAgentTransport;

    render(
      <TransportProvider mode="web" transport={transport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <Routes>
            <Route element={<TutorialPage />} path="/tutorial" />
            <Route element={<div>工作台已打开</div>} path="/workspace" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存设置');
    expect(screen.queryByText('工作台已打开')).not.toBeInTheDocument();
  });

  it('可以直接选择步骤、查看最后一步指标并返回上一步', () => {
    render(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <TutorialPage />
        </MemoryRouter>
      </TransportProvider>,
    );

    const previousButton = screen.getByRole('button', { name: /上一步/ });
    expect(previousButton).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '前往第 7 步：保持可控' }));

    expect(screen.getByRole('heading', { name: '看得见成本，也掌握每次执行' })).toBeInTheDocument();
    expect(screen.getByText('成本可追踪')).toBeInTheDocument();
    expect(screen.getByText('执行可确认')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /完成并进入工作台/ })).toBeInTheDocument();

    fireEvent.click(previousButton);
    expect(
      screen.getByRole('heading', { name: '像使用 Codex 一样探索不同解法' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeInTheDocument();
  });

  it('步骤操作按钮会导航到目标页，并为工作台附带教程预览状态', () => {
    function WorkspaceState(): React.JSX.Element {
      const location = useLocation();
      return <div>教程预览：{String(location.state?.tutorialPreview)}</div>;
    }

    render(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <Routes>
            <Route element={<TutorialPage />} path="/tutorial" />
            <Route element={<WorkspaceState />} path="/workspace" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '前往第 3 步：提供上下文' }));
    fireEvent.click(screen.getByRole('button', { name: /进入工作台/ }));

    expect(screen.getByText('教程预览：true')).toBeInTheDocument();
  });

  it('跳过教程保存期间禁用操作，成功后发送提示并跳转', async () => {
    let resolveUpdate:
      | ((settings: ReturnType<typeof useSettingsStore.getState>['settings']) => void)
      | undefined;
    const updateSettings = vi.fn(
      () =>
        new Promise<ReturnType<typeof useSettingsStore.getState>['settings']>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const transport = { updateSettings } as unknown as EAgentTransport;

    render(
      <TransportProvider mode="web" transport={transport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <Routes>
            <Route element={<TutorialPage />} path="/tutorial" />
            <Route element={<div>工作台已打开</div>} path="/workspace" />
          </Routes>
        </MemoryRouter>
      </TransportProvider>,
    );

    const skipButton = screen.getByRole('button', { name: '跳过教程' });
    fireEvent.click(skipButton);
    expect(skipButton).toBeDisabled();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();

    resolveUpdate?.({
      ...useSettingsStore.getState().settings,
      tutorialCompletedVersion: TUTORIAL_VERSION,
    });

    expect(await screen.findByText('工作台已打开')).toBeInTheDocument();
    expect(useToastStore.getState().messages.at(-1)).toMatchObject({
      kind: 'success',
      title: '准备完成',
    });
  });

  it('非 Error 类型的保存失败使用默认错误文案', async () => {
    const transport = {
      updateSettings: async () => Promise.reject('offline'),
    } as unknown as EAgentTransport;

    render(
      <TransportProvider mode="web" transport={transport}>
        <MemoryRouter initialEntries={['/tutorial']}>
          <TutorialPage />
        </MemoryRouter>
      </TransportProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('教程状态保存失败。');
    expect(screen.getByRole('button', { name: '跳过教程' })).not.toBeDisabled();
  });
});
