/**
 * Inline HITL card for an `input.requested` frame — the approve/deny capsule
 * pattern from the mockups (amber-bordered glass; amber is E1's "waiting on
 * you", the same meaning StatusDot's waiting dot carries).
 *
 * Three kinds ride this ONE event, and they are told apart by eve 0.31's
 * `kind` discriminator — never by tool name (see run-view's
 * `inputRequestKindOf`):
 *
 * - `tool-approval` — a gate in front of a real side effect. Shows the tool
 *   chip + argument preview, because *what* is about to run is the decision.
 * - `question`      — the agent asking (`ask_question`). No tool chip: the
 *   gating "tool" is plumbing, and showing it reads as a scary approval.
 * - `session-limit` — eve's 40M-input-token guardrail (NEW in 0.31). Rendered
 *   as an APPROVE-ONLY prompt: granting a fresh budget window is the only
 *   thing this card decides. eve's own "Stop now" option is filtered out — it
 *   ends the turn through the same `turn.cancelled` path as the composer's
 *   Stop, which is permanently mounted, so offering both put two controls for
 *   one decision side by side. Its backing "tool"
 *   (`session_limit_continuation`) and raw token counters are suppressed;
 *   eve's own per-option descriptions carry the consequence.
 *
 * An optimistic pending state holds while `POST /runs/:id/input` is in flight.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Gauge,
  MessageCircleQuestion,
  type LucideIcon,
} from "lucide-react";

import type { RunInputRequest } from "@invisible-string/shared";

import type { PendingInputView } from "../../lib/chat/run-view";
import { cn } from "../../lib/cn";
import { Chip } from "./Chip";

// Satisfies React's controlled-input contract (value without onChange warns).
// The consumer's update rides onInput, matching the shared Input primitive:
// React's synthetic onChange never fires for text inputs under happy-dom, and
// both props ride the same native `input` event in real browsers — so this is
// deliberate, not a fragile fork. See components/ui/Input.tsx for the rationale.
function noopChange() {}

/**
 * Per-kind presentation. The accessible group name is part of the contract —
 * a screen-reader user must hear which of the three decisions this is before
 * the prompt text, and the E2E specs address the card by it.
 */
const KIND_PRESENTATION: Record<
  PendingInputView["kind"],
  { icon: LucideIcon; groupLabel: string; eyebrow: string }
> = {
  "tool-approval": {
    icon: AlertTriangle,
    groupLabel: "Approval requested",
    eyebrow: "Approval",
  },
  question: {
    icon: MessageCircleQuestion,
    groupLabel: "Question from the agent",
    eyebrow: "Question",
  },
  "session-limit": {
    icon: Gauge,
    groupLabel: "Session limit reached",
    eyebrow: "Session limit",
  },
};

export interface ApprovalCardProps {
  input: PendingInputView;
  /** Disabled once the run resumes elsewhere or another card is answering. */
  disabled?: boolean;
  onRespond: (response: RunInputRequest) => void;
  /** The optionId/text currently being submitted (optimistic highlight). */
  pending?: { optionId?: string; text?: string } | null;
  error?: string | null;
}

