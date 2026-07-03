/**
 * Inline HITL card for an `input.requested` frame — the exact approve/deny
 * capsule pattern from the mockups (amber-bordered glass). Handles both
 * option-based approvals/questions and free-form text requests, with an
 * optimistic pending state while `POST /runs/:id/input` is in flight.
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";

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
  const hasOptions = input.options.length > 0;

  return (
    <div
      role="group"
      aria-label="Approval requested"
      className="my-2 rounded-card border border-warn/45 bg-warn/[0.06] p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warn"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-ink">
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
        <div className="mt-3 flex flex-wrap gap-2">
          {input.options.map((option) => {
            const active = pending?.optionId === option.id;
            const danger = option.style === "danger";
            const primary = option.style === "primary" || option.id === "approve";
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled || isPending}
                aria-busy={active || undefined}
                onClick={() => onRespond({ requestId: input.requestId, optionId: option.id })}
                className={cn(
                  "lift inline-flex h-8 items-center gap-1.5 rounded-capsule px-4 text-[13px] font-medium",
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
