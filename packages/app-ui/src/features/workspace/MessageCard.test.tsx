import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useConversationStore } from '../../stores/conversation-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { AppMode, Message } from '../../types';

import { MessageActions } from './MessageActions';
import { MessageCard } from './MessageCard';

const originalDecideToolCall = useConversationStore.getState().decideToolCall;

function messageWithPendingActions(): Message {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    role: 'assistant',
    content: '',
    createdAt: '2026-07-29T08:00:00.000Z',
    status: 'completed',
    toolCalls: [
      {
        id: 'tool-1',
        name: 'workspace_run_command',
        arguments: '{"executable":"pnpm","args":["test"]}',
        status: 'approval-required',
        metadata: { kind: 'command' },
      },
    ],
    fileChanges: [
      {
        id: 'change-1',
        path: 'src/index.ts',
        diff: '@@ -1 +1 @@\n-old\n+new',
        status: 'pending',
      },
    ],
  };
}

function renderMessage(
  mode: AppMode,
  decideToolCall: typeof originalDecideToolCall,
  onFileDecision = vi.fn(),
): void {
  useConversationStore.setState({ decideToolCall });
  render(
    <TransportProvider mode={mode} transport={{} as EAgentTransport}>
      <MessageCard
        message={messageWithPendingActions()}
        onBranch={vi.fn()}
        onFileDecision={onFileDecision}
      />
    </TransportProvider>,
  );
}

function renderTextMessage(
  message: Message,
  props: Partial<React.ComponentProps<typeof MessageCard>> = {},
): ReturnType<typeof render> {
  return render(
    <TransportProvider mode="desktop" transport={{} as EAgentTransport}>
      <MessageCard message={message} onBranch={vi.fn()} onFileDecision={vi.fn()} {...props} />
    </TransportProvider>,
  );
}

function messageCardView(
  message: Message,
  props: Partial<React.ComponentProps<typeof MessageCard>> = {},
  mode: AppMode = 'desktop',
): React.JSX.Element {
  return (
    <TransportProvider mode={mode} transport={{} as EAgentTransport}>
      <MessageCard message={message} onBranch={vi.fn()} onFileDecision={vi.fn()} {...props} />
    </TransportProvider>
  );
}

