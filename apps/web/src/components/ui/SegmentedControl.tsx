import { useRef, type KeyboardEvent } from "react";

import { cn } from "../../lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Back-compat alias — some call sites import `SegmentOption`. */
export type SegmentOption<T extends string> = SegmentedOption<T>;

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible name for the tablist. Alias of `label`. */
  ariaLabel?: string;
  /** Accessible name (builder call sites use this). Alias of `ariaLabel`. */
  label?: string;
  className?: string;
  size?: "sm" | "md";
  /**
   * ARIA semantics. `"tabs"` (default) renders a tablist — right for scope
   * switchers. `"radio"` renders a radiogroup — right for single-choice
   * pickers (e.g. model preset).
   */
  variant?: "tabs" | "radio";
}

/**
 * Capsule segmented control. Implements the ARIA keyboard model (arrow keys
 * move + activate, Home/End jump) over a glass track. Accepts either
 * `ariaLabel` or `label` as the accessible name, and renders as a tablist or
 * a radiogroup per `variant`.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  label,
  className,
  size = "md",
  variant = "tabs",
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const accessibleName = ariaLabel ?? label;
  const isRadio = variant === "radio";

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const currentIndex = options.findIndex((option) => option.value === value);
    let nextIndex = currentIndex;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % options.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + options.length) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
    }
    const next = options[nextIndex];
    if (next) {
      onChange(next.value);
      refs.current[nextIndex]?.focus();
    }
  }

  const pad = size === "sm" ? "h-8 text-[13px]" : "h-9 text-sm";

  return (
    <div
      role={isRadio ? "radiogroup" : "tablist"}
      aria-label={accessibleName}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-capsule border border-black/[0.06] bg-black/[0.04] p-1",
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role={isRadio ? "radio" : "tab"}
            aria-selected={isRadio ? undefined : active}
            aria-checked={isRadio ? active : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "lift rounded-capsule px-3.5 font-medium",
              pad,
              active
                ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.10)]"
                : "text-ink-3 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
