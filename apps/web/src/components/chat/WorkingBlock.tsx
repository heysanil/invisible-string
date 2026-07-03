/**
 * The collapsible working block (design decision C). While a run streams it
 * shows live step rows (tool name in mono + one-line result + ✓/⏸/✗) and,
 * subtly, interim narration and a truncated reasoning line. On completion it
 * auto-collapses to "Worked for Ns · N steps"; any past block re-expands on
 * click.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Loader2, Pause, X } from "lucide-react";

import type { StepRowView, WorkingBlockView } from "../../lib/chat/run-view";
import { cn } from "../../lib/cn";

function StepIcon({ state }: { state: StepRowView["state"] }) {
  switch (state) {
    case "ok":
      return <Check size={13} strokeWidth={2.4} className="text-ok" aria-hidden="true" />;
    case "error":
      return <X size={13} strokeWidth={2.4} className="text-err" aria-hidden="true" />;
    case "rejected":
      return <X size={13} strokeWidth={2.4} className="text-ink-4" aria-hidden="true" />;
    case "awaiting":
      return <Pause size={13} strokeWidth={2.2} className="text-warn" aria-hidden="true" />;
    default:
      return (
        <Loader2 size={13} className="animate-spin text-ink-4" aria-hidden="true" />
      );
  }
}

const STEP_STATE_LABEL: Record<StepRowView["state"], string> = {
  ok: "succeeded",
  error: "failed",
  rejected: "rejected",
  awaiting: "awaiting approval",
  pending: "running",
};

function StepRow({ step }: { step: StepRowView }) {
  return (
    <li className="flex items-start gap-2 py-1">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <StepIcon state={step.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[12px] text-ink">{step.toolName}</span>
        <span className="sr-only">{STEP_STATE_LABEL[step.state]}</span>
        {step.resultPreview !== null ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
            {step.resultPreview}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function WorkingBlock({ block }: { block: WorkingBlockView }) {
  // Live blocks default open; completed blocks default collapsed.
  const [open, setOpen] = useState(block.active);
  // When a block transitions active → done, collapse it once (auto-fold).
  const [wasActive, setWasActive] = useState(block.active);
  useEffect(() => {
    if (wasActive && !block.active) setOpen(false);
    if (block.active && !wasActive) setOpen(true);
    setWasActive(block.active);
  }, [block.active, wasActive]);

  const summary = useMemo(() => {
    const stepCount = block.steps.length;
    const stepLabel = stepCount === 1 ? "1 step" : `${stepCount} steps`;
    if (block.active) return "Working…";
    if (block.elapsedSeconds !== null) {
      return `Worked for ${block.elapsedSeconds}s · ${stepLabel}`;
    }
    return `Worked · ${stepLabel}`;
  }, [block.active, block.elapsedSeconds, block.steps.length]);

  return (
    <div className="my-1.5 overflow-hidden rounded-card border border-black/[0.06] bg-white/35">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="lift flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.02]"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-4 transition-transform duration-150 ease-out",
            open && "rotate-90",
          )}
        />
        {block.active ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
        ) : null}
        <span className="text-[12.5px] font-medium text-ink-2">{summary}</span>
      </button>

      {/* Animate the fold with a grid-rows 0fr↔1fr transition so the block eases
          closed on completion instead of popping out of the tree. The global
          prefers-reduced-motion guard zeroes the transition. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="border-t border-black/[0.05] px-3 pb-2.5 pt-1.5">
            {block.reasoning !== null ? (
              <p className="mb-1 line-clamp-2 text-[12px] italic leading-relaxed text-ink-4">
                {block.reasoning}
              </p>
            ) : null}
            {block.steps.length > 0 ? (
              <ul className="flex flex-col">
                {block.steps.map((step) => (
                  <StepRow key={step.key} step={step} />
                ))}
              </ul>
            ) : null}
            {block.narration.map((line, index) => (
              <p key={index} className="mt-1 text-[12px] leading-relaxed text-ink-3">
                {line}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
