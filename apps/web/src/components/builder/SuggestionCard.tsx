/**
 * Copilot suggestion card — icon + human title + rationale + preview
 * (inline diff for setInstructions, compact before→after otherwise), with
 * Apply / Dismiss capsules. Applied cards collapse to a ✓ receipt line;
 * dismissed ones to a muted receipt. Keyboard: the card is focusable and
 * Enter applies, Delete/Backspace dismisses.
 */
import { ArrowRight, Bot, Check, FileText, Plug, X, Zap } from "lucide-react";
import type { ComponentType } from "react";
import type {
  AgentPresetDto,
  CopilotProposal,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import type { Pillar } from "../../lib/builder/model";
import {
  describeProposal,
  type MutationDescription,
} from "../../lib/copilot/mutations";
import type { SuggestionStatus } from "../../lib/copilot/useCopilot";
import type { ContextResources } from "../../lib/builder/resources";
import { cn } from "../../lib/cn";
import { DiffView } from "./DiffView";

const PILLAR_ICONS: Record<Pillar, ComponentType<{ size?: number }>> = {
  trigger: Zap,
  context: Plug,
  agent: Bot,
  instructions: FileText,
};

export interface SuggestionCardProps {
  proposal: CopilotProposal;
  status: SuggestionStatus;
  definition: WorkflowDefinition;
  resources: ContextResources;
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  onApply: () => void;
  onDismiss: () => void;
}

export function SuggestionCard(props: SuggestionCardProps) {
  const {
    proposal,
    status,
    definition,
    resources,
    agentPresets,
    modelPresets,
    onApply,
    onDismiss,
  } = props;
  const description = describeProposal(
    proposal,
    definition,
    resources,
    agentPresets,
    modelPresets,
  );

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

  const Icon = PILLAR_ICONS[description.pillar];

  return (
    <div
      data-testid="suggestion-card"
      role="group"
      aria-label={`Suggestion: ${description.title}`}
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

      <SuggestionPreview
        proposal={proposal}
        description={description}
        definition={definition}
      />

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
  proposal,
  description,
  definition,
}: {
  proposal: CopilotProposal;
  description: MutationDescription;
  definition: WorkflowDefinition;
}) {
  if (proposal.tool === "setInstructions") {
    return (
      <DiffView
        before={definition.instructions.markdown}
        after={proposal.params.markdown}
      />
    );
  }
  if (description.before === null && description.after === null) return null;
  return (
    <div
      data-testid="before-after"
      className="flex flex-wrap items-center gap-1.5 rounded-card border border-black/[0.07] bg-white/45 px-2.5 py-1.5 text-[12px]"
    >
      <span className={cn("text-ink-4", "line-through decoration-ink-4/50")}>
        {description.before}
      </span>
      <ArrowRight size={12} aria-hidden="true" className="text-ink-4" />
      <span className="font-medium text-ink">{description.after}</span>
    </div>
  );
}
