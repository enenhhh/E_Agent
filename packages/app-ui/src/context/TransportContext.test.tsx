import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EAgentTransport } from '../lib/transport';

import { TransportProvider, useTransport } from './TransportContext';

const transportFactories = vi.hoisted(() => ({
  desktop: vi.fn(),
  http: vi.fn(),
}));

vi.mock('../lib/desktop-transport', () => ({
  createDesktopTransport: transportFactories.desktop,
}));

vi.mock('../lib/http-transport', () => ({
  createHttpTransport: transportFactories.http,
}));

const desktopTransport = { kind: 'desktop' } as EAgentTransport;
const httpTransport = { kind: 'http' } as EAgentTransport;

function TransportProbe(): React.JSX.Element {
  const { mode, transport } = useTransport();
  return (
    <output>
      {mode}:{transport.kind}
    </output>
  );
}

afterEach(() => {
  cleanup();
  delete window.eAgent;
  delete window.__E_AGENT_API_URL__;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('TransportContext', () => {
  beforeEach(() => {
    transportFactories.desktop.mockReset().mockReturnValue(desktopTransport);
    transportFactories.http.mockReset().mockReturnValue(httpTransport);
  });

  it('优先使用调用方注入的 transport，并在相同属性重渲染时保持引用', () => {
    const provided = { kind: 'mock' } as EAgentTransport;
    const view = render(
      <TransportProvider mode="desktop" transport={provided}>
        <TransportProbe />
      </TransportProvider>,
    );

    expect(screen.getByText('desktop:mock')).toBeInTheDocument();
    expect(transportFactories.desktop).not.toHaveBeenCalled();
    expect(transportFactories.http).not.toHaveBeenCalled();

    view.rerender(
      <TransportProvider mode="desktop" transport={provided}>
        <TransportProbe />
      </TransportProvider>,
    );
    expect(screen.getByText('desktop:mock')).toBeInTheDocument();
    expect(transportFactories.desktop).not.toHaveBeenCalled();
  });

  it('桌面模式存在安全桥接时创建桌面 transport', () => {
    const bridge = {
      invoke: vi.fn(),
      stream: vi.fn(),
    };
    window.eAgent = bridge;

    render(
      <TransportProvider mode="desktop">
        <TransportProbe />
      </TransportProvider>,
    );

    expect(screen.getByText('desktop:desktop')).toBeInTheDocument();
    expect(transportFactories.desktop).toHaveBeenCalledOnce();
    expect(transportFactories.desktop).toHaveBeenCalledWith(bridge);
    expect(transportFactories.http).not.toHaveBeenCalled();
  });

  it('Web 模式忽略桌面桥接并使用显式配置的 API 地址', () => {
    window.eAgent = {
      invoke: vi.fn(),
      stream: vi.fn(),
    };
    window.__E_AGENT_API_URL__ = 'https://api.example.test/root/';

    render(
      <TransportProvider mode="web">
        <TransportProbe />
      </TransportProvider>,
    );

    expect(screen.getByText('web:http')).toBeInTheDocument();
    expect(transportFactories.desktop).not.toHaveBeenCalled();
    expect(transportFactories.http).toHaveBeenCalledWith('https://api.example.test/root/');
  });

  it('无桌面桥接和 URL 配置时回退到本地 HTTP 服务', () => {
    render(
      <TransportProvider mode="desktop">
        <TransportProbe />
      </TransportProvider>,
    );

    expect(screen.getByText('desktop:http')).toBeInTheDocument();
    expect(transportFactories.http).toHaveBeenCalledWith('http://127.0.0.1:4318');
  });

  it('未设置窗口级地址时读取构建环境中的 API 地址', () => {
    vi.stubEnv('VITE_E_AGENT_API_URL', 'https://build.example.test/api');

    render(
      <TransportProvider mode="web">
        <TransportProbe />
      </TransportProvider>,
    );

    expect(transportFactories.http).toHaveBeenCalledWith('https://build.example.test/api');
  });

  it('缺少 Provider 时立即给出可定位的开发错误', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<TransportProbe />)).toThrow(
      'useTransport 必须在 TransportProvider 内使用。',
    );
  });
});
