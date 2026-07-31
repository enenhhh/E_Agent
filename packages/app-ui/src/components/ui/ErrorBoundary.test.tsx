import { cleanup, render, screen } from '@testing-library/react';
import { Children, isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button, type ButtonProps } from './Button';
import { ErrorBoundary } from './ErrorBoundary';

function BrokenView(): React.JSX.Element {
  throw new Error('渲染失败');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ErrorBoundary', () => {
  it('子组件正常时直接渲染内容', () => {
    render(
      <ErrorBoundary>
        <p>安全内容</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('安全内容')).toBeInTheDocument();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('捕获渲染异常、输出脱敏组件栈并展示恢复入口', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenView />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'E Agent 遇到了问题' })).toBeInTheDocument();
    expect(screen.getByText('界面已被安全停止，您的会话和文件没有被删除。')).toBeInTheDocument();
    expect(screen.getByText('渲染失败')).toBeInTheDocument();

    const boundaryLog = consoleError.mock.calls.find(
      ([message]) => message === 'Renderer error boundary',
    );
    expect(boundaryLog).toBeDefined();
    expect(boundaryLog?.[1]).toEqual({
      name: 'Error',
      componentStack: expect.stringContaining('BrokenView'),
    });
    expect(boundaryLog?.[1]).not.toHaveProperty('message');
  });

  it('点击重新加载按钮会执行恢复回调', () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('渲染失败'));
    const fallback = boundary.render() as ReactElement<{ children: React.ReactNode }>;
    const reloadButton = Children.toArray(fallback.props.children).find(
      (child): child is ReactElement<ButtonProps> => isValidElement(child) && child.type === Button,
    );
    const reload = vi.fn();

    expect(reloadButton).toBeDefined();
    vi.stubGlobal('window', { location: { reload } });
    reloadButton?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);

    expect(reload).toHaveBeenCalledOnce();
  });
});
