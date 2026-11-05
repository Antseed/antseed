import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicTunnelStatus } from '../../../types/bridge';

const PublicEndpointModalDialog = lazy(async () => {
  const module = await import('./PublicEndpointModalDialog');
  return { default: module.PublicEndpointModal };
});

type PublicEndpointModalContextValue = {
  status: PublicTunnelStatus | null;
  openPublicEndpointModal: () => void;
};

const PublicEndpointModalContext = createContext<PublicEndpointModalContextValue | null>(null);

export function usePublicEndpointModal(): PublicEndpointModalContextValue {
  const value = useContext(PublicEndpointModalContext);
  if (!value) throw new Error('usePublicEndpointModal must be used inside PublicEndpointModalProvider');
  return value;
}

/** Same as usePublicEndpointModal, but null outside the provider instead of throwing. */
export function useOptionalPublicEndpointModal(): PublicEndpointModalContextValue | null {
  return useContext(PublicEndpointModalContext);
}

export function PublicEndpointModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<PublicTunnelStatus | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.antseedDesktop?.publicTunnelGetStatus?.();
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openPublicEndpointModal = useCallback(() => {
    setIsOpen(true);
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ status, openPublicEndpointModal }),
    [openPublicEndpointModal, status],
  );

  return (
    <PublicEndpointModalContext.Provider value={value}>
      {children}
      {isOpen ? (
        <Suspense fallback={null}>
          <PublicEndpointModalDialog
            isOpen
            status={status}
            onClose={() => setIsOpen(false)}
            onStatusChange={setStatus}
          />
        </Suspense>
      ) : null}
    </PublicEndpointModalContext.Provider>
  );
}
