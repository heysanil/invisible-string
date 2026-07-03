import { cn } from "../../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name (required — switches carry no visible label of their own). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Capsule toggle switch. Renders a real `role="switch"` button so keyboard
 * (Space/Enter) and AT work without extra wiring; color is meaning — the
 * "on" track is ink, never a decorative accent.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
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
        "lift relative inline-flex h-[22px] w-9 shrink-0 items-center rounded-capsule border",
        "disabled:pointer-events-none disabled:opacity-50",
        checked ? "border-transparent bg-ink" : "border-black/10 bg-black/[0.08]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
          "transition-transform duration-150 ease-out",
          checked ? "translate-x-[17px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
