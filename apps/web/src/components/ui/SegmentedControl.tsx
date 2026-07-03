import { useRef, type KeyboardEvent } from "react";

import { cn } from "../../lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible name for the tablist. */
  ariaLabel: string;
  className?: string;
  size?: "sm" | "md";
}

/**
 * Capsule segmented control (tabs). Implements the ARIA tabs keyboard model
 * (arrow keys move + activate, Home/End jump) over a glass track. Consumers
 * pair it with panels labelled by these tabs' ids where needed.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  size = "md",
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

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
      role="tablist"
      aria-label={ariaLabel}
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
            role="tab"
            aria-selected={active}
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
