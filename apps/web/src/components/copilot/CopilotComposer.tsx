/**
 * Copilot COMPOSER — the capsule composer row + send/stop button + the
 * screen-reader announcer, shared by the docked rail (CopilotDock) and the
 * workflow editor's ComposerPane. Also home of the shared copilot chrome the
 * shells place themselves: {@link AllowEditsSwitch}, {@link AutoApplyBanner}
 * and {@link ReconnectingBanner}.
 *
 * Composer-text STATE lives in the SHELL (`value`/`onChange`), so a draft
 * survives the dock collapsing and re-opening — this component owns only the
 * editor instance, the submit path and the announcer.
 *
 * Invariants moved VERBATIM from the dock (see AGENTS.md):
 * - state NEVER rides the editor's `placeholder` or `ariaLabel` — both are
 *   `useEditor` construction options, so changing either rebuilds the editor
 *   and destroys the user's draft. Mode and connection state ride the submit
 *   BUTTON's accessible name and separate elements ("Connecting…" is its own
 *   `<p>`) instead;
 * - the composer never silently drops input: text stays put until the socket
 *   accepts the frame, and sends are blocked mid-turn;
 * - announcements go through a dedicated sr-only live region (never
 *   per-token): turn start/settle, new suggestions, auto-applied edits, and —
 *   via {@link CopilotComposerHandle.announce} — the shells' allow-edits
 *   toggle.
 */
import { RefreshCw, Send, Square } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

import type { CopilotThreadItem } from "../../lib/copilot/thread";
import type { CopilotApi } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { LazyComposerEditor } from "../editor/LazyComposerEditor";
import type { RichTextEditorHandle } from "../editor/RichTextEditor";

/** "Ask copilot to fix" affordances seed the composer with this. */
export interface CopilotPrefill {
  id: number;
  text: string;
}

/** Imperative surface the shells drive (focus choreography + announcements). */
export interface CopilotComposerHandle {
  focus(): void;
  /** Speak through the composer's live region (e.g. the allow-edits toggle). */
  announce(text: string): void;
}

export interface CopilotComposerProps {
  copilot: CopilotApi;
  /** Allow-edits mode for the NEXT turn — only the button's label reads it. */
  allowEdits: boolean;
  /** Composer text (shell-owned so it survives a dock collapse). */
  value: string;
  onChange: (value: string) => void;
  ref?: React.Ref<CopilotComposerHandle>;
}

