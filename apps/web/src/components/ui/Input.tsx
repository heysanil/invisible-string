import {
  useId,
  type FormEventHandler,
  type InputHTMLAttributes,
} from "react";

import { cn } from "../../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Inline validation message rendered below the field. */
  error?: string | null;
}

export function Input({
  label,
  error,
  className,
  id: idProp,
  onChange,
  ...rest
}: InputProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;
  // React's onChange for text inputs rides its polyfilled ChangeEventPlugin,
  // which doesn't fire under happy-dom. Mirroring the handler onto the plain
  // delegated `input` event keeps behavior identical in browsers (same native
  // event; setState is idempotent) and makes the primitive testable.
  const onInput = onChange as unknown as
    | FormEventHandler<HTMLInputElement>
    | undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-1 text-[13px] font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        onChange={onChange}
        onInput={onInput}
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
