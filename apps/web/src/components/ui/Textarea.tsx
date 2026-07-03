import {
  useId,
  type ChangeEvent,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "../../lib/cn";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  srOnlyLabel?: boolean;
  error?: string | null;
}

function noopChange() {}

/**
 * Multi-line input. Like {@link Input}, the consumer's onChange rides the
 * native `input` event (onInput) so it fires identically under happy-dom and
 * real browsers.
 */
export function Textarea({
  label,
  srOnlyLabel,
  error,
  className,
  id: idProp,
  onChange,
  onInput,
  ...rest
}: TextareaProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;

  const handleInput: TextareaProps["onInput"] = (event) => {
    onInput?.(event);
    onChange?.(event as unknown as ChangeEvent<HTMLTextAreaElement>);
  };

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
      <textarea
        id={id}
        onChange={noopChange}
        onInput={handleInput}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "w-full rounded-card border bg-white/60 px-4 py-2.5 text-sm text-ink placeholder:text-ink-4",
          "transition-[border-color,background-color] duration-150 ease-out",
          error ? "border-err/50" : "border-black/10 hover:border-black/15",
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={errorId} aria-live="polite" className="px-1 text-xs text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
