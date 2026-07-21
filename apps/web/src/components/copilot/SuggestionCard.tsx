/**
 * Copilot suggestion card — icon + human title + rationale + preview
 * (inline diff when the adapter provides one, compact before→after
 * otherwise), with Apply / Dismiss capsules. Applied cards collapse to a ✓
 * receipt line; dismissed ones to a muted receipt. Keyboard: the card is
 * focusable and Enter applies, Delete/Backspace dismisses.
 *
 * Surface-agnostic: presentation arrives as a precomputed
 * {@link ProposalDescription} from the dock's {@link CopilotSurfaceAdapter} —
 * the card never touches workflow or agent draft types.
 */
import { ArrowRight, Check, X } from "lucide-react";
import { useRef } from "react";
import type { CopilotProposal } from "@invisible-string/shared";

import type { ProposalDescription } from "../../lib/copilot/adapter";
import type { SuggestionStatus } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { DiffView } from "../builder/DiffView";

export interface SuggestionCardProps {
  proposal: CopilotProposal;
  status: SuggestionStatus;
  /** Presentation computed by the surface adapter against the LIVE draft. */
  description: ProposalDescription;
  onApply: () => void;
  onDismiss: () => void;
  /** Registers the focusable card element (keyboard flow after a decision). */
  focusRef?: (element: HTMLDivElement | null) => void;
}

export function SuggestionCard(props: SuggestionCardProps) {
  const { proposal, status, onApply, onDismiss, focusRef } = props;
  const live = props.description;
  // Receipts must not drift: the description is recomputed from the LIVE
  // draft (right for a pending preview), but once the card settles the apply
  // itself changes the draft — freeze the last PENDING description and render
  // receipts from that copy.
  const frozenRef = useRef<ProposalDescription>(live);
  if (status === "pending") frozenRef.current = live;
  const description = status === "pending" ? live : frozenRef.current;

  if (status !== "pending") {
    return (
      <div
        data-testid="suggestion-receipt"
        className="flex items-center gap-1.5 rounded-card border border-black/[0.06] bg-white/30 px-3 py-1.5 text-[12px] text-ink-3"
      >
        {status === "applied" ? (
          <Check size={13} className="shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <X size={13} className="shrink-0 text-ink-4" aria-hidden="true" />
        )}
        <span className="truncate">
          {status === "applied" ? "Applied" : "Dismissed"} — {description.title}
        </span>
      </div>
    );
  }

  const Icon = description.icon;

  return (
    <div
      ref={focusRef}
      data-testid="suggestion-card"
      role="group"
      aria-label={`Suggestion: ${description.title}`}
      aria-keyshortcuts="Enter Delete"
      aria-description="Press Enter to apply, Delete to dismiss"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          onApply();
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onDismiss();
        }
      }}
      className="flex flex-col gap-2 rounded-card border border-black/[0.09] bg-white/60 p-3 shadow-[0_2px_10px_rgba(0,0,0,0.05)] outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-2">
          <Icon size={13} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-ink">
            {description.title}
          </p>
          {proposal.rationale ? (
            <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
              {proposal.rationale}
            </p>
          ) : null}
        </div>
      </div>

      <SuggestionPreview description={description} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          className="lift inline-flex h-7 items-center gap-1 rounded-capsule bg-ink px-3 text-[12px] font-medium text-white"
        >
          <Check size={12} aria-hidden="true" /> Apply
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="lift inline-flex h-7 items-center gap-1 rounded-capsule border border-black/10 bg-white/50 px-3 text-[12px] font-medium text-ink-2 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function SuggestionPreview({
  description,
}: {
  description: ProposalDescription;
}) {
  // A full-text diff wins over the compact row when the adapter provides one.
  if (description.diff) {
    return (
      <DiffView before={description.diff.before} after={description.diff.after} />
    );
  }
  if (description.before === null && description.after === null) return null;
  return (
    <div
      data-testid="before-after"
      className="flex flex-wrap items-center gap-1.5 rounded-card border border-black/[0.07] bg-white/45 px-2.5 py-1.5 text-[12px]"
    >
      <span className={cn("text-ink-3", "line-through decoration-ink-3/50")}>
        {description.before}
      </span>
      <ArrowRight size={12} aria-hidden="true" className="text-ink-4" />
      <span className="font-medium text-ink">{description.after}</span>
    </div>
  );
}
