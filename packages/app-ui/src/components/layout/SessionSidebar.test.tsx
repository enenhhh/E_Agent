import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../context/I18nContext';
import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useConversationStore } from '../../stores/conversation-store';
import { useToastStore } from '../../stores/toast-store';
import type { Conversation, WorkspaceBinding } from '../../types';

import { SessionSidebar } from './SessionSidebar';

const originalConversationActions = {
  createConversation: useConversationStore.getState().createConversation,
  selectConversation: useConversationStore.getState().selectConversation,
  updateConversation: useConversationStore.getState().updateConversation,
  deleteConversation: useConversationStore.getState().deleteConversation,
};

function conversation(
  id: string,
  title: string,
  updatedAt: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title,
    pinned: false,
    archived: false,
    updatedAt,
    branchCount: 0,
    messageCount: 0,
    ...overrides,
  };
}

function renderSidebar({
  collapsed = false,
  mode = 'desktop',
  onCollapse = vi.fn(),
  transport = {} as EAgentTransport,
}: {
  collapsed?: boolean;
  mode?: 'desktop' | 'web';
  onCollapse?: () => void;
  transport?: EAgentTransport;
} = {}): void {
  render(
    <TransportProvider mode={mode} transport={transport}>
      <I18nProvider>
        <MemoryRouter>
          <SessionSidebar collapsed={collapsed} onCollapse={onCollapse} />
        </MemoryRouter>
      </I18nProvider>
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('SessionSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('e-agent-locale', 'en-US');
    useConversationStore.setState({
      conversations: [],
      selectedId: null,
      createConversation: originalConversationActions.createConversation,
      selectConversation: originalConversationActions.selectConversation,
      updateConversation: originalConversationActions.updateConversation,
      deleteConversation: originalConversationActions.deleteConversation,
    });
    useToastStore.setState({ messages: [] });
  });

  it('收起时只保留不可访问的占位侧栏', () => {
    renderSidebar({ collapsed: true, mode: 'web' });

    const sidebar = document.querySelector('.session-sidebar');
    expect(sidebar).toHaveClass('session-sidebar--collapsed');
    expect(sidebar).toHaveAttribute('aria-hidden');
  });

  it('会话摘要刷新后立即显示自动生成的标题', async () => {
    const current = conversation('live-generated-title', '新会话', new Date().toISOString());
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
    });
    renderSidebar({ mode: 'web' });
    expect(document.querySelector('.session-row__title')).toHaveTextContent('新会话');

    act(() => {
      useConversationStore.setState({
        conversations: [{ ...current, title: '修复登录状态竞态' }],
      });
    });

    await waitFor(() =>
      expect(document.querySelector('.session-row__title')).toHaveTextContent('修复登录状态竞态'),
    );
  });

  it('分组、筛选会话并触发选择、置顶、归档、新建和收起操作', async () => {
    const today = new Date().toISOString();
    const earlier = '2020-01-02T03:04:00.000Z';
    const selectConversation = vi.fn().mockResolvedValue(undefined);
    const updateConversation = vi.fn().mockResolvedValue(undefined);
    const createConversation = vi.fn().mockResolvedValue('new-conversation');
    const onCollapse = vi.fn();
    useConversationStore.setState({
      conversations: [
        conversation('today-1', 'Current task', today, { pinned: true }),
        conversation('earlier-1', 'Legacy task', earlier),
        conversation('archived-1', 'Archived task', today, { archived: true }),
      ],
      selectedId: 'today-1',
      selectConversation,
      updateConversation,
      createConversation,
    });
    const getWorkspaceBinding = vi.fn().mockResolvedValue(null);
    const transport = { getWorkspaceBinding } as unknown as EAgentTransport;

    renderSidebar({ transport, onCollapse });

    await waitFor(() => expect(getWorkspaceBinding).toHaveBeenCalledOnce());
    const rows = document.querySelectorAll('.session-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('is-active');
    expect(document.querySelectorAll('.session-group')[0]).toHaveTextContent('Current task');
    expect(document.querySelectorAll('.session-group')[1]).toHaveTextContent('Legacy task');

    fireEvent.click(rows[1]!.querySelector<HTMLButtonElement>('.session-row__select')!);
    expect(selectConversation).toHaveBeenCalledWith(transport, 'earlier-1');

    const activeActions = rows[0]!.querySelectorAll<HTMLButtonElement>(
      '.session-row__actions button',
    );
    fireEvent.click(activeActions[0]!);
    fireEvent.click(activeActions[1]!);
    expect(updateConversation).toHaveBeenNthCalledWith(1, transport, 'today-1', {
      pinned: false,
    });
    expect(updateConversation).toHaveBeenNthCalledWith(2, transport, 'today-1', {
      archived: true,
    });

    fireEvent.change(document.querySelector('input[type="search"]')!, {
      target: { value: ' legacy ' },
    });
    expect(document.querySelectorAll('.session-row')).toHaveLength(1);
    expect(document.querySelector('.session-row')).toHaveTextContent('Legacy task');

    fireEvent.change(document.querySelector('input[type="search"]')!, {
      target: { value: 'not found' },
    });
    expect(document.querySelector('.session-sidebar__empty')).toBeInTheDocument();
    expect(document.querySelector('.session-sidebar__empty button')).not.toBeInTheDocument();

    fireEvent.change(document.querySelector('input[type="search"]')!, {
      target: { value: '' },
    });
    fireEvent.click(
      document.querySelectorAll<HTMLButtonElement>('.session-sidebar__header button')[0]!,
    );
    fireEvent.click(
      document.querySelectorAll<HTMLButtonElement>('.session-sidebar__header button')[1]!,
    );
    expect(createConversation).toHaveBeenCalledWith(transport);
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it('空列表提供新建入口，并容忍工作区读取失败', async () => {
    const createConversation = vi.fn().mockResolvedValue('new-conversation');
    useConversationStore.setState({ createConversation });
    const transport = {
      getWorkspaceBinding: vi.fn().mockRejectedValue(new Error('unavailable')),
    } as unknown as EAgentTransport;

    renderSidebar({ transport });

    await waitFor(() => expect(transport.getWorkspaceBinding).toHaveBeenCalledOnce());
    const empty = document.querySelector('.session-sidebar__empty')!;
    fireEvent.click(empty.querySelector('button')!);
    expect(createConversation).toHaveBeenCalledWith(transport);
  });

  it('支持快捷搜索以及更多菜单中的重命名和删除', async () => {
    const current = conversation('conversation-actions', 'Action task', new Date().toISOString());
    const updateConversation = vi.fn().mockResolvedValue(undefined);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      updateConversation,
      deleteConversation,
    });
    const transport = {} as EAgentTransport;

    renderSidebar({ mode: 'web', transport });
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    expect(search).toHaveFocus();

    const moreButton = document.querySelectorAll<HTMLButtonElement>(
      '.session-row__actions > button',
    )[2]!;
    fireEvent.click(moreButton);
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.session-row__menu button')).find(
        (button) => button.textContent?.includes('重命名'),
      )!,
    );
    const renameInput = document.querySelector<HTMLInputElement>('.session-rename-field input')!;
    fireEvent.change(renameInput, { target: { value: 'Renamed task' } });
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.modal__footer button')).find(
        (button) => button.textContent?.includes('保存'),
      )!,
    );
    await waitFor(() =>
      expect(updateConversation).toHaveBeenCalledWith(transport, current.id, {
        title: 'Renamed task',
      }),
    );

    fireEvent.click(moreButton);
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.session-row__menu button')).find(
        (button) => button.textContent?.includes('删除会话'),
      )!,
    );
    fireEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.modal__footer button')).find(
        (button) => button.textContent?.includes('删除会话'),
      )!,
    );
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith(transport, current.id));
  });

  it('绑定本地工作区后展示路径并发送成功通知', async () => {
    const binding = {
      id: 'binding-1',
      name: 'QA Workspace',
      root: 'D:\\qa-workspace',
    } as WorkspaceBinding;
    const transport = {
      getWorkspaceBinding: vi.fn().mockResolvedValue(null),
      chooseWorkspace: vi.fn().mockResolvedValue(binding),
    } as unknown as EAgentTransport;

    renderSidebar({ transport });
    fireEvent.click(document.querySelector('.session-sidebar__workspace')!);

    await waitFor(() => {
      expect(document.querySelector('.session-sidebar__workspace')).toHaveTextContent(
        'QA Workspace',
      );
    });
    expect(document.querySelector('.session-sidebar__workspace')).toHaveAttribute(
      'title',
      binding.root,
    );
    expect(useToastStore.getState().messages.at(-1)).toMatchObject({
      kind: 'success',
      description: binding.root,
    });
  });

  it('取消选择不发送通知，绑定异常则提供 Error 或未知错误提示', async () => {
    const chooseWorkspace = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockRejectedValueOnce('denied');
    const transport = {
      getWorkspaceBinding: vi.fn().mockResolvedValue(null),
      chooseWorkspace,
    } as unknown as EAgentTransport;

    renderSidebar({ transport });
    const workspaceButton = document.querySelector('.session-sidebar__workspace')!;
    fireEvent.click(workspaceButton);
    await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledTimes(1));
    expect(useToastStore.getState().messages).toHaveLength(0);

    fireEvent.click(workspaceButton);
    await waitFor(() => {
      expect(useToastStore.getState().messages.at(-1)).toMatchObject({
        kind: 'error',
        description: 'permission denied',
      });
    });

    fireEvent.click(workspaceButton);
    await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledTimes(3));
    expect(useToastStore.getState().messages.at(-1)).toMatchObject({
      kind: 'error',
      description: undefined,
    });
  });

  it('Web 模式禁用本地工作区选择且不读取桌面绑定', () => {
    const transport = {
      getWorkspaceBinding: vi.fn(),
      chooseWorkspace: vi.fn(),
    } as unknown as EAgentTransport;

    renderSidebar({ mode: 'web', transport });

    expect(document.querySelector('.session-sidebar__workspace')).toBeDisabled();
    expect(transport.getWorkspaceBinding).not.toHaveBeenCalled();
    expect(transport.chooseWorkspace).not.toHaveBeenCalled();
  });
});
