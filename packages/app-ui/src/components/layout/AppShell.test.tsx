import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useConversationStore } from '../../stores/conversation-store';
import { useModelStore } from '../../stores/model-store';
import { useSettingsStore } from '../../stores/settings-store';

import { AppShell } from './AppShell';

vi.mock('./NavigationRail', () => ({
  NavigationRail: () => <aside data-testid="navigation-rail" />,
}));

vi.mock('./SessionSidebar', () => ({
  SessionSidebar: ({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: () => void }) => (
    <aside data-collapsed={String(collapsed)} data-testid="session-sidebar">
      <button onClick={onCollapse} type="button">
        收起测试侧栏
      </button>
    </aside>
  ),
}));

vi.mock('./TopBar', () => ({
  TopBar: ({
    onOpenSidebar,
    sidebarCollapsed,
  }: {
    onOpenSidebar: () => void;
    sidebarCollapsed: boolean;
  }) => (
    <header data-collapsed={String(sidebarCollapsed)} data-testid="top-bar">
      <button onClick={onOpenSidebar} type="button">
        展开测试侧栏
      </button>
    </header>
  ),
}));

vi.mock('./StatusBar', () => ({
  StatusBar: () => <footer data-testid="status-bar" />,
}));

vi.mock('../ui/ToastViewport', () => ({
  ToastViewport: () => <div data-testid="toast-viewport" />,
}));

const originalLoadModels = useModelStore.getState().load;
const originalLoadSettings = useSettingsStore.getState().load;
const originalLoadConversations = useConversationStore.getState().loadConversations;
const originalRefreshQueue = useConversationStore.getState().refreshQueue;
const originalCreateConversation = useConversationStore.getState().createConversation;

interface MatchMediaController {
  dispatch: (matches: boolean) => void;
}

function installMatchMedia(initialMatches: boolean): MatchMediaController {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: initialMatches,
      media: '(max-width: 980px)',
      onchange: null,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return {
    dispatch: (matches) => {
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
  };
}

function renderShell(transport = {} as EAgentTransport): void {
  render(
    <TransportProvider mode="web" transport={transport}>
      <MemoryRouter initialEntries={['/workspace']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route element={<div>工作区内容</div>} path="/workspace" />
          </Route>
        </Routes>
      </MemoryRouter>
    </TransportProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AppShell', () => {
  beforeEach(() => {
    installMatchMedia(false);
    useModelStore.setState({ load: originalLoadModels });
    useSettingsStore.setState({ load: originalLoadSettings });
    useConversationStore.setState({
      loadConversations: originalLoadConversations,
      refreshQueue: originalRefreshQueue,
      createConversation: originalCreateConversation,
    });
  });

  it('启动时加载基础数据、渲染路由内容并定时刷新队列', async () => {
    vi.useFakeTimers();
    const loadModels = vi.fn(async () => undefined);
    const loadSettings = vi.fn(async () => undefined);
    const loadConversations = vi.fn(async () => undefined);
    const refreshQueue = vi.fn(async () => undefined);
    useModelStore.setState({ load: loadModels });
    useSettingsStore.setState({ load: loadSettings });
    useConversationStore.setState({ loadConversations, refreshQueue });
    const transport = {} as EAgentTransport;

    renderShell(transport);

    expect(screen.getByText('工作区内容')).toBeInTheDocument();
    expect(screen.getByTestId('navigation-rail')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('toast-viewport')).toBeInTheDocument();
    expect(loadModels).toHaveBeenCalledWith(transport);
    expect(loadSettings).toHaveBeenCalledWith(transport);
    expect(loadConversations).toHaveBeenCalledWith(transport);
    expect(refreshQueue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshQueue).toHaveBeenCalledTimes(2);
  });

  it('支持按钮和 Ctrl+B 快捷键收起、展开会话栏', () => {
    useModelStore.setState({ load: vi.fn(async () => undefined) });
    useSettingsStore.setState({ load: vi.fn(async () => undefined) });
    useConversationStore.setState({
      loadConversations: vi.fn(async () => undefined),
      refreshQueue: vi.fn(async () => undefined),
    });
    renderShell();

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'false');
    fireEvent.click(screen.getByRole('button', { name: '收起测试侧栏' }));
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'true');

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByTestId('top-bar')).toHaveAttribute('data-collapsed', 'false');
  });

  it('Ctrl+Shift+N 新建会话，其他按键不会误触发', () => {
    const createConversation = vi.fn(async () => 'conversation-new');
    useModelStore.setState({ load: vi.fn(async () => undefined) });
    useSettingsStore.setState({ load: vi.fn(async () => undefined) });
    useConversationStore.setState({
      loadConversations: vi.fn(async () => undefined),
      refreshQueue: vi.fn(async () => undefined),
      createConversation,
    });
    const transport = {} as EAgentTransport;
    renderShell(transport);

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(createConversation).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true });
    expect(createConversation).toHaveBeenCalledWith(transport);
  });

  it('紧凑视口默认收起，并在视口变窄时自动收起', () => {
    const compact = installMatchMedia(true);
    useModelStore.setState({ load: vi.fn(async () => undefined) });
    useSettingsStore.setState({ load: vi.fn(async () => undefined) });
    useConversationStore.setState({
      loadConversations: vi.fn(async () => undefined),
      refreshQueue: vi.fn(async () => undefined),
    });
    renderShell();

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '展开测试侧栏' }));
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'false');

    act(() => compact.dispatch(true));
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'true');
    act(() => compact.dispatch(false));
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'true');
  });

  it('浏览器不支持媒体查询时仍可正常启动', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    });
    useModelStore.setState({ load: vi.fn(async () => undefined) });
    useSettingsStore.setState({ load: vi.fn(async () => undefined) });
    useConversationStore.setState({
      loadConversations: vi.fn(async () => undefined),
      refreshQueue: vi.fn(async () => undefined),
    });

    renderShell();

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-collapsed', 'false');
  });
});
