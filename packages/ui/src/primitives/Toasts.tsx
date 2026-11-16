import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'danger' | 'info';

interface Toast { id: number; tone: ToastTone; text: string }

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => {});

/** Returns `toast(text, tone?)`; needs a `ToastProvider` above. */
export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

/** Short confirmations in the bottom-right corner; keeps the last four, each for 4 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: ToastTone = 'success') => {
    const id = nextId++;
    setToasts((current) => [...current.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="as-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`as-toast as-toast--${toast.tone}`}>{toast.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}
