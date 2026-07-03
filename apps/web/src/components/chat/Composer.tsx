/**
 * Chat composer — capsule glass input. Enter sends, Shift+Enter newlines.
 * While a run is active the composer is disabled with a contextual reason
 * (session busy / awaiting your approval); a failed send keeps the text in
 * the box for retry.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ArrowUp } from "lucide-react";

import { cn } from "../../lib/cn";

export interface ComposerProps {
  onSend: (message: string) => void;
  /** Non-null disables the input and shows this as the contextual hint. */
  disabledReason?: string | null;
  /** True while a send is in flight (spinner + disabled send). */
  sending?: boolean;
  placeholder?: string;
  /** Retained draft after a failed send (controlled from the parent). */
  initialValue?: string;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  disabledReason,
  sending,
  placeholder = "Send a message…",
  initialValue,
  autoFocus,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = disabledReason != null;

  // Re-seed the box when the parent hands back a failed draft.
  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  // Autosize up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  }, [value]);

  function submit() {
    const message = value.trim();
    if (message.length === 0 || disabled || sending) return;
    onSend(message);
    setValue("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="px-4 pb-4 pt-2">
      {disabledReason != null ? (
        <p
          aria-live="polite"
          className="mb-1.5 px-2 text-[12px] text-ink-3"
        >
          {disabledReason}
        </p>
      ) : null}
      <div
        className={cn(
          "flex items-end gap-2 rounded-[22px] border border-black/10 bg-white/55 px-3 py-2 transition-colors duration-150",
          "focus-within:border-black/20",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          // Delivered via onInput (React's onChange does not fire under
          // happy-dom; both ride the same native `input` event in browsers —
          // see components/ui/Input.tsx for the full rationale).
          onChange={() => {}}
          onInput={(event) => setValue((event.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? "" : placeholder}
          aria-label="Message"
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-4 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || sending || value.trim().length === 0}
          aria-label="Send message"
          aria-busy={sending || undefined}
          className="lift flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-white disabled:pointer-events-none disabled:opacity-40"
        >
          {sending ? (
            <span className="spinner size-3.5" aria-hidden="true" />
          ) : (
            <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
