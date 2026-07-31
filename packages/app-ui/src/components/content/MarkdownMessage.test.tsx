import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownMessage } from './MarkdownMessage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function installClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('MarkdownMessage', () => {
  it('渲染 GFM、内联代码与安全的新窗口链接', () => {
    const { container } = render(
      <MarkdownMessage
        content={'查看 [文档](https://example.com) 和 `const value = 1`。\n\n~~旧内容~~'}
      />,
    );

    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('rel', 'noreferrer');
    expect(container.querySelector('.inline-code')).toHaveTextContent('const value = 1');
    expect(container.querySelector('del')).toHaveTextContent('旧内容');
  });

  it('复制代码后短暂显示成功状态并自动复位', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    const { container } = render(<MarkdownMessage content={'```ts\nconst answer = 42;\n```'} />);

    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(container.querySelector('.lucide-copy')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    expect(container.querySelector('.lucide-check')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(container.querySelector('.lucide-copy')).not.toBeNull();
  });

  it('剪贴板拒绝写入时保持可重试的复制状态', async () => {
    installClipboard(vi.fn(async () => Promise.reject(new Error('clipboard denied'))));
    const { container } = render(<MarkdownMessage content={'```json\n{"ok":true}\n```'} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
      await Promise.resolve();
    });

    expect(container.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('.lucide-copy')).not.toBeNull();
  });
});
