/**
 * Copilot THREAD — the `role="log"` conversation body shared by the docked
 * rail (CopilotDock, agent editor) and the workflow editor's ComposerPane.
 * Renders the empty state + prompt chips, streamed messages, work blocks
 * (rail-in-box, spec D7.1), suggestion cards, error/notice rows, the thinking
 * indicator, and the jump-to-latest affordance; owns the Apply/Dismiss focus
 * choreography (decide → next pending card, else the composer via
 * {@link CopilotThreadProps.onFocusComposer}).
 *
 * Surface-agnostic on purpose: entity identity, proposal presentation and
 * prompt chips all ride the injected {@link CopilotSurfaceAdapter}; the shell
 * owns the socket (via useCopilot) and hands the resulting {@link CopilotApi}
 * down.
 *
 * Accessibility contract (moved verbatim from the dock):
 * - the thread is a `role="log"` with `aria-live="off"` — announcements go
 *   through the composer's dedicated live region, never per-token;
 * - auto-scroll only sticks when the reader is already at the bottom;
 * - apply/dismiss moves focus to the next pending card (else the composer).
 */
import { ArrowDown, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CopilotSurfaceAdapter } from "../../lib/copilot/adapter";
import {
  proposalIdsOf,
  visibleTimelineItems,
  type CopilotThreadItem,
} from "../../lib/copilot/thread";
import type { CopilotApi } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { Markdown } from "../chat/Markdown";
import { CopilotWorkBlock } from "./CopilotWorkBlock";
import { SuggestionCard } from "./SuggestionCard";

/** "At the bottom" tolerance for sticky auto-scroll. */
const STICK_THRESHOLD_PX = 40;

export interface CopilotThreadProps {
  copilot: CopilotApi;
  adapter: CopilotSurfaceAdapter;
  /** Focus fallback after Apply/Dismiss when no pending card remains. */
  onFocusComposer: () => void;
}

export function CopilotThread(props: CopilotThreadProps) {
  const { copilot, adapter, onFocusComposer } = props;

  const [stuckToLatest, setStuckToLatest] = useState(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const stickRef = useRef(true);

  // Keep the newest message in view — but only when the reader is already at
  // the bottom; never yank someone re-reading an earlier suggestion.
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [copilot.items]);

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
      else onFocusComposer();
    }, 0);
  }

  const isEmpty = copilot.items.length === 0;
  const canSend = copilot.status === "open" && !copilot.generating;
  const pendingCount = copilot.items.filter(
    (item) => item.kind === "suggestion" && item.status === "pending",
  ).length;
  const lastItem = copilot.items.at(-1);
  // Something visible is already moving: streaming prose, or a live work box
  // with its own spinner. Only when neither is true does the dots line earn
  // its place — two spinners for one wait reads as two waits.
  const streamingNow =
    (lastItem?.kind === "message" &&
      lastItem.role === "assistant" &&
      lastItem.streaming) ||
    (lastItem?.kind === "work" && !lastItem.sealed);
  const promptChips = adapter.promptChips();
  const emptyCopy = adapter.emptyStateCopy;
  // Every mutation step carries a card; the card is the richer rendering, so
  // the rail shows only what has none (thinking + self-corrected bad calls).
  const cardedStepKeys = proposalIdsOf(copilot.items);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={threadRef}
        role="log"
        // role="log" implies aria-live="polite" — explicitly off so streamed
        // deltas are not re-announced token by token; the composer's dedicated
        // announcer speaks messages when they settle.
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
            <p className="text-[13px] font-medium text-ink">{emptyCopy.title}</p>
            <p className="text-[12px] leading-relaxed text-ink-3">
              {emptyCopy.description}
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
              if (item.kind === "work") {
                const rows = visibleTimelineItems(item.items, cardedStepKeys);
                // A box whose every row had a card would be an empty box.
                if (rows.length === 0) return null;
                return (
                  <CopilotWorkBlock
                    key={item.id}
                    items={rows}
                    active={!item.sealed && copilot.generating}
                  />
                );
              }
              if (item.kind === "suggestion") {
                return (
                  <SuggestionCard
                    key={item.id}
                    proposal={item.proposal}
                    status={item.status}
                    autoApplied={item.autoApplied}
                    description={adapter.describeProposal(item.proposal)}
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
                // Markdown, for the same reason as the chat bubble: the
                // composer below emits it, so plain text would echo the
                // author's own syntax back at them.
                <div
                  key={item.id}
                  className="ml-6 self-end rounded-card-lg bg-ink px-3 py-2 text-white"
                >
                  <Markdown
                    text={item.text}
                    className="md-on-ink text-[13px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  />
                </div>
              ) : (
                <div key={item.id} className="mr-2">
                  <Markdown
                    text={item.text}
                    className="text-[13px]"
                    streaming={item.streaming}
                  />
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
  );
}