export function ApprovalCard({
  input,
  disabled,
  onRespond,
  pending,
  error,
}: ApprovalCardProps) {
  const [text, setText] = useState("");
  const isPending = pending != null;
  const showFreeform = input.allowFreeform || input.display === "text";
  const { icon: KindIcon, groupLabel, eyebrow } = KIND_PRESENTATION[input.kind];
  // Only the budget prompt earns per-option help text — eve authors it there
  // ("Grant a fresh token budget" / "Stop now") and nowhere else.
  const showOptionDescriptions = input.kind === "session-limit";

  // Drop the session-limit prompt's own "Stop now".
  //
  // It is eve's option, not ours, and it ends the turn through the SAME
  // `turn.cancelled` path the composer's Stop uses — so with Stop now living
  // on the composer, permanently mounted and reachable without scrolling, this
  // is a second control for one decision sitting a few pixels from the first.
  // Two buttons that mean the same thing is worse than one, and the one that
  // survives is the one present for every run, parked or not.
  //
  // Routed on eve's own `style === "danger"` marker rather than the label, and
  // only for `session-limit`: a tool-approval's danger option is a real REFUSAL
  // ("Deny"), which the composer's Stop cannot express. The `remaining.length`
  // guard means a future eve build that marks every option danger degrades to
  // showing them all rather than to a card with nothing to click.
  const optionsForKind =
    input.kind === "session-limit"
      ? (() => {
          const remaining = input.options.filter(
            (option) => option.style !== "danger",
          );
          return remaining.length > 0 ? remaining : input.options;
        })()
      : input.options;
  const hasOptions = optionsForKind.length > 0;

  return (
    <div
      role="group"
      aria-label={groupLabel}
      data-input-kind={input.kind}
      className="my-2 rounded-card border border-warn/45 bg-warn/[0.06] p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <KindIcon
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warn"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-4">
            {eyebrow}
          </p>
          <p className="mt-0.5 text-[13px] font-medium leading-snug text-ink">
            {input.prompt}
          </p>
          {input.toolName !== null ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Chip mono>{input.toolName}</Chip>
              {input.argsPreview !== null ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">
                  {input.argsPreview}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {hasOptions ? (
        <div
          className={cn(
            "mt-3 flex flex-wrap gap-2",
            showOptionDescriptions && "flex-col items-stretch sm:flex-row",
          )}
        >
          {optionsForKind.map((option) => {
            const active = pending?.optionId === option.id;
            // eve marks the session-limit "Stop" option `danger`, but stopping
            // is the same user decision the Stop button makes — and this whole
            // surface refuses to paint that in error red (E1: colour only as
            // meaning). Solid red stays for a real refusal, like denying a
            // side-effecting tool call.
            const danger = option.style === "danger" && input.kind !== "session-limit";
            const primary = option.style === "primary" || option.id === "approve";
            const description = showOptionDescriptions ? option.description : undefined;
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled || isPending}
                aria-busy={active || undefined}
                onClick={() => onRespond({ requestId: input.requestId, optionId: option.id })}
                className={cn(
                  // `gap` lives in the variant, NOT the base: `cn` is a plain
                  // join with no tailwind-merge, so a base `gap-1.5` would
                  // still be emitted alongside the stacked variant's `gap-0`
                  // and win on source order.
                  "lift inline-flex items-center justify-center rounded-capsule px-4 text-[13px] font-medium",
                  description === undefined ? "h-8 gap-1.5" : "min-h-8 flex-col py-1.5",
                  "disabled:pointer-events-none disabled:opacity-55",
                  danger
                    ? "bg-err text-white"
                    : primary
                      ? "bg-ink text-white"
                      : "border border-black/10 bg-white/50 text-ink hover:bg-white/80",
                  active && "ring-2 ring-ink/25",
                )}
              >
                {option.label}
                {description !== undefined ? (
                  <span className="text-[11px] font-normal opacity-75">
                    {description}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {showFreeform ? (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (value.length === 0 || disabled || isPending) return;
            onRespond({ requestId: input.requestId, text: value });
          }}
        >
          <input
            aria-label="Your response"
            value={text}
            disabled={disabled || isPending}
            onChange={noopChange}
            onInput={(event) => setText((event.target as HTMLInputElement).value)}
            placeholder="Type a response…"
            className="h-9 flex-1 rounded-capsule border border-black/10 bg-white/60 px-4 text-sm text-ink outline-none placeholder:text-ink-4 focus-visible:border-black/20 focus-visible:ring-2 focus-visible:ring-ink/20 disabled:opacity-55"
          />
          <button
            type="submit"
            disabled={disabled || isPending || text.trim().length === 0}
            className="lift inline-flex h-9 items-center rounded-capsule bg-ink px-4 text-[13px] font-medium text-white disabled:pointer-events-none disabled:opacity-55"
          >
            Send
          </button>
        </form>
      ) : null}

      {error !== null && error !== undefined ? (
        <p role="alert" className="mt-2 text-xs text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
