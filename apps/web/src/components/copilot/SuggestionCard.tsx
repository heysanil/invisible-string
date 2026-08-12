/**
 * Copilot suggestion card — icon + human title + rationale + preview
 * (inline diff when the adapter provides one, compact before→after
 * otherwise), with Apply / Dismiss capsules. Applied cards collapse to a ✓
 * receipt line; dismissed ones to a muted receipt. Keyboard: the card is
 * focusable and Enter applies, Delete/Backspace dismisses.
 *
 * Not every apply is instant, and not every apply succeeds: the agent rename
 * is a PATCH. So the card has two more states than a receipt-or-not binary —
 * `applying` keeps the card up with its controls locked (one accept, no
 * premature claim), and `failed` is a receipt that says the change did NOT
 * land. A card that printed "Applied" over a failed write would be the one
 * thing a receipt may never do.
 *
 * Surface-agnostic: presentation arrives as a precomputed
 * {@link ProposalDescription} from the dock's {@link CopilotSurfaceAdapter} —
 * the card never touches workflow or agent draft types.
 */
import { AlertTriangle, ArrowRight, Check, X } from "lucide-react";
import { useRef } from "react";
import type { CopilotProposal } from "@invisible-string/shared";

import type { ProposalDescription } from "../../lib/copilot/adapter";
import type { SuggestionStatus } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { DiffView } from "../builder/DiffView";
import { Spinner } from "../ui/Spinner";

export interface SuggestionCardProps {
  proposal: CopilotProposal;
  status: SuggestionStatus;
  /**
   * Applied without an accept gate (allow-edits, spec D7.2). The card exists
   * precisely so an unasked edit still leaves a trace, so the receipt must
   * SAY it was automatic — "Applied" alone would read as "you applied this".
   */
  autoApplied?: boolean;
  /** Presentation computed by the surface adapter against the LIVE draft. */
  description: ProposalDescription;
  onApply: () => void;
  onDismiss: () => void;
  /** Registers the focusable card element (keyboard flow after a decision). */
  focusRef?: (element: HTMLDivElement | null) => void;
}

export function SuggestionCard(props: SuggestionCardProps) {
  const { proposal, status, autoApplied, onApply, onDismiss, focusRef } = props;
  const live = props.description;
  // Receipts must not drift: the description is recomputed from the LIVE
  // draft (right for a pending preview), but once the card settles the apply
  // itself changes the draft — freeze the last UNSETTLED description and
  // render receipts from that copy.
  const settling = status === "pending" || status === "applying";
  const frozenRef = useRef<ProposalDescription>(live);
  if (settling) frozenRef.current = live;
  const description = settling ? live : frozenRef.current;

  if (!settling) {
    return (
      <div
        data-testid="suggestion-receipt"
        // A failed apply is a real outcome the user must not scroll past —
        // the other two receipts are quiet by design, this one alerts.
        {...(status === "failed" ? { role: "alert" as const } : {})}
        className={cn(
          "flex items-center gap-1.5 rounded-card border px-3 py-1.5 text-[12px]",
          status === "failed"
            ? "border-err/25 bg-err/[0.05] text-ink-2"
            : "border-black/[0.06] bg-white/30 text-ink-3",
        )}
      >
        {status === "applied" ? (
          <Check size={13} className="shrink-0 text-ok" aria-hidden="true" />
        ) : status === "failed" ? (
          <AlertTriangle size={13} className="shrink-0 text-err" aria-hidden="true" />
        ) : (
          <X size={13} className="shrink-0 text-ink-4" aria-hidden="true" />
        )}
        <span className="truncate">
          {status === "applied"
            ? autoApplied
              ? "Applied automatically"
              : "Applied"
            : status === "failed"
              ? "Couldn’t apply"
              : "Dismissed"}{" "}
          — {description.title}
        </span>
      </div>
    );
  }

  const Icon = description.icon;
  // While the write is in flight the card stays put, but nothing about it is
  // actionable: a second accept would double-apply, and Dismiss can no longer
  // reach the server (the outcome frame for this proposal is already owed).
  const busy = status === "applying";

  return (
    <div
      ref={focusRef}
      data-testid="suggestion-card"
      role="group"
      aria-label={`Suggestion: ${description.title}`}
      aria-busy={busy || undefined}
      aria-keyshortcuts="Enter Delete"
      aria-description="Press Enter to apply, Delete to dismiss"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (busy) return;
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
          disabled={busy}
          className={cn(
            "lift inline-flex h-7 items-center gap-1 rounded-capsule bg-ink px-3 text-[12px] font-medium text-white",
            busy && "opacity-60",
          )}
        >
          {busy ? (
            <Spinner size={12} className="text-white" />
          ) : (
            <Check size={12} aria-hidden="true" />
          )}{" "}
          {busy ? "Applying…" : "Apply"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className={cn(
            "lift inline-flex h-7 items-center gap-1 rounded-capsule border border-black/10 bg-white/50 px-3 text-[12px] font-medium text-ink-2 hover:text-ink",
            busy && "opacity-50",
          )}
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
