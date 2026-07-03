import { cn } from "../../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name (required — the switch has no visible text of its own). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Capsule toggle — ink when on, hairline track when off. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "lift relative inline-flex h-6 w-10 shrink-0 items-center rounded-capsule border transition-colors",
        checked
          ? "border-transparent bg-ink"
          : "border-black/10 bg-black/[0.06]",
        disabled && "pointer-events-none opacity-55",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-150 ease-out",
          checked ? "translate-x-[19px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
