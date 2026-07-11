import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

/** Imperative controls handed to function children. */
export interface PopoverControls {
  /** Close the popover and return focus to the trigger (like Escape). */
  close: () => void;
}

export interface PopoverProps {
  /** The trigger — must forward props (a Button works). */
  trigger: ReactElement<{
    onClick?: (event: React.MouseEvent) => void;
    "aria-expanded"?: boolean;
    "aria-haspopup"?: boolean | "dialog";
  }>;
  /**
   * Content, or a render function receiving `{ close }` so pick-style
   * popovers can dismiss themselves after a selection.
   */
  children: ReactNode | ((controls: PopoverControls) => ReactNode);
  /** Accessible name for the popover surface. */
  label: string;
  align?: "start" | "end";
  className?: string;
}

/**
 * Lightweight anchored popover: click-toggle, click-outside + Escape to
 * dismiss, focus returns to the trigger on close. Rendered inline (no portal)
 * so it inherits the glass stacking context of its panel.
 */
export function Popover({
  trigger,
  children,
  label,
  align = "start",
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const triggerNode = cloneElement(trigger, {
    "aria-expanded": open,
    "aria-haspopup": "dialog",
    onClick: (event: React.MouseEvent) => {
      trigger.props.onClick?.(event);
      setOpen((value) => !value);
    },
  });

  return (
    <div ref={rootRef} className="relative inline-flex">
      <span
        ref={(el) => {
          triggerRef.current = (el?.firstElementChild as HTMLElement) ?? null;
        }}
      >
        {triggerNode}
      </span>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          id={id}
          className={cn(
            "glass-panel panel-enter absolute top-[calc(100%+8px)] z-50 min-w-64 rounded-panel-sm p-3",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {typeof children === "function" ? children({ close }) : children}
        </div>
      ) : null}
    </div>
  );
}
