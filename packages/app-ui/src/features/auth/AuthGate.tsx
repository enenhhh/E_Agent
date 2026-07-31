import { useEffect, type PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router';

import { LoadingState } from '../../components/ui/LoadingState';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';

export function AuthGate({ children }: PropsWithChildren): React.JSX.Element {
  const { transport } = useTransport();
  const location = useLocation();
  const status = useAuthStore((state) => state.status);
  const bootstrap = useAuthStore((state) => state.bootstrap);

  useEffect(() => {
    if (status === 'idle') {
      void bootstrap(transport);
    }
  }, [bootstrap, status, transport]);

  if (status === 'idle' || status === 'loading') {
    return (
      <main className="boot-screen">
        <span className="brand-mark">E</span>
        <LoadingState label="正在安全启动 E Agent…" />
      </main>
    );
  }

  if (status === 'setup-required') {
    return <Navigate replace state={{ from: location }} to="/setup" />;
  }

  if (status !== 'authenticated') {
    return <Navigate replace state={{ from: location }} to="/login" />;
  }

  return <>{children}</>;
}
