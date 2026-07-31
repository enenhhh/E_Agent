import { createDesktopTransport, EAgentApp, type DesktopBridge } from '@e-agent/app-ui';
import React, { type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import '@e-agent/app-ui/styles.css';

interface ErrorBoundaryState {
  failed: boolean;
}

class DesktopErrorBoundary extends React.Component<{ children: ReactNode }, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  /**
   * 将未捕获的渲染异常转换成可恢复的错误页面。
   */
  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  /**
   * 在开发控制台保留组件栈；生产日志由主进程收集。
   */
  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('Renderer error boundary', error, info.componentStack);
    }
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main
          style={{
            display: 'grid',
            minHeight: '100vh',
            placeItems: 'center',
            background: '#0b0d10',
            color: '#f4f4f5',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <section style={{ maxWidth: 520, padding: 32, textAlign: 'center' }}>
            <h1>界面暂时无法显示</h1>
            <p>你的数据没有丢失。请重新加载应用；若问题持续，请查看日志。</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ cursor: 'pointer', padding: '10px 18px' }}
            >
              重新加载
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('缺少 #root 渲染节点');
}

const transport = createDesktopTransport(window.eAgent as unknown as DesktopBridge);

createRoot(rootElement).render(
  <React.StrictMode>
    <DesktopErrorBoundary>
      <EAgentApp mode="desktop" transport={transport} />
    </DesktopErrorBoundary>
  </React.StrictMode>,
);
