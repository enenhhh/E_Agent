import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageActions } from './MessageActions';

describe('MessageActions', () => {
  afterEach(cleanup);

  it('执行助手常用操作并展示答案版本', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    const onNextVersion = vi.fn().mockResolvedValue(undefined);
    const onPreviousVersion = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn().mockResolvedValue(undefined);

    render(
      <MessageActions
        feedback="positive"
        onCopy={onCopy}
        onFeedback={onFeedback}
        onNextVersion={onNextVersion}
        onPreviousVersion={onPreviousVersion}
        onRetry={onRetry}
        role="assistant"
        version={{ current: 2, total: 3 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith('plain'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());

    const helpfulButton = screen.getByRole('button', { name: '有帮助' });
    expect(helpfulButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(helpfulButton);
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith(null));

    fireEvent.click(screen.getByRole('button', { name: '无帮助' }));
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('negative'));

    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    const previousVersion = screen.getByRole('button', { name: '上一个答案版本' });
    await waitFor(() => expect(previousVersion).toBeEnabled());
    fireEvent.click(previousVersion);
    await waitFor(() => {
      expect(onPreviousVersion).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: '下一个答案版本' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: '下一个答案版本' }));
    await waitFor(() => expect(onNextVersion).toHaveBeenCalledOnce());
  });

  it('支持更多菜单的方向键、Escape、选择与外部关闭', async () => {
    const onBranch = vi.fn();
    const onCopy = vi.fn();
    const onRequestDelete = vi.fn();

    render(
      <div>
        <MessageActions
          onBranch={onBranch}
          onCopy={onCopy}
          onRequestDelete={onRequestDelete}
          role="assistant"
        />
        <button type="button">外部按钮</button>
      </div>,
    );

    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.click(moreButton);
    const menu = screen.getByRole('menu', { name: '更多消息操作' });
    const branchItem = screen.getByRole('menuitem', { name: '从此处开启新对话' });
    const markdownItem = screen.getByRole('menuitem', { name: '复制为 Markdown' });
    const deleteItem = screen.getByRole('menuitem', { name: '删除此消息' });
    await waitFor(() => expect(branchItem).toHaveFocus());

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(markdownItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(deleteItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(branchItem).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(moreButton).toHaveFocus());

    fireEvent.keyDown(moreButton, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '删除此消息' })).toHaveFocus());
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此消息' }));
    expect(onRequestDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制为 Markdown' }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith('markdown'));

    fireEvent.click(moreButton);
    fireEvent.pointerDown(screen.getByRole('button', { name: '外部按钮' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('menuitem', { name: '从此处开启新对话' }));
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it('流式生成时保留复制，但禁用会改变会话的动作', () => {
    render(
      <MessageActions
        mutationDisabled
        onBranch={vi.fn()}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRequestDelete={vi.fn()}
        role="user"
      />,
    );

    expect(screen.getByRole('button', { name: '编辑并重新发送' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getByRole('menuitem', { name: '从此处开启新对话' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '复制为 Markdown' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '删除此消息' })).toBeDisabled();
  });

  it('将异步操作失败交给上层错误处理', async () => {
    const failure = new Error('retry failed');
    const onActionError = vi.fn();

    render(
      <MessageActions
        onActionError={onActionError}
        onRetry={vi.fn().mockRejectedValue(failure)}
        role="assistant"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onActionError).toHaveBeenCalledWith('retry', failure));
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
  });

  it('复制与会话变更分别管理等待状态，不会提前解锁重复操作', async () => {
    let resolveCopy: (() => void) | undefined;
    let resolveRetry: (() => void) | undefined;
    const onCopy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );

    render(<MessageActions onCopy={onCopy} onRetry={onRetry} role="assistant" />);
    const retryButton = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '复制' })).toBeDisabled();

    await act(async () => resolveCopy?.());
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeEnabled());
    expect(retryButton).toBeDisabled();
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledOnce();

    await act(async () => resolveRetry?.());
    await waitFor(() => expect(retryButton).toBeEnabled());
  });

  it('菜单没有可用项时仍可聚焦并用 Escape 关闭', async () => {
    render(
      <MessageActions
        contentAvailable={false}
        mutationDisabled
        onBranch={vi.fn()}
        onCopy={vi.fn()}
        onRequestDelete={vi.fn()}
        role="assistant"
      />,
    );

    const moreButton = screen.getByRole('button', { name: '更多' });
    fireEvent.click(moreButton);
    const menu = screen.getByRole('menu', { name: '更多消息操作' });
    await waitFor(() => expect(menu).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(moreButton).toHaveFocus());
  });
});
