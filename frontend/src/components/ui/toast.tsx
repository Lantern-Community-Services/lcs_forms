import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "error" | "info";
interface ToastAction {
  label: string;
  onClick: () => void;
}
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastOptions {
  /** e.g. Undo. Clicking it runs the handler and dismisses the toast. */
  action?: ToastAction;
  /** Milliseconds on screen. Defaults to 4s, or 10s when there's an action. */
  duration?: number;
}

type ToastFn = (message: string, kind?: ToastKind, opts?: ToastOptions) => void;
const ToastContext = createContext<{ toast: ToastFn } | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastFn>((message, kind = "success", opts = {}) => {
    const id = ++counter;
    setToasts((t) => [...t.slice(-2), { id, kind, message, action: opts.action }]);
    setTimeout(() => dismiss(id), opts.duration ?? (opts.action ? 10_000 : 4000));
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Phone: full width. iPad and desktop: bottom-right. Either way it sits 12px
          above the dock when there is one (--dock-h, measured by Dock, covers its
          safe-area padding too), and 20px off the edge on desktop where there isn't. */}
      <div
        className="fixed inset-x-3 bottom-[calc(var(--dock-h,8px)+12px)] z-40 flex flex-col gap-2 md:inset-x-auto md:right-5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "flex items-center gap-2.5 rounded-panel border bg-surface px-4 py-3 text-[13.5px] text-ink shadow-panel md:min-w-[280px]",
              t.kind === "success" && "border-status-greenDot/40",
              t.kind === "error" && "border-status-redDot/40",
              t.kind === "info" && "border-hairline"
            )}
          >
            {t.kind === "success" && <CheckCircle2 className="h-4 w-4 shrink-0 text-status-greenDot" />}
            {t.kind === "error" && <AlertCircle className="h-4 w-4 shrink-0 text-status-redDot" />}
            <span className="flex-1 text-ink">{t.message}</span>
            {t.action && (
              <button
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                className="min-h-[36px] shrink-0 rounded-input px-2.5 font-heading text-[13.5px] font-bold text-accent hover:bg-subtle2 dark:text-white"
              >
                {t.action.label}
              </button>
            )}
            <button onClick={() => dismiss(t.id)} className="shrink-0 text-muted hover:text-ink" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx.toast;
}
