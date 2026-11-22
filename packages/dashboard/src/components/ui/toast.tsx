import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-2 rounded-lg border border-zinc-700/70 bg-surface-overlay px-3.5 py-2.5 text-sm shadow-panel animate-fade-up"
          >
            {t.kind === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />}
            {t.kind === 'error' && <XCircle className="h-4 w-4 shrink-0 text-rose-400" />}
            {t.kind === 'info' && <Info className="h-4 w-4 shrink-0 text-cyan-400" />}
            <span className="text-zinc-200 break-all">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
