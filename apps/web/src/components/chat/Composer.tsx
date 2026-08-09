/**
 * Chat composer — capsule glass input. Enter sends, Shift+Enter newlines.
 * While a run is active the composer is disabled with a contextual reason
 * (session busy / awaiting your approval); a failed send keeps the text in
 * the box for retry.
 *
 * THE FLUSH IS LOAD-BEARING. `RichTextEditor` serializes on an idle debounce,
 * so at the instant Enter fires, `value` is still the markdown from ~180 ms
 * ago — sending it would drop the tail of the message (or send nothing at all
 * for a fast one-word reply). Every send path therefore reads the editor
 * synchronously through `flush()`.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { cn } from "../../lib/cn";
import { LazyComposerEditor } from "../editor/LazyComposerEditor";
import type { RichTextEditorHandle } from "../editor/RichTextEditor";

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
  const editorRef = useRef<RichTextEditorHandle>(null);
  const disabled = disabledReason != null;

  // Re-seed the box when the parent hands back a failed draft.
  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  // The editor exists by the time a passive effect runs (its imperative
  // handle is attached in a layout effect), so one shot is enough.
  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  function submit() {
    const message = (editorRef.current?.flush() ?? value).trim();
    if (message.length === 0 || disabled || sending) return;
    onSend(message);
    // Both halves are needed. The imperative write is what actually empties
    // the document: send-and-clear takes `value` from "" back to "" inside a
    // single React batch, so the prop never changes and the reconcile effect
    // would never run. The state update keeps the two in step afterwards.
    editorRef.current?.setValue("");
    setValue("");
  }

  function onKeyDown(event: KeyboardEvent): boolean {
    if (event.key !== "Enter" || event.shiftKey) return false;
    // Mid-composition Enter commits an IME candidate; it is not a send.
    if (event.isComposing || event.keyCode === 229) return false;
    submit();
    // Handled — ProseMirror must not also split the paragraph underneath.
    return true;
  }

  // Emptiness rides the debounced value, so the send button can trail the
  // last keystroke by one debounce. That only ever gates the MOUSE path
  // (Enter flushes), and reaching for the button costs more than 180 ms.
  const empty = value.trim().length === 0;

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
        {/* The contenteditable grows with its content — no autosize math —
            and the clamp turns into a scroll region past ~6 lines. The
            placeholder is constant: it is suppressed for a read-only host in
            CSS, because changing the prop re-creates the editor and would
            drop the draft the moment a run starts. */}
        <LazyComposerEditor
          ref={editorRef}
          value={value}
          onChange={setValue}
          ariaLabel="Message"
          placeholder={placeholder}
          readOnly={disabled}
          onKeyDown={onKeyDown}
          className="thin-scroll tt-host-composer max-h-40 min-w-0 flex-1 overflow-y-auto text-sm leading-relaxed"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || sending || empty}
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
