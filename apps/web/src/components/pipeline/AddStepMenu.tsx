/**
 * "Add a step" menu body — the seven config step kinds (kind icon · label ·
 * one-line description) plus the "Describe it instead →" hand-off that
 * focuses the copilot composer (conversational-first authoring: the menu is
 * the direct-manipulation lane, the composer the primary one).
 *
 * Pure menu CONTENT — the connector/strip owns the popover it lives in.
 * `allowForEach: false` hides the loop kind (no nested for_each in v1; hiding
 * beats letting the author create a draft the validator immediately rejects).
 */
import { ArrowRight } from "lucide-react";
import { PIPELINE_STEP_KINDS, type PipelineStepKind } from "@invisible-string/shared";

import { STEP_KIND_LABELS } from "../../lib/builder/summary";
import { STEP_KIND_ICONS } from "../../lib/copilot/mutations";

const KIND_DESCRIPTIONS: Record<PipelineStepKind, string> = {
  tool: "Call one MCP tool on a connection",
  infer: "A cheap model turn with a prompt",
  agent: "Delegate to a published Agent",
  for_each: "Repeat steps per item of a list",
  branch: "Run different steps by condition",
  filter: "Continue only when a condition holds",
  state: "Write keys that persist across runs",
};

export interface AddStepMenuProps {
  onPick: (kind: PipelineStepKind) => void;
  /** Focus the copilot composer instead ("Describe it instead →"). */
  onDescribe?: (() => void) | undefined;
  /** False inside a for_each body (no nested loops in v1). */
  allowForEach?: boolean;
}

export function AddStepMenu({
  onPick,
  onDescribe,
  allowForEach = true,
}: AddStepMenuProps) {
  const kinds = PIPELINE_STEP_KINDS.filter(
    (kind) => allowForEach || kind !== "for_each",
  );
  return (
    <div role="menu" aria-label="Add a step" className="flex w-64 flex-col gap-0.5">
      {kinds.map((kind) => {
        const Icon = STEP_KIND_ICONS[kind];
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(kind)}
            className="flex items-start gap-2.5 rounded-card px-2.5 py-2 text-left transition-colors duration-150 ease-out hover:bg-black/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-2">
              <Icon size={12} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[12.5px] font-medium text-ink">
                {STEP_KIND_LABELS[kind]}
              </span>
              <span className="text-[11.5px] leading-snug text-ink-3">
                {KIND_DESCRIPTIONS[kind]}
              </span>
            </span>
          </button>
        );
      })}
      {onDescribe ? (
        <button
          type="button"
          role="menuitem"
          onClick={onDescribe}
          className="mt-1 flex items-center justify-between gap-2 rounded-card border-t border-black/[0.06] px-2.5 py-2 text-left text-[12.5px] font-medium text-ink-2 transition-colors duration-150 ease-out hover:bg-black/[0.05] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          Describe it instead
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
