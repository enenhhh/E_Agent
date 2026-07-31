import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react';

import { Button } from './Button';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅记录无敏感数据的组件栈；生产环境由宿主日志适配器接管。
    console.error('Renderer error boundary', {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  public override render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="fatal-error">
        <span className="brand-mark" aria-hidden>
          E
        </span>
        <h1>E Agent 遇到了问题</h1>
        <p>界面已被安全停止，您的会话和文件没有被删除。</p>
        <code>{this.state.error.message}</code>
        <Button onClick={() => window.location.reload()} variant="primary">
          重新加载
        </Button>
      </main>
    );
  }
}
