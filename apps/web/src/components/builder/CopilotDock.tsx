/**
 * Copilot dock — the docked right rail in the builder (spec §12). Streams a
 * message thread over the copilot WS, renders mutation proposals as
 * structured Apply/Dismiss suggestion cards, and applies accepted mutations
 * through the builder controller's dispatch (single writer). Open/closed
 * state persists per workspace in localStorage.
 *
 * Accessibility/interaction contract:
 * - the thread is a `role="log"`; announcements go through a dedicated
 *   sr-only live region (never per-token);
 * - focus follows intent: open → composer, collapse → pill, apply/dismiss →
 *   next pending card (else composer);
 * - auto-scroll only sticks when the reader is already at the bottom;
 * - the composer never silently drops input: text stays put until the
 *   socket accepts the frame, and sends are blocked mid-turn.
 */
import {
  ArrowDown,
  ChevronRight,
  RefreshCw,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AgentPresetDto,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import type { BuilderAction, Pillar } from "../../lib/builder/model";
import type { ContextResources } from "../../lib/builder/resources";
import { pillarOfProposal, proposalToActions } from "../../lib/copilot/mutations";
import type { WebSocketFactory } from "../../lib/copilot/socket";
import { useCopilot, type CopilotThreadItem } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { Markdown } from "../chat/Markdown";
import { SuggestionCard } from "./SuggestionCard";

const OPEN_STORAGE_PREFIX = "is.copilot.open";
/** Below this viewport width the dock auto-collapses to the pill. */
const NARROW_VIEWPORT_QUERY = "(max-width: 1179px)";
/** "At the bottom" tolerance for sticky auto-scroll. */
const STICK_THRESHOLD_PX = 40;

const SCAFFOLD_PROMPTS = [
  "Set this up to triage Slack mentions",
  "Tighten the instructions",
  "Gate risky tools behind approval",
] as const;

const REFINE_PROMPTS = [
  "Tighten the instructions",
  "Explain this workflow's issues",
  "Gate risky tools behind approval",
] as const;

export interface CopilotPrefill {
  id: number;
  text: string;
}

export interface CopilotDockProps {
  workspaceId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  dispatch: React.Dispatch<BuilderAction>;
  resources: ContextResources;
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  /** Set by "ask copilot to fix" affordances — opens + seeds the composer. */
  prefill?: CopilotPrefill | null;
  /** Fired after an accepted mutation is applied (pillar flash in the rail). */
  onApplied?: (pillar: Pillar) => void;
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
  const {
    workspaceId,
    workflowId,
    definition,
    dispatch,
    resources,
    agentPresets,
    modelPresets,
    prefill,
    onApplied,
    createWebSocket,
    backoffBaseMs,
  } = props;

  const [open, setOpen] = useState(() => readStoredOpen(workspaceId));
  const [composer, setComposer] = useState("");
  const [stuckToLatest, setStuckToLatest] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const stickRef = useRef(true);
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

  // Live definition ref so getDraft always reads the current draft.
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  const copilot = useCopilot({
    workspaceId,
    workflowId,
    enabled: open,
    getDraft: () => definitionRef.current,
    applyProposal: (proposal) => {
      for (const action of proposalToActions(proposal)) dispatch(action);
      onApplied?.(pillarOfProposal(proposal));
    },
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

  // Auto-collapse when the viewport shrinks below the builder's comfortable
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

  // Keep the newest message in view — but only when the reader is already at
  // the bottom; never yank someone re-reading an earlier suggestion.
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [copilot.items]);

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
      setAnnouncement(lastAssistant ? `Copilot: ${lastAssistant.text}` : "Copilot finished");
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

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stickRef.current = nearBottom;
    setStuckToLatest(nearBottom);
  }

  function jumpToLatest() {
    const el = threadRef.current;
    if (!el) return;
    stickRef.current = true;
    setStuckToLatest(true);
    el.scrollTop = el.scrollHeight;
  }

  function submit(text: string) {
    // Only clear the composer when the frame was actually delivered — a
    // still-connecting socket or an in-flight turn keeps the text in place.
    if (copilot.send(text)) setComposer("");
  }

  /** Apply/Dismiss a card, then move focus to the next pending card (or composer). */
  function decide(itemId: string, outcome: "apply" | "dismiss") {
    const pendingIds = copilot.items
      .filter(
        (item): item is Extract<CopilotThreadItem, { kind: "suggestion" }> =>
          item.kind === "suggestion" && item.status === "pending",
      )
      .map((item) => item.id);
    if (outcome === "apply") copilot.applySuggestion(itemId);
    else copilot.dismissSuggestion(itemId);
    const remaining = pendingIds.filter((id) => id !== itemId);
    const at = pendingIds.indexOf(itemId);
    const nextId =
      remaining.find((_, index) => index >= Math.max(0, at)) ?? remaining.at(-1);
    // After React commits the receipt swap, land focus somewhere useful.
    setTimeout(() => {
      const target = nextId ? cardRefs.current.get(nextId) : undefined;
      if (target && target.isConnected) target.focus();
      else composerRef.current?.focus();
    }, 0);
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

  const isEmpty = copilot.items.length === 0;
  const reconnecting = copilot.status === "reconnecting";
  const connecting = copilot.status === "connecting";
  const canSend = copilot.status === "open" && !copilot.generating;
  const lastItem = copilot.items.at(-1);
  const streamingNow =
    lastItem?.kind === "message" &&
    lastItem.role === "assistant" &&
    lastItem.streaming;
  const promptChips =
    definition.instructions.markdown.trim().length === 0 &&
    definition.context.mcpConnectionIds.length === 0 &&
    definition.context.skillIds.length === 0
      ? SCAFFOLD_PROMPTS
      : REFINE_PROMPTS;

  return (
    <aside
      aria-label="Copilot"
      className="glass-panel panel-enter flex h-full w-[clamp(260px,22vw,320px)] shrink-0 flex-col overflow-hidden"
    >
      {/* Dedicated announcer: messages/suggestions are spoken when they
          SETTLE — the log itself is not a live region (no per-token spam). */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

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

      {reconnecting ? (
        <div
          role="status"
          className="mx-3 mt-2 flex items-center gap-1.5 rounded-card border border-warn/30 bg-warn/[0.06] px-3 py-1.5 text-[12px] text-ink-2"
        >
          <RefreshCw size={12} aria-hidden="true" className="text-warn" />
          Reconnecting — your draft will resync automatically.
        </div>
      ) : null}

      {/* Thread */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={threadRef}
          role="log"
          // role="log" implies aria-live="polite" — explicitly off so streamed
          // deltas are not re-announced token by token; the dedicated
          // announcer above speaks messages when they settle.
          aria-live="off"
          aria-label="Copilot conversation"
          onScroll={onThreadScroll}
          className="thin-scroll flex flex-1 flex-col gap-2.5 overflow-y-auto p-3"
        >
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-2 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <p className="text-[13px] font-medium text-ink">
                Build this workflow with copilot
              </p>
              <p className="text-[12px] leading-relaxed text-ink-3">
                Describe what you want — suggestions land as Apply/Preview cards
                you can accept one by one.
              </p>
              <div className="flex flex-col gap-1.5">
                {promptChips.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={!canSend}
                    onClick={() => copilot.send(prompt)}
                    className={cn(
                      "lift rounded-capsule border border-black/10 bg-white/50 px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:text-ink",
                      !canSend && "opacity-50",
                    )}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {copilot.items.map((item) => {
                if (item.kind === "suggestion") {
                  return (
                    <SuggestionCard
                      key={item.id}
                      proposal={item.proposal}
                      status={item.status}
                      definition={definition}
                      resources={resources}
                      agentPresets={agentPresets}
                      modelPresets={modelPresets}
                      onApply={() => decide(item.id, "apply")}
                      onDismiss={() => decide(item.id, "dismiss")}
                      focusRef={(el) => {
                        if (el) cardRefs.current.set(item.id, el);
                        else cardRefs.current.delete(item.id);
                      }}
                    />
                  );
                }
                if (item.kind === "error") {
                  return (
                    <p
                      key={item.id}
                      role="alert"
                      className="rounded-card border border-err/25 bg-err/[0.05] px-3 py-2 text-[12px] text-ink-2"
                    >
                      {item.text}
                    </p>
                  );
                }
                if (item.kind === "notice") {
                  return (
                    <p
                      key={item.id}
                      data-testid="copilot-notice"
                      className="px-2 py-0.5 text-center text-[11.5px] italic text-ink-3"
                    >
                      {item.text}
                    </p>
                  );
                }
                return item.role === "user" ? (
                  <div
                    key={item.id}
                    className="ml-6 self-end rounded-card-lg bg-ink px-3 py-2 text-[13px] leading-relaxed text-white"
                  >
                    {item.text}
                  </div>
                ) : (
                  <div
                    key={item.id}
                    className={cn("mr-2", item.streaming && "stream-caret")}
                  >
                    <Markdown text={item.text} className="text-[13px]" />
                  </div>
                );
              })}
              {copilot.generating && !streamingNow ? (
                <div
                  data-testid="copilot-thinking"
                  className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-ink-3"
                >
                  <span className="dot-pulse inline-block size-1.5 rounded-full bg-ink-3" />
                  {pendingCount > 0
                    ? "More suggestions may follow — respond to the card above."
                    : "Thinking…"}
                </div>
              ) : null}
            </>
          )}
        </div>

        {!stuckToLatest && !isEmpty ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="lift absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-capsule border border-black/10 bg-white/90 px-3 py-1 text-[11.5px] font-medium text-ink-2 shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
          >
            <ArrowDown size={11} aria-hidden="true" /> Jump to latest
          </button>
        ) : null}
      </div>

      {connecting && !isEmpty ? (
        <p className="px-4 pb-1 text-[11.5px] text-ink-3" role="status">
          Connecting…
        </p>
      ) : null}

      {/* Composer */}
      <form
        className="flex items-center gap-2 border-t border-black/[0.06] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(composer);
        }}
      >
        <input
          ref={composerRef}
          value={composer}
          // Delivered via onInput (React's onChange does not fire under
          // happy-dom); the noop onChange keeps React's controlled-input
          // warning quiet.
          onChange={() => {}}
          onInput={(event) =>
            setComposer((event.target as HTMLInputElement).value)
          }
          aria-label="Ask copilot"
          placeholder={connecting ? "Connecting…" : "Ask copilot…"}
          className="h-9 min-w-0 flex-1 rounded-capsule border border-black/10 bg-white/60 px-3.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus-visible:border-ink/40"
        />
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
            aria-label="Send to copilot"
            disabled={composer.trim().length === 0 || !canSend}
            className={cn(
              "lift flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-white",
              (composer.trim().length === 0 || !canSend) && "opacity-40",
            )}
          >
            <Send size={14} aria-hidden="true" />
          </button>
        )}
      </form>
    </aside>
  );
}
