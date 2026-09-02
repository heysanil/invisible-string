/**
 * Ghost step card — a dashed placeholder the strip renders at a PENDING
 * copilot proposal's target position (add / move destination). It shares the
 * mini-card grammar of the proposal preview (StepDiffPreview) so the thing on
 * the card and the thing in the strip read as one object; applying the
 * proposal removes the ghost and the REAL card takes its place with the
 * `pillar-flash` treatment (the strip's `flashStepId`).
 *
 * `panel-enter` gives the fade/slide-in; the tokens' reduced-motion block
 * clamps it to instant, so no extra guard is needed here.
 */
import { Sparkles } from "lucide-react";
import type { PipelineStepKind } from "@invisible-string/shared";

import { STEP_KIND_LABELS } from "../../lib/builder/summary";
import { STEP_KIND_ICONS } from "../../lib/copilot/mutations";
import { cn } from "../../lib/cn";

export interface GhostStepCardProps {
  kind: PipelineStepKind;
  /** Display name (name → slug → kind label — precomputed by the caller). */
  title: string;
  /** One-line summary; omitted for move ghosts (the card already exists). */
  summary?: string | undefined;
  /** "add" = a new step would land here; "move" = an existing one arrives. */
  mode: "add" | "move";
  className?: string;
}

export function GhostStepCard({
  kind,
  title,
  summary,
  mode,
  className,
}: GhostStepCardProps) {
  const Icon = STEP_KIND_ICONS[kind];
  return (
    <div
      data-testid="ghost-step-card"
      data-ghost-mode={mode}
      className={cn(
        "panel-enter flex items-start gap-2.5 rounded-card-lg border border-dashed border-ink/30 bg-white/35 px-3 py-2.5",
        className,
      )}
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
        <Icon size={12} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-[13px] leading-snug">
          <span className="truncate font-medium text-ink-2">{title}</span>
          <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-ink-4">
            {STEP_KIND_LABELS[kind]}
          </span>
        </p>
        {summary !== undefined && summary !== "" ? (
          <p className="truncate text-[12px] leading-snug text-ink-3">{summary}</p>
        ) : null}
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-4">
          <Sparkles size={10} aria-hidden="true" />
          {mode === "add"
            ? "Suggested by copilot — apply the card to add it"
            : "Moves here when the suggestion is applied"}
        </p>
      </div>
    </div>
  );
}