export function CopilotComposer(props: CopilotComposerProps) {
  const { copilot, allowEdits, value, onChange, ref } = props;

  const [announcement, setAnnouncement] = useState("");
  const composerRef = useRef<RichTextEditorHandle | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => composerRef.current?.focus(),
      announce: setAnnouncement,
    }),
    [],
  );

  // Screen-reader announcements: once per state change, never per delta.
  const prevGenerating = useRef(false);
  useEffect(() => {
    if (copilot.generating && !prevGenerating.current) {
      setAnnouncement("Copilot is responding");
    } else if (!copilot.generating && prevGenerating.current) {
      const lastAssistant = [...copilot.items]
        .reverse()
        .find(
          (item): item is Extract<CopilotThreadItem, { kind: "message" }> =>
            item.kind === "message" && item.role === "assistant",
        );
      setAnnouncement(
        lastAssistant ? `Copilot: ${lastAssistant.text}` : "Copilot finished",
      );
    }
    prevGenerating.current = copilot.generating;
  }, [copilot.generating, copilot.items]);
  const pendingCount = copilot.items.filter(
    (item) => item.kind === "suggestion" && item.status === "pending",
  ).length;
  const prevPendingCount = useRef(0);
  useEffect(() => {
    if (pendingCount > prevPendingCount.current) {
      setAnnouncement("Copilot made a suggestion — review it in the panel");
    }
    prevPendingCount.current = pendingCount;
  }, [pendingCount]);
  // Auto-applied cards never go through `pending`, so the announcement above
  // would never fire for them — an edit that lands without a word is exactly
  // what allow-edits must not become.
  const autoAppliedCount = copilot.items.filter(
    (item) => item.kind === "suggestion" && item.autoApplied,
  ).length;
  const prevAutoAppliedCount = useRef(0);
  useEffect(() => {
    if (autoAppliedCount > prevAutoAppliedCount.current) {
      setAnnouncement("Copilot applied an edit automatically — review it in the panel");
    }
    prevAutoAppliedCount.current = autoAppliedCount;
  }, [autoAppliedCount]);

  function submit() {
    // `value` trails the editor by one serialize debounce, so the last
    // keystrokes before Enter are not in it yet — read the document directly.
    const text = composerRef.current?.flush() ?? value;
    // Only clear the composer when the frame was actually delivered — a
    // still-connecting socket or an in-flight turn keeps the text in place.
    if (!copilot.send(text)) return;
    // The imperative write is the one that empties the document: clearing
    // takes `value` from "" back to "" in a single React batch, so the
    // prop never changes and the reconcile effect would never fire.
    composerRef.current?.setValue("");
    onChange("");
  }

  /** Enter sends; Shift+Enter is a newline (the composer grows to fit). */
  function onComposerKeyDown(event: KeyboardEvent): boolean {
    if (event.key !== "Enter" || event.shiftKey) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    submit();
    return true;
  }

  const connecting = copilot.status === "connecting";
  const canSend = copilot.status === "open" && !copilot.generating;

  return (
    <>
      {/* Dedicated announcer: messages/suggestions are spoken when they
          SETTLE — the log itself is not a live region (no per-token spam). */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      {/* Connecting used to ride the composer's placeholder. It cannot any
          more: the placeholder is an editor construction option, so changing
          it re-creates the editor — and a draft typed while the socket was
          still opening would vanish the moment it opened. */}
      {connecting ? (
        <p className="px-4 pb-1 text-[11.5px] text-ink-3" role="status">
          Connecting…
        </p>
      ) : null}

      {/* Composer */}
      <form
        className="flex items-end gap-2 border-t border-black/[0.06] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* The capsule owns the surface and the focus ring; the editor inside
            it is chrome-free and grows with the draft up to ~5 lines. A long
            paste is a scroll region, never a dock that swallows the thread. */}
        <div className="flex min-w-0 flex-1 items-center rounded-card-lg border border-black/10 bg-white/60 px-3 py-1.5 transition-colors duration-150 focus-within:border-ink/40">
          <LazyComposerEditor
            ref={composerRef}
            value={value}
            onChange={onChange}
            ariaLabel="Ask copilot"
            placeholder="Ask copilot…"
            onKeyDown={onComposerKeyDown}
            className="thin-scroll tt-host-composer max-h-28 w-full overflow-y-auto text-[13px] leading-relaxed"
          />
        </div>
        {copilot.generating ? (
          <button
            type="button"
            onClick={copilot.stop}
            aria-label="Stop generating"
            className="lift flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-white"
          >
            <Square size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            // The mode rides the BUTTON's accessible name (never the editor's
            // placeholder/aria-label — those rebuild the editor and eat the
            // draft; see the module header).
            aria-label={
              allowEdits ? "Send to copilot (auto-apply on)" : "Send to copilot"
            }
            disabled={value.trim().length === 0 || !canSend}
            className={cn(
              "lift flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-white",
              (value.trim().length === 0 || !canSend) && "opacity-40",
            )}
          >
            <Send size={14} aria-hidden="true" />
          </button>
        )}
      </form>
    </>
  );
}

// ── Shared chrome the shells place themselves ───────────────────────────────

/**
 * Allow-edits switch (spec D7.2) — a capsule with a real `role="switch"`, so
 * the mode is exposed to assistive tech as a mode rather than as a button that
 * did something. Checked state is carried by BOTH fill and knob position:
 * position alone fails at a glance, fill alone fails for anyone who cannot
 * distinguish the two ink tones.
 */
export function AllowEditsSwitch({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        "lift inline-flex items-center gap-2 rounded-capsule border px-2 py-1 text-[11.5px] font-medium transition-colors duration-150 ease-out",
        checked
          ? "border-ink/25 bg-ink/[0.06] text-ink"
          : "border-black/10 bg-white/50 text-ink-3 hover:text-ink-2",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-[13px] w-[22px] shrink-0 items-center rounded-capsule transition-colors duration-150 ease-out",
          checked ? "bg-ink" : "bg-black/15",
        )}
      >
        <span
          className={cn(
            "absolute size-[9px] rounded-full bg-white transition-[left] duration-150 ease-out",
            checked ? "left-[11px]" : "left-[2px]",
          )}
        />
      </span>
      Auto-apply edits
    </button>
  );
}

/**
 * The plain-language strip below the switch — the mode must be legible
 * without inspecting a control's state (auto-applying edits to someone's
 * draft is not a preference to hide in a widget).
 */
export function AutoApplyBanner() {
  return (
    <p
      data-testid="copilot-auto-apply-banner"
      className="mx-3 mt-2 rounded-card border border-ink/15 bg-ink/[0.045] px-3 py-1.5 text-[11.5px] leading-snug text-ink-2"
    >
      Copilot edits this draft without asking. Every change still lands as a
      card below, so you can see exactly what it changed.
    </p>
  );
}

/** Reconnect notice — the draft resyncs with the next turn's frame. */
export function ReconnectingBanner() {
  return (
    <div
      role="status"
      className="mx-3 mt-2 flex items-center gap-1.5 rounded-card border border-warn/30 bg-warn/[0.06] px-3 py-1.5 text-[12px] text-ink-2"
    >
      <RefreshCw size={12} aria-hidden="true" className="text-warn" />
      Reconnecting — your draft will resync automatically.
    </div>
  );
}
