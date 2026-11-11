import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = (id: number) => setItems((xs) => xs.filter((t) => t.id !== id));
  const notify = useCallback((msg: string, kind: ToastKind = "success") => {
    const id = nextId++;
    setItems((xs) => [...xs, { id, msg, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastCtx.Provider value={notify}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Returns `notify(message, kind?)`. */
export function useToast() {
  return useContext(ToastCtx);
}
