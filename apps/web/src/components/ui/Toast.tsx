import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

export type ToastVariant = "info" | "success" | "error";

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. */
  duration?: number;
}

interface ToastItem {
  id: number;
  title?: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const DOT: Record<ToastVariant, string> = {
  info: "bg-ink-3",
  success: "bg-ok",
  error: "bg-err",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  // Auto-dismiss timers, tracked so they can be paused (hover/focus — WCAG
  // 2.2.1: users must get time to read actionable toasts) and cleared on
  // provider unmount (no setState-after-unmount in tests/HMR).
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const durations = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    durations.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, duration: number) => {
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  /** Pause every pending auto-dismiss (pointer over / focus in the region). */
  const pauseAll = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  /** Resume auto-dismiss with each toast's full duration (simple + safe). */
  const resumeAll = useCallback(() => {
    for (const [id, duration] of durations.current) {
      if (!timers.current.has(id)) schedule(id, duration);
    }
  }, [schedule]);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = ++nextId.current;
      setToasts((list) => [
        ...list,
        {
          id,
          title: options.title,
          message: options.message,
          variant: options.variant ?? "info",
        },
      ]);
      const duration = options.duration ?? 5000;
      durations.current.set(id, duration);
      schedule(id, duration);
    },
    [schedule],
  );

  // Clear every pending timer when the provider unmounts.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        onPointerEnter={pauseAll}
        onPointerLeave={resumeAll}
        onFocus={pauseAll}
        onBlur={resumeAll}
        className="pointer-events-none fixed inset-x-0 bottom-6 z-100 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className="glass-panel panel-enter pointer-events-auto flex max-w-md items-center gap-3 rounded-capsule py-2.5 pl-4 pr-2"
          >
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", DOT[t.variant])}
            />
            <div className="flex min-w-0 flex-col text-left">
              {t.title ? (
                <span className="text-[13px] font-semibold text-ink">{t.title}</span>
              ) : null}
              <span className="text-[13px] leading-snug text-ink-2">{t.message}</span>
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="lift ml-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
