/**
 * Copilot dock — the docked right RAIL SHELL used by the agent editor
 * (spec §12; the workflow editor's primary surface is ComposerPane). Owns
 * only what is rail-specific: the collapse pill + per-workspace open
 * persistence, the narrow-viewport auto-collapse, the session-scoped
 * allow-edits toggle, and the open/collapse focus choreography. The
 * conversation itself is the shared {@link CopilotThread} +
 * {@link CopilotComposer} pair over one {@link useCopilot} socket.
 *
 * Everything surface-specific — entity identity, live-draft reads, proposal
 * application/presentation, empty-state copy, prompt chips — rides the
 * injected {@link CopilotSurfaceAdapter}.
 *
 * Allow-edits (D7.2) is a session-scoped toggle owned HERE, defaulting off and
 * deliberately NOT persisted: "the copilot may edit my agent without asking"
 * is a decision to take per sitting, not one to inherit silently from a
 * previous tab. It is also unmistakable while on — a checked switch, an
 * explanatory strip above the thread, and the send button's accessible name.
 *
 * Focus follows intent: open → composer, collapse → pill; the thread's
 * apply/dismiss choreography and the composer's draft-preservation contract
 * live with the extracted components.
 */
import { ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CopilotSurfaceAdapter } from "../../lib/copilot/adapter";
import type { WebSocketFactory } from "../../lib/copilot/socket";
import { useCopilot } from "../../lib/copilot/useCopilot";
import {
  AllowEditsSwitch,
  AutoApplyBanner,
  CopilotComposer,
  ReconnectingBanner,
  type CopilotComposerHandle,
  type CopilotPrefill,
} from "./CopilotComposer";
import { CopilotThread } from "./CopilotThread";

export type { CopilotPrefill } from "./CopilotComposer";

const OPEN_STORAGE_PREFIX = "is.copilot.open";
/** Below this viewport width the dock auto-collapses to the pill. */
const NARROW_VIEWPORT_QUERY = "(max-width: 1179px)";

export interface CopilotDockProps {
  workspaceId: string;
  /**
   * The surface being edited. Rebuild it per render freely — the hook reads
   * it through a live ref and it never re-keys the socket.
   */
  adapter: CopilotSurfaceAdapter;
  /** Set by "ask copilot to fix" affordances — opens + seeds the composer. */
  prefill?: CopilotPrefill | null;
  /** Test seam — scripted fake WS. */
  createWebSocket?: WebSocketFactory;
  backoffBaseMs?: number;
}

function storageKey(workspaceId: string): string {
  // Scoped per workspace so one account's panel preference never follows
  // another workspace/account on a shared machine.
  return `${OPEN_STORAGE_PREFIX}:${workspaceId}`;
}

function readStoredOpen(workspaceId: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(workspaceId)) === "1";
  } catch {
    return false;
  }
}

export function CopilotDock(props: CopilotDockProps) {
  const { workspaceId, adapter, prefill, createWebSocket, backoffBaseMs } = props;

  const [open, setOpen] = useState(() => readStoredOpen(workspaceId));
  // Session-scoped, default OFF, never persisted — see the module header.
  const [allowEdits, setAllowEdits] = useState(false);
  // Composer text lives HERE so an unsent draft survives a collapse/reopen
  // (the composer component unmounts with the panel).
  const [composer, setComposer] = useState("");
  const composerRef = useRef<CopilotComposerHandle | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Focus intents consumed by effects after the open/collapse re-render.
  const focusComposerNext = useRef(false);
  const focusPillNext = useRef(false);

  function persistOpen(next: boolean) {
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey(workspaceId), next ? "1" : "0");
    } catch {
      // storage unavailable — session-only state is fine
    }
  }

  const copilot = useCopilot({
    workspaceId,
    adapter,
    enabled: open,
    allowEdits,
    ...(createWebSocket ? { createWebSocket } : {}),
    ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
  });

  // Prefill from validation affordances: open the panel + seed the composer.
  useEffect(() => {
    if (!prefill) return;
    focusComposerNext.current = true;
    persistOpen(true);
    setComposer(prefill.text);
  }, [prefill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-collapse when the viewport shrinks below the editor's comfortable
  // three-panel width — the copilot must never out-size the editor it edits.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false); // session-only; the stored pref stays
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  // Focus management: open → composer, collapse → pill.
  useEffect(() => {
    if (open && focusComposerNext.current) {
      focusComposerNext.current = false;
      composerRef.current?.focus();
    }
    if (!open && focusPillNext.current) {
      focusPillNext.current = false;
      pillRef.current?.focus();
    }
  }, [open]);

  function toggleAllowEdits() {
    // Computed outside the updater: updaters must stay pure (StrictMode
    // double-invokes them), and this one announces.
    const next = !allowEdits;
    setAllowEdits(next);
    composerRef.current?.announce(
      next
        ? "Auto-apply on — copilot edits the draft without asking"
        : "Auto-apply off — copilot asks before every edit",
    );
  }

  if (!open) {
    return (
      <button
        ref={pillRef}
        type="button"
        onClick={() => {
          focusComposerNext.current = true;
          persistOpen(true);
        }}
        aria-label="Open Copilot"
        aria-expanded={false}
        className="glass-panel lift flex h-full w-12 shrink-0 flex-col items-center gap-3 rounded-panel py-4"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={15} aria-hidden="true" />
        </span>
        <span
          className="text-[12px] font-medium tracking-tight text-ink-3"
          style={{ writingMode: "vertical-rl" }}
        >
          Copilot
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Copilot"
      className="glass-panel panel-enter flex h-full w-[clamp(260px,22vw,320px)] shrink-0 flex-col overflow-hidden"
    >
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="flex-1 text-[14px] font-semibold">Copilot</h2>
        <button
          type="button"
          onClick={() => {
            focusPillNext.current = true;
            persistOpen(false);
          }}
          aria-label="Collapse Copilot"
          aria-expanded={true}
          className="lift flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </header>
      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />

      {/* Mode row. The switch is the control; the strip below it exists so the
          mode is legible without inspecting a control's state — auto-applying
          edits to someone's agent is not a preference to hide in a widget. */}
      <div className="flex items-center px-3 pt-2.5">
        <AllowEditsSwitch checked={allowEdits} onToggle={toggleAllowEdits} />
      </div>
      {allowEdits ? <AutoApplyBanner /> : null}
      {copilot.status === "reconnecting" ? <ReconnectingBanner /> : null}

      <CopilotThread
        copilot={copilot}
        adapter={adapter}
        onFocusComposer={() => composerRef.current?.focus()}
      />

      <CopilotComposer
        ref={composerRef}
        copilot={copilot}
        allowEdits={allowEdits}
        value={composer}
        onChange={setComposer}
      />
    </aside>
  );
}
