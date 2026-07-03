import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Supporting line under the title. */
  description?: ReactNode;
  children: ReactNode;
  /** Footer actions (usually a Button row). */
  footer?: ReactNode;
  /** Tailwind max-width utility for the panel. Defaults to a comfortable md. */
  maxWidthClassName?: string;
  /** Hide the header × (rare — e.g. a forced-choice blocker). */
  hideClose?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible glass modal: scrim + centered floating panel. Focus moves in on
 * open and is restored to the invoker on close; Tab is trapped inside;
 * Escape and scrim-click both close. Body scroll is locked while open.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidthClassName = "max-w-lg",
  hideClose = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const focusFirst = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(focusFirst);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, focusFirst]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="overlay-scrim items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKeyDown}
        className={cn(
          "glass-panel dialog-enter flex max-h-[calc(100dvh-2rem)] w-full flex-col",
          maxWidthClassName,
        )}
      >
        <header className="flex items-start gap-3 px-6 pb-4 pt-5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="text-[17px]">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="text-[13px] leading-relaxed text-ink-3">
                {description}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="lift -mr-1.5 -mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2.5 px-6 pb-5 pt-4">
            {footer}
          </footer>
        ) : (
          <div className="pb-5" />
        )}
      </div>
    </div>
  );
}
