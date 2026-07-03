import { useId, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /** Visible field label; pass `srOnlyLabel` to hide it visually. */
  label?: string;
  srOnlyLabel?: boolean;
  error?: string | null;
  options: readonly SelectOption[];
  /** Leading placeholder rendered as a disabled first option. */
  placeholder?: string;
}

/** Capsule native select — accessible, styled to the E1 system. */
export function Select({
  label,
  srOnlyLabel,
  error,
  options,
  placeholder,
  className,
  id: idProp,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label
          htmlFor={id}
          className={cn(
            "px-1 text-[13px] font-medium text-ink-2",
            srOnlyLabel && "sr-only",
          )}
        >
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "h-10 w-full appearance-none rounded-capsule border bg-white/60 pl-4 pr-9 text-sm text-ink",
            "transition-[border-color,background-color,box-shadow] duration-150 ease-out",
            error ? "border-err/50" : "border-black/10 hover:border-black/15",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink",
            className,
          )}
          {...rest}
        >
          {placeholder !== undefined ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-4"
        />
      </div>
      {error ? (
        <p id={errorId} aria-live="polite" className="px-1 text-xs text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
