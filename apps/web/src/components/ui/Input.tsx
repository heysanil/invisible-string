import {
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
} from "react";

import { cn } from "../../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Inline validation message rendered below the field. */
  error?: string | null;
}

// Satisfies React's controlled-input contract (value without onChange warns);
// the consumer's handler is delivered via onInput — see below.
function noopChange() {}

export function Input({
  label,
  error,
  className,
  id: idProp,
  onChange,
  onInput,
  ...rest
}: InputProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;

  // React's onChange for text inputs rides its ChangeEventPlugin, which never
  // emits under happy-dom (verified empirically: the delegated `input` event
  // reaches SimpleEventPlugin — onInput fires — but no synthetic change event
  // is produced even when the value tracker is stale). Wiring the SAME
  // handler to both props would double-fire in real browsers, so the
  // consumer's onChange is delivered through onInput ONLY: for text inputs
  // both props ride the same native `input` event, so real-browser behavior
  // is identical and the handler runs exactly once per keystroke everywhere.
  const handleInput: InputProps["onInput"] = (event) => {
    onInput?.(event);
    onChange?.(event as unknown as ChangeEvent<HTMLInputElement>);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-1 text-[13px] font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        onChange={noopChange}
        onInput={handleInput}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "h-10 w-full rounded-capsule border bg-white/60 px-4 text-sm text-ink placeholder:text-ink-4",
          "transition-[border-color,background-color,box-shadow] duration-150 ease-out",
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
