import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { createDesktopTransport, type DesktopBridge } from '../lib/desktop-transport';
import { createHttpTransport } from '../lib/http-transport';
import type { EAgentTransport } from '../lib/transport';
import type { AppMode } from '../types';

interface TransportContextValue {
  mode: AppMode;
  transport: EAgentTransport;
}

declare global {
  interface Window {
    eAgent?: DesktopBridge;
    __E_AGENT_API_URL__?: string;
  }
}

const TransportContext = createContext<TransportContextValue | null>(null);

function resolveTransport(mode: AppMode, provided?: EAgentTransport): EAgentTransport {
  if (provided) {
    return provided;
  }
  if (mode === 'desktop' && window.eAgent) {
    return createDesktopTransport(window.eAgent);
  }
  const configuredUrl =
    window.__E_AGENT_API_URL__ ??
    (typeof import.meta.env.VITE_E_AGENT_API_URL === 'string'
      ? import.meta.env.VITE_E_AGENT_API_URL
      : 'http://127.0.0.1:4318');
  return createHttpTransport(configuredUrl);
}

export function TransportProvider({
  children,
  mode,
  transport,
}: PropsWithChildren<{ mode: AppMode; transport?: EAgentTransport }>): React.JSX.Element {
  const value = useMemo<TransportContextValue>(
    () => ({
      mode,
      transport: resolveTransport(mode, transport),
    }),
    [mode, transport],
  );

  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>;
}

export function useTransport(): TransportContextValue {
  const value = useContext(TransportContext);
  if (!value) {
    throw new Error('useTransport 必须在 TransportProvider 内使用。');
  }
  return value;
}
