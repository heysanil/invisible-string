/**
 * Chat composer — capsule glass input. Enter sends, Shift+Enter newlines.
 *
 * While a run holds the session's run slot the box STAYS LIVE and Enter
 * queues instead of sending (the parent routes on `queueing`); the send
 * circle becomes a Stop, and a second ink circle appears once there is text
 * so neither action is ever mouse-inaccessible.
 *
 * THE FLUSH IS LOAD-BEARING. `RichTextEditor` serializes on an idle debounce,
 * so at the instant Enter fires, `value` is still the markdown from ~180 ms
 * ago — sending it would drop the tail of the message (or send nothing at all
 * for a fast one-word reply). Every submit path therefore reads the editor
 * synchronously through `flush()`.
 *
 * THE PLACEHOLDER IS CONSTANT, AND SO IS THE ARIA LABEL. Both are in
 * `useEditor`'s dependency array, so changing either rebuilds the editor and
 * destroys the draft — which would fire in exactly the scenario the queue
 * exists for. State rides the BUTTON's accessible name and the hint line.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

import { cn } from "../../lib/cn";
import { LazyComposerEditor } from "../editor/LazyComposerEditor";
import type { RichTextEditorHandle } from "../editor/RichTextEditor";

export interface ComposerProps {
  /** Submit. The parent decides whether that means send or enqueue. */
  onSend: (message: string) => void;
  /** Non-null freezes the input. ONLY a retired session — never "working". */
  disabledReason?: string | null;
  /** Non-blocking notice (retry state, transient errors). Box stays live. */
  hint?: string | null;
  /** Present ⇒ a run is stoppable ⇒ render the Stop control. */
  onStop?: () => void;
  /** Stop request in flight. */
  stopping?: boolean;
  /** Submit means enqueue: the button says so, and `sending` stops blocking. */
  queueing?: boolean;
  /**
   * Text handed back after a failed send or a given-up flush. APPENDED, never
   * replacing: the box is live now, so a give-up landing seconds later must
   * not overwrite whatever the user has started typing since.
   */
  restoreDraft?: string | null;
  /** Called once the restore has been applied, so the parent can null it. */
  onRestoreConsumed?: () => void;
  /** A send is in flight (spinner + disabled send — unless queueing). */
  sending?: boolean;
  placeholder?: string;
  /** Retained draft after a failed send (controlled from the parent). */
  initialValue?: string;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  disabledReason,
  hint,
  onStop,
  stopping,
  queueing,
  restoreDraft,
  onRestoreConsumed,
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

  // A restore APPENDS. Going through `value`/`initialValue` would reach the
  // reconcile effect, which replaces the document — and the box is live now,
  // so that would eat a draft the user started after the send failed.
  //
  // The ref is not belt-and-braces: this composer re-renders on every streamed
  // token of the live run, and `onRestoreConsumed` is an inline arrow in the
  // parent. Without it, a repaint landing between the append and the parent's
  // null would run the effect again and append the same text twice.
  const appliedRestore = useRef<string | null>(null);
  useEffect(() => {
    if (restoreDraft == null || restoreDraft.length === 0) {
      appliedRestore.current = null;
      return;
    }
    if (appliedRestore.current === restoreDraft) return;
    appliedRestore.current = restoreDraft;
    editorRef.current?.append(restoreDraft);
    // Mirror what the editor NOW holds rather than recomputing from `value`:
    // that state is one debounce behind the document, so on a box the user is
    // mid-sentence in it is SHORTER than what was just appended — and it would
    // come straight back down through the reconcile effect, replacing the
    // append with itself. `flush()` returns "" only before the lazy chunk
    // resolves; with no editor to append into, the string math is what seeds
    // the document on mount.
    const live = editorRef.current?.flush() ?? "";
    setValue((current) =>
      live.length > 0
        ? live
        : current.trim().length === 0
          ? restoreDraft
          : `${current}\n\n${restoreDraft}`,
    );
    onRestoreConsumed?.();
  }, [restoreDraft, onRestoreConsumed]);

  // A send in flight blocks another SEND, but never a queue: the flush that
  // set `sending` is exactly when the user's next thought needs somewhere to
  // go.
  const sendBlocked = sending === true && queueing !== true;

  function submit() {
    const message = (editorRef.current?.flush() ?? value).trim();
    if (message.length === 0 || disabled || sendBlocked) return;
    onSend(message);
    // Both halves are needed. The imperative write is what actually empties
    // the document: send-and-clear takes `value` from "" back to "" inside a
    // single React batch, so the prop never changes and the reconcile effect
    // would never run. The state update keeps the two in step afterwards.
    editorRef.current?.setValue("");
    setValue("");
  }

  function onKeyDown(event: KeyboardEvent): boolean {
    // Escape stops the run — the keyboard twin of the Stop circle. Inert
    // when there is nothing to stop, so it never swallows the key.
    if (event.key === "Escape") {
      if (onStop === undefined || stopping === true) return false;
      onStop();
      return true;
    }
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
  const showStop = onStop !== undefined;
  // With an empty box Stop IS the primary action and owns the ink circle;
  // once there is text the user's own words are primary and Stop steps back.
  const stopIsPrimary = showStop && empty;
  const showSubmit = !stopIsPrimary;

  return (
    <div className="px-4 pb-4 pt-2">
      {(disabledReason ?? hint) ? (
        <p aria-live="polite" className="mb-1.5 px-2 text-[12px] text-ink-3">
          {disabledReason ?? hint}
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
        {showStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label="Stop"
            aria-busy={stopping || undefined}
            className={cn(
              "lift flex size-8 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none",
              stopIsPrimary
                ? "bg-ink text-white"
                : "border border-black/12 bg-white/70 text-ink hover:bg-white/90",
            )}
          >
            {stopping ? (
              <span className="spinner size-3.5" aria-hidden="true" />
            ) : (
              <Square size={11} strokeWidth={2.6} fill="currentColor" aria-hidden="true" />
            )}
          </button>
        ) : null}
        {showSubmit ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || sendBlocked || empty}
            aria-label={queueing === true ? "Queue message" : "Send message"}
            aria-busy={sendBlocked || undefined}
            className="lift flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-white disabled:pointer-events-none disabled:opacity-40"
          >
            {sendBlocked ? (
              <span className="spinner size-3.5" aria-hidden="true" />
            ) : (
              <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