function assistantMessage(input: Partial<Message> = {}): Message {
  return {
    id: 'assistant-message',
    conversationId: 'conversation-1',
    role: 'assistant',
    content: '这是生成结果。',
    createdAt: '2026-07-29T08:00:00.000Z',
    status: 'completed',
    ...input,
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('MessageCard local action availability', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'idle', session: null, error: null });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        reasoningDisplay: 'collapsed',
        autoExpandRunningTools: true,
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAuthStore.setState({ status: 'idle', session: null, error: null });
    useConversationStore.setState({ decideToolCall: originalDecideToolCall });
  });

  it('Web 端保留结果和 Diff，但隐藏本机命令与文件审批动作', () => {
    const decideToolCall = vi.fn<typeof originalDecideToolCall>();
    const onFileDecision = vi.fn();
    renderMessage('web', decideToolCall, onFileDecision);

    expect(screen.getByText('本地命令仅可在桌面端的已绑定工作区中执行。')).toBeInTheDocument();
    expect(screen.getByText('本地文件修改仅可在桌面端的已绑定工作区中审批。')).toBeInTheDocument();
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /允许执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接受更改' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument();
    expect(decideToolCall).not.toHaveBeenCalled();
    expect(onFileDecision).not.toHaveBeenCalled();
  });

  it('桌面端保留命令确认和文件 Diff 审批流程', async () => {
    const decideToolCall = vi.fn<typeof originalDecideToolCall>().mockResolvedValue(undefined);
    const onFileDecision = vi.fn();
    renderMessage('desktop', decideToolCall, onFileDecision);

    fireEvent.click(screen.getByRole('button', { name: /允许执行/ }));
    await waitFor(() => {
      expect(decideToolCall).toHaveBeenCalledWith(
        expect.any(Object),
        'conversation-1',
        'tool-1',
        'approve',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '接受更改' }));
    expect(onFileDecision).toHaveBeenCalledWith('change-1', 'accept');
    expect(screen.getByText(/这不是 OS 沙箱/)).toBeInTheDocument();
  });

  it('桌面端对 MCP 和电脑工具复用统一审批入口', async () => {
    const decideToolCall = vi.fn<typeof originalDecideToolCall>().mockResolvedValue(undefined);
    useConversationStore.setState({ decideToolCall });
    renderTextMessage({
      id: 'mcp-message',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-29T08:00:00.000Z',
      status: 'completed',
      toolCalls: [
        {
          id: 'mcp-tool-1',
          name: 'mcp_project_search',
          arguments: '{"query":"architecture"}',
          status: 'approval-required',
          metadata: {
            kind: 'mcp-request',
            serverName: 'Project Memory',
            originalToolName: 'search',
          },
        },
      ],
    });

    expect(screen.getByText(/MCP Server 是外部进程或服务/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /允许执行/ }));
    await waitFor(() => {
      expect(decideToolCall).toHaveBeenCalledWith(
        expect.any(Object),
        'conversation-1',
        'mcp-tool-1',
        'approve',
      );
    });
  });

  it('支持编辑用户消息并用快捷键重新发送', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    renderTextMessage(
      {
        id: 'user-message',
        conversationId: 'conversation-1',
        role: 'user',
        content: '创建一个 API 路由',
        createdAt: '2026-07-29T08:00:00.000Z',
        status: 'completed',
      },
      { onEdit },
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑并重新发送' }));
    const editor = screen.getByRole('textbox', { name: '编辑消息' });
    expect(editor).toHaveValue('创建一个 API 路由');
    fireEvent.change(editor, { target: { value: '创建一个安全的 API 路由' } });
    fireEvent.keyDown(editor, { ctrlKey: true, isComposing: false, key: 'Enter' });

    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith('user-message', '创建一个安全的 API 路由');
      expect(screen.queryByRole('textbox', { name: '编辑消息' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '编辑并重新发送' }));
    fireEvent.change(screen.getByRole('textbox', { name: '编辑消息' }), {
      target: { value: '不保存的修改' },
    });
    const cancelButton = screen.getByRole('button', { name: '取消' });
    cancelButton.focus();
    fireEvent.keyDown(cancelButton, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: '编辑消息' })).not.toBeInTheDocument();
    expect(screen.getByText('创建一个 API 路由')).toBeInTheDocument();
    expect(onEdit).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('article', { name: '你的消息' })).toHaveFocus());
  });

  it('把助手消息动作与删除确认交给上层回调', async () => {
    const onBranch = vi.fn();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    const onNextVersion = vi.fn();
    const onPreviousVersion = vi.fn();
    const onRetry = vi.fn().mockResolvedValue(undefined);

    renderTextMessage(
      {
        id: 'assistant-message',
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '这是生成结果。',
        createdAt: '2026-07-29T08:00:00.000Z',
        status: 'completed',
      },
      {
        onBranch,
        onDelete,
        onFeedback,
        onNextVersion,
        onPreviousVersion,
        onRetry,
        version: { current: 2, total: 3 },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith('assistant-message'));
    fireEvent.click(screen.getByRole('button', { name: '有帮助' }));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('assistant-message', 'positive'));
    fireEvent.click(screen.getByRole('button', { name: '上一个答案版本' }));
    await waitFor(() => {
      expect(onPreviousVersion).toHaveBeenCalledWith('assistant-message');
      expect(screen.getByRole('button', { name: '下一个答案版本' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: '下一个答案版本' }));
    await waitFor(() => expect(onNextVersion).toHaveBeenCalledWith('assistant-message'));

    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从此处开启新对话' }));
    expect(onBranch).toHaveBeenCalledWith('assistant-message');
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled());

    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    const cancelButton = await screen.findByRole('button', { name: '取消' });
    await waitFor(() => expect(cancelButton).toHaveFocus());
    fireEvent.click(cancelButton);
    await waitFor(() => expect(moreButton).toHaveFocus());

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    expect(screen.getByRole('alertdialog', { name: '删除这条消息？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('assistant-message');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it.each([
    ['failed', '失败'],
    ['cancelled', '已停止'],
  ] as const)('%s 助手消息显示状态且允许重试', async (status, statusLabel) => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    renderTextMessage(
      {
        id: `${status}-message`,
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '未完成的回答',
        createdAt: '2026-07-29T08:00:00.000Z',
        status,
      },
      { onRetry },
    );

    expect(screen.getByText(statusLabel)).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: '重试' });
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(`${status}-message`));
  });

  it('会话生成期间禁用旧消息的会话变更动作', () => {
    renderTextMessage(
      {
        id: 'completed-message',
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '已有回答',
        createdAt: '2026-07-29T08:00:00.000Z',
        status: 'completed',
      },
      {
        conversationBusy: true,
        onBranch: vi.fn(),
        onDelete: vi.fn(),
        onRetry: vi.fn(),
      },
    );

    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('menuitem', { name: '从此处开启新对话' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '删除此消息' })).toBeDisabled();
  });

  it('Viewer 只能查看待审批工具，不能批准或拒绝执行', () => {
    useAuthStore.setState({
      status: 'authenticated',
      error: null,
      session: {
        user: {
          id: 'viewer-1',
          name: '只读成员',
          email: 'viewer@example.com',
          role: 'viewer',
          active: true,
        },
        expiresAt: '2026-07-30T08:00:00.000Z',
      },
    });
    const decideToolCall = vi.fn<typeof originalDecideToolCall>();
    const onFileDecision = vi.fn();
    renderMessage('desktop', decideToolCall, onFileDecision);

    expect(screen.getByText('Viewer 角色不能批准或拒绝工具执行。')).toBeInTheDocument();
    expect(screen.getByText('Viewer 角色不能接受或拒绝文件修改。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /允许执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接受更改' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument();
    expect(decideToolCall).not.toHaveBeenCalled();
    expect(onFileDecision).not.toHaveBeenCalled();
  });

  it('按设置折叠、展开和隐藏思考过程，并显示毫秒与秒级耗时', async () => {
    const message = assistantMessage({
      reasoning: '先检查输入，再给出答案。',
      reasoningDurationMs: 13_200,
    });
    const { container, rerender } = render(messageCardView(message));

    let details = container.querySelector<HTMLDetailsElement>('.reasoning-panel');
    expect(screen.getByText('已思考 13s')).toBeInTheDocument();
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(within(details!).getByText('已思考 13s'));
    expect(details).toHaveAttribute('open');

    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, reasoningDisplay: 'expanded' },
    }));
    rerender(
      messageCardView({
        ...message,
        reasoningDurationMs: 420,
      }),
    );
    await waitFor(() => {
      details = container.querySelector<HTMLDetailsElement>('.reasoning-panel');
      expect(details).toHaveAttribute('open');
      expect(screen.getByText('已思考 420ms')).toBeInTheDocument();
    });

    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, reasoningDisplay: 'hidden' },
    }));
    await waitFor(() =>
      expect(container.querySelector('.reasoning-panel')).not.toBeInTheDocument(),
    );

    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, reasoningDisplay: 'collapsed' },
    }));
    rerender(
      messageCardView({
        ...message,
        reasoningDurationMs: undefined,
      }),
    );
    expect(await screen.findByText('思考完成')).toBeInTheDocument();
  });

  it('流式思考始终展开，结束后按折叠设置收起', async () => {
    const streaming = assistantMessage({
      content: '',
      reasoning: '正在分析上下文',
      status: 'streaming',
    });
    const { container, rerender } = render(messageCardView(streaming));
    const details = container.querySelector<HTMLDetailsElement>('.reasoning-panel');

    expect(screen.getByText('正在生成')).toBeInTheDocument();
    expect(screen.getByText('思考中')).toBeInTheDocument();
    expect(details).toHaveAttribute('open');
    expect(container.querySelector('.reasoning-panel--streaming')).not.toBeNull();

    rerender(
      messageCardView({
        ...streaming,
        status: 'completed',
        reasoningDurationMs: -20,
      }),
    );
    await waitFor(() => {
      expect(screen.getByText('已思考 0ms')).toBeInTheDocument();
      expect(details).not.toHaveAttribute('open');
    });
  });

  it('无正文流式消息显示等待动画，但已有思考或工具调用时不重复显示', () => {
    const { container, rerender } = render(
      messageCardView(assistantMessage({ content: '', status: 'pending' })),
    );
    expect(container.querySelector('.message-card__thinking')).not.toBeNull();
    expect(screen.getByRole('button', { name: '复制' })).toBeDisabled();

    rerender(
      messageCardView(
        assistantMessage({
          content: '',
          reasoning: '已有推理',
          status: 'pending',
        }),
      ),
    );
    expect(container.querySelector('.message-card__thinking')).toBeNull();

    rerender(
      messageCardView(
        assistantMessage({
          content: '',
          status: 'streaming',
          toolCalls: [
            {
              id: 'running-tool',
              name: 'workspace_read_file',
              arguments: '{"path":"README.md"}',
              status: 'running',
            },
          ],
        }),
      ),
    );
    expect(container.querySelector('.message-card__thinking')).toBeNull();
  });

  it('编辑失败时保留草稿、显示错误并通知上层', async () => {
    const firstError = new Error('服务器拒绝了这次编辑');
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce('unknown edit failure');
    const onActionError = vi.fn();
    renderTextMessage(
      {
        id: 'edit-error-message',
        conversationId: 'conversation-1',
        role: 'user',
        content: '原始消息',
        createdAt: '2026-07-29T08:00:00.000Z',
        status: 'completed',
      },
      { onActionError, onEdit },
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑并重新发送' }));
    const editor = screen.getByRole('textbox', { name: '编辑消息' });
    fireEvent.change(editor, { target: { value: '第一次修改' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑并重新发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器拒绝了这次编辑');
    expect(onActionError).toHaveBeenCalledWith('edit', firstError);
    expect(editor).toHaveValue('第一次修改');

    fireEvent.change(editor, { target: { value: '第二次修改' } });
    fireEvent.submit(editor.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法重新发送，请重试。');
    expect(onActionError).toHaveBeenLastCalledWith('edit', 'unknown edit failure');
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it('编辑提交期间忽略取消，并支持 Meta+Enter 与输入法保护', async () => {
    let finishEdit: (() => void) | undefined;
    const onEdit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishEdit = resolve;
        }),
    );
    renderTextMessage(
      {
        id: 'pending-edit-message',
        conversationId: 'conversation-1',
        role: 'user',
        content: '原始消息',
        createdAt: '2026-07-29T08:00:00.000Z',
        status: 'completed',
      },
      { onEdit },
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑并重新发送' }));
    const editor = screen.getByRole('textbox', { name: '编辑消息' });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: '新的消息' } });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, isComposing: false });
    await waitFor(() => expect(onEdit).toHaveBeenCalledOnce());
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.getByRole('textbox', { name: '编辑消息' })).toBeInTheDocument();

    await act(async () => finishEdit?.());
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '编辑消息' })).not.toBeInTheDocument(),
    );
  });

  it('支持自定义复制、Markdown 复制、剪贴板兜底和复制错误回调', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const onActionError = vi.fn();
    const { unmount } = renderTextMessage(assistantMessage(), { onActionError, onCopy });

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => {
      expect(onCopy).toHaveBeenCalledWith('assistant-message', '这是生成结果。', 'plain');
      expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '复制为 Markdown' }));
    await waitFor(() =>
      expect(onCopy).toHaveBeenLastCalledWith('assistant-message', '这是生成结果。', 'markdown'),
    );
    unmount();

    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderTextMessage(assistantMessage({ id: 'clipboard-message' }));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('这是生成结果。'));
    cleanup();

    const copyError = new Error('clipboard unavailable');
    renderTextMessage(assistantMessage(), {
      onActionError,
      onCopy: vi.fn().mockRejectedValue(copyError),
    });
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(onActionError).toHaveBeenLastCalledWith('copy', copyError));
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled();
  });

  it('重试、反馈、分支和版本失败都通过统一错误回调报告', async () => {
    const onActionError = vi.fn();
    const errors = {
      retry: new Error('retry failed'),
      feedback: new Error('feedback failed'),
      branch: new Error('branch failed'),
      version: new Error('version failed'),
    };
    renderTextMessage(assistantMessage(), {
      feedback: 'positive',
      onActionError,
      onBranch: vi.fn().mockRejectedValue(errors.branch),
      onFeedback: vi.fn().mockRejectedValue(errors.feedback),
      onPreviousVersion: vi.fn().mockRejectedValue(errors.version),
      onRetry: vi.fn().mockRejectedValue(errors.retry),
      version: { current: 2, total: 3 },
    });

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('retry', errors.retry));
    fireEvent.click(screen.getByRole('button', { name: '有帮助' }));
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('feedback', errors.feedback));
    fireEvent.click(screen.getByRole('button', { name: '上一个答案版本' }));
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('version', errors.version));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从此处开启新对话' }));
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('branch', errors.branch));
  });

  it('反馈按钮支持取消既有选择，版本边界和缺失回调会禁用导航', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderTextMessage(assistantMessage(), {
      feedback: 'negative',
      onFeedback,
      onPreviousVersion: vi.fn(),
      version: { current: 1, total: 3 },
    });

    expect(screen.getByRole('button', { name: '无帮助' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '无帮助' }));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('assistant-message', null));
    expect(screen.getByRole('button', { name: '上一个答案版本' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一个答案版本' })).toBeDisabled();
    unmount();

    renderTextMessage(assistantMessage(), {
      onNextVersion: vi.fn(),
      version: { current: 3, total: 3 },
    });
    expect(screen.getByRole('button', { name: '下一个答案版本' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一个答案版本' })).toBeDisabled();
  });

  it('更多菜单支持键盘循环、首尾跳转、Escape、Tab 和外部点击关闭', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    renderTextMessage(assistantMessage(), {
      onBranch: vi.fn(),
      onCopy,
      onDelete: vi.fn(),
    });
    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.keyDown(moreButton, { key: 'ArrowDown' });
    let menu = screen.getByRole('menu', { name: '更多消息操作' });
    const items = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(moreButton).toHaveFocus();
    });

    fireEvent.keyDown(moreButton, { key: 'ArrowUp' });
    menu = screen.getByRole('menu', { name: '更多消息操作' });
    await waitFor(() => expect(within(menu).getAllByRole('menuitem').at(-1)).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(moreButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    vi.spyOn(moreButton, 'getBoundingClientRect').mockReturnValue({
      bottom: 320,
      height: 20,
      left: 0,
      right: 20,
      top: 300,
      width: 20,
      x: 0,
      y: 300,
      toJSON: () => ({}),
    });
    fireEvent.click(moreButton);
    expect(screen.getByRole('menu')).toHaveClass('message-actions__menu--up');
    fireEvent.click(moreButton);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('空内容且生成禁用时，更多菜单无可聚焦动作并保持所有变更动作禁用', async () => {
    renderTextMessage(assistantMessage({ content: '' }), {
      conversationBusy: true,
      onBranch: vi.fn(),
      onDelete: vi.fn(),
    });

    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.keyDown(moreButton, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: '更多消息操作' });
    await waitFor(() => expect(menu).toHaveFocus());
    expect(within(menu).getAllByRole('menuitem')).toSatisfy((items: HTMLElement[]) =>
      items.every((item) => item.hasAttribute('disabled')),
    );
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(menu).toHaveFocus();
  });

  it('删除失败显示错误，支持焦点约束、Escape 与点击遮罩取消', async () => {
    const deleteError = new Error('消息仍被引用');
    const onActionError = vi.fn();
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(deleteError)
      .mockRejectedValueOnce('unknown delete failure');
    renderTextMessage(assistantMessage(), { onActionError, onDelete });
    const moreButton = screen.getByRole('button', { name: '更多' });

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    const dialog = screen.getByRole('alertdialog');
    const cancelButton = within(dialog).getByRole('button', { name: '取消' });
    const deleteButton = within(dialog).getByRole('button', { name: '删除' });
    await waitFor(() => expect(cancelButton).toHaveFocus());
    cancelButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(deleteButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancelButton).toHaveFocus();

    fireEvent.click(deleteButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('消息仍被引用');
    expect(onActionError).toHaveBeenCalledWith('delete', deleteError);
    fireEvent.click(deleteButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败，请重试。');
    expect(onActionError).toHaveBeenLastCalledWith('delete', 'unknown delete failure');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(moreButton).toHaveFocus();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    const backdrop = document.querySelector<HTMLElement>('.message-delete-backdrop');
    fireEvent.mouseDown(backdrop!);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('删除请求进行中锁定对话框并忽略 Escape 与遮罩点击', async () => {
    let finishDelete: (() => void) | undefined;
    const onDelete = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    renderTextMessage(assistantMessage(), { onDelete });
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'true'));

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.message-delete-backdrop')!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await act(async () => finishDelete?.());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('运行中的工具按设置自动展开，拒绝审批和 Diff 拒绝会调用对应入口', async () => {
    const decideToolCall = vi.fn<typeof originalDecideToolCall>().mockResolvedValue(undefined);
    const onFileDecision = vi.fn();
    useConversationStore.setState({ decideToolCall });
    const runningMessage = assistantMessage({
      content: '',
      toolCalls: [
        {
          id: 'running-tool',
          name: 'workspace_read_file',
          arguments: '{"path":"README.md"}',
          status: 'running',
          result: '读取中',
        },
      ],
    });
    const { container, unmount } = renderTextMessage(runningMessage);
    expect(container.querySelector('.tool-result-card')).toHaveAttribute('open');
    unmount();

    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, autoExpandRunningTools: false },
    }));
    const collapsed = renderTextMessage(runningMessage);
    expect(collapsed.container.querySelector('.tool-result-card')).not.toHaveAttribute('open');
    collapsed.unmount();

    renderMessage('desktop', decideToolCall, onFileDecision);
    const rejectButtons = screen.getAllByRole('button', { name: '拒绝' });
    fireEvent.click(rejectButtons[0]!);
    await waitFor(() =>
      expect(decideToolCall).toHaveBeenCalledWith(
        expect.any(Object),
        'conversation-1',
        'tool-1',
        'reject',
      ),
    );
    fireEvent.click(rejectButtons.at(-1)!);
    expect(onFileDecision).toHaveBeenCalledWith('change-1', 'reject');
  });

  it('Web 端为非命令工具显示通用桌面运行时提示', () => {
    render(
      messageCardView(
        assistantMessage({
          content: '',
          toolCalls: [
            {
              id: 'external-tool',
              name: 'computer_list_processes',
              arguments: '{}',
              status: 'approval-required',
            },
          ],
        }),
        {},
        'web',
      ),
    );

    expect(screen.getByText('需要桌面端本地运行时才能批准并执行此工具调用。')).toBeInTheDocument();
  });

  it('展示工具消息身份、模型与用量耗时，并在零输出时显示兜底值', () => {
    renderTextMessage({
      id: 'tool-message',
      conversationId: 'conversation-1',
      role: 'tool',
      content: '工具返回结果',
      model: 'Qwen3.6-35B-A3B',
      createdAt: '2026-07-29T08:00:00.000Z',
      status: 'completed',
      inputTokens: 128,
      outputTokens: 0,
      latencyMs: 1_250,
    });

    expect(screen.getByRole('article', { name: '工具消息' })).toBeInTheDocument();
    expect(screen.getByText('Qwen3.6-35B-A3B')).toBeInTheDocument();
    expect(screen.getByText(/128 输入 · 0 输出/)).toBeInTheDocument();
    expect(screen.getByText('1.25 s')).toBeInTheDocument();
    expect(screen.queryByText(/思考/)).not.toBeInTheDocument();
  });

  it('MessageActions 没有任何可用动作时不渲染，并忽略单一版本', () => {
    const { container, rerender } = render(<MessageActions role="tool" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<MessageActions role="assistant" version={{ current: 1, total: 1 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
