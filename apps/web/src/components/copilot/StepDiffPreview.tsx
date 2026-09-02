/**
 * Step-mutation preview for suggestion cards (pipelines redesign) — renders
 * the {@link StepPreview} a workflow adapter precomputes: a miniature step
 * card per side (kind icon · title · chip · one-line summary), the tool/state
 * args as a key-value diff table, and prompt/instructions markdown through
 * the existing {@link DiffView}.
 *
 * Treatments by mode (the ghost-proposal vocabulary, at card scale):
 * - add    — one dashed "ghost" card + a position line;
 * - remove — one card with the title struck through;
 * - update — before card (muted) → after card, then the arg/markdown diffs;
 * - move   — one card + where it goes.
 *
 * Purely presentational: all pipeline-type knowledge lives in the adapter
 * (lib/copilot/mutations.ts); this file only maps display data to E1 chrome.
 */
import { ArrowRight, CornerDownRight } from "lucide-react";

import type { ArgsDiffRow, StepCardData, StepPreview } from "../../lib/copilot/adapter";
import { STEP_KIND_LABELS } from "../../lib/builder/summary";
import { STEP_KIND_ICONS } from "../../lib/copilot/mutations";
import { cn } from "../../lib/cn";
import { DiffView } from "../builder/DiffView";

function MiniStepCard({
  card,
  treatment,
}: {
  card: StepCardData;
  treatment: "normal" | "ghost" | "removed" | "muted";
}) {
  const Icon = STEP_KIND_ICONS[card.kind];
  return (
    <div
      data-testid="step-mini-card"
      className={cn(
        "flex items-start gap-2 rounded-card border px-2.5 py-2",
        treatment === "ghost" && "border-dashed border-ink/25 bg-white/40",
        treatment === "removed" && "border-black/[0.07] bg-white/30 opacity-80",
        treatment === "muted" && "border-black/[0.07] bg-white/30",
        treatment === "normal" && "border-black/[0.09] bg-white/50",
      )}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-2">
        <Icon size={11} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-[12px] leading-snug">
          <span
            className={cn(
              "truncate font-medium",
              treatment === "removed"
                ? "text-ink-3 line-through decoration-ink-3/60"
                : "text-ink",
            )}
          >
            {card.title}
          </span>
          <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-ink-4">
            {STEP_KIND_LABELS[card.kind]}
          </span>
          {card.chip !== null ? (
            <span className="max-w-[40%] shrink-0 truncate rounded-capsule border border-black/[0.08] bg-white/60 px-1.5 text-[10.5px] text-ink-3">
              {card.chip}
            </span>
          ) : null}
        </p>
        <p
          className={cn(
            "truncate text-[11.5px] leading-snug",
            treatment === "removed" ? "text-ink-4" : "text-ink-3",
          )}
        >
          {card.summary}
        </p>
      </div>
    </div>
  );
}

function PositionLine({ position }: { position: string }) {
  return (
    <p className="flex items-center gap-1 text-[11.5px] text-ink-3">
      <CornerDownRight size={11} aria-hidden="true" className="text-ink-4" />
      {position}
    </p>
  );
}

function ArgsDiffTable({ rows }: { rows: readonly ArgsDiffRow[] }) {
  return (
    <div
      data-testid="args-diff"
      className="overflow-hidden rounded-card border border-black/[0.07] bg-white/45"
    >
      <table className="w-full border-collapse text-[11.5px]">
        <caption className="sr-only">Argument changes</caption>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-changed={row.changed || undefined}
              className="border-b border-black/[0.05] last:border-b-0"
            >
              <th
                scope="row"
                className="w-[34%] max-w-0 truncate px-2 py-1 text-left align-top font-mono font-medium text-ink-2"
              >
                {row.key}
              </th>
              <td className="px-2 py-1 align-top">
                {row.changed ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {row.before !== null ? (
                      <span className="break-all font-mono text-ink-3 line-through decoration-ink-3/50">
                        {row.before}
                      </span>
                    ) : null}
                    {row.before !== null && row.after !== null ? (
                      <ArrowRight size={10} aria-hidden="true" className="shrink-0 text-ink-4" />
                    ) : null}
                    {row.after !== null ? (
                      <span className="break-all font-mono font-medium text-ink">
                        {row.after}
                      </span>
                    ) : (
                      <span className="text-[10.5px] uppercase tracking-wide text-ink-4">
                        removed
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="break-all font-mono text-ink-3">{row.after}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StepDiffPreview({ preview }: { preview: StepPreview }) {
  return (
    <div data-testid="step-preview" className="flex flex-col gap-1.5">
      {preview.mode === "update" && preview.after !== null ? (
        // Before → after cards only when the HEADLINE changed — two identical
        // cards would say nothing the args/markdown diff below doesn't.
        preview.before !== null &&
        (preview.before.title !== preview.after.title ||
          preview.before.chip !== preview.after.chip ||
          preview.before.kind !== preview.after.kind) ? (
          <>
            <MiniStepCard card={preview.before} treatment="muted" />
            <MiniStepCard card={preview.after} treatment="normal" />
          </>
        ) : (
          <MiniStepCard card={preview.after} treatment="normal" />
        )
      ) : null}
      {preview.mode === "add" && preview.after !== null ? (
        <MiniStepCard card={preview.after} treatment="ghost" />
      ) : null}
      {preview.mode === "remove" && preview.before !== null ? (
        <MiniStepCard card={preview.before} treatment="removed" />
      ) : null}
      {preview.mode === "move" && preview.before !== null ? (
        <MiniStepCard card={preview.before} treatment="normal" />
      ) : null}

      {preview.position !== undefined ? (
        <PositionLine position={preview.position} />
      ) : null}

      {preview.argsDiff !== undefined && preview.argsDiff.length > 0 ? (
        <ArgsDiffTable rows={preview.argsDiff} />
      ) : null}

      {preview.markdownDiff !== undefined ? (
        <DiffView
          before={preview.markdownDiff.before}
          after={preview.markdownDiff.after}
        />
      ) : null}
    </div>
  );
}
