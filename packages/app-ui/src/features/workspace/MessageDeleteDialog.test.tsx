import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageDeleteDialog } from './MessageDeleteDialog';

describe('MessageDeleteDialog', () => {
  afterEach(cleanup);

  it('展示副作用警告、约束焦点，并通过 Escape 取消', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">打开菜单</button>
        <MessageDeleteDialog onCancel={onCancel} onConfirm={onConfirm} open={false} />
      </>,
    );
    const origin = screen.getByRole('button', { name: '打开菜单' });
    origin.focus();

    rerender(
      <>
        <button type="button">打开菜单</button>
        <MessageDeleteDialog onCancel={onCancel} onConfirm={onConfirm} open />
      </>,
    );

    const dialog = screen.getByRole('alertdialog', { name: '删除这条消息？' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      screen.getByText('此消息及其后的内容将被移除，可从自动快照恢复聊天记录。'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('已写入的文件、已执行的命令或其他外部操作不会回滚。'),
    ).toBeInTheDocument();

    const cancelButton = screen.getByRole('button', { name: '取消' });
    const deleteButton = screen.getByRole('button', { name: '删除' });
    await waitFor(() => expect(cancelButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(deleteButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <>
        <button type="button">打开菜单</button>
        <MessageDeleteDialog onCancel={onCancel} onConfirm={onConfirm} open={false} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '打开菜单' })).toHaveFocus());
  });

  it('确认期间阻止重复提交', async () => {
    let resolveConfirm: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(<MessageDeleteDialog onCancel={vi.fn()} onConfirm={onConfirm} open />);
    const deleteButton = screen.getByRole('button', { name: '删除' });

    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(deleteButton).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-busy', 'true');

    resolveConfirm?.();
    await waitFor(() => expect(deleteButton).toBeEnabled());
  });

  it('显示确认失败并恢复操作能力', async () => {
    const failure = new Error('服务暂时不可用');
    const onError = vi.fn();

    render(
      <MessageDeleteDialog
        onCancel={vi.fn()}
        onConfirm={vi.fn().mockRejectedValue(failure)}
        onError={onError}
        open
      />,
    );

    const deleteButton = screen.getByRole('button', { name: '删除' });
    fireEvent.click(deleteButton);

    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
    expect(onError).toHaveBeenCalledWith(failure);
    expect(deleteButton).toBeEnabled();
  });
});
