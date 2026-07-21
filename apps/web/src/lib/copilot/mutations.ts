/**
 * WORKFLOW-surface copilot adapter (see adapter.ts for the seam).
 *
 * `proposalToActions` maps a typed workflow proposal (shared protocol:
 * `{id, tool, params, rationale}`; tools `setTrigger` / `setAgent` /
 * `setInstructions`) onto the EXISTING builder reducer actions (single
 * writer — the same path manual edits take, so autosave / dirty state /
 * validation all just work). `describeWorkflowProposal` turns a proposal +
 * the CURRENT config into the card's icon, title and compact before→after
 * preview (`setInstructions` carries a full diff instead).
 */
import { Bot, FileText, Sparkles, Zap } from "lucide-react";
import {
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  type AgentSummaryDto,
  type CopilotProposal,
  type WorkflowConfig,
  type WorkflowCopilotMutationTool,
} from "@invisible-string/shared";

import type { BuilderAction, WorkflowSection } from "../builder/model";
import { agentChipSummary, triggerSummary } from "../builder/summary";
import type { CopilotSurfaceAdapter, ProposalDescription } from "./adapter";

/** Proposals belonging to the workflow surface (any other tool = server bug). */
export type WorkflowCopilotProposal = Extract<
  CopilotProposal,
  { tool: WorkflowCopilotMutationTool }
>;

export function isWorkflowProposal(
  proposal: CopilotProposal,
): proposal is WorkflowCopilotProposal {
  return (WORKFLOW_COPILOT_MUTATION_TOOLS as readonly string[]).includes(
    proposal.tool,
  );
}

/** The section a proposal's mutation lands on (flash + card icon). */
export function sectionOfProposal(
  proposal: WorkflowCopilotProposal,
): WorkflowSection {
  switch (proposal.tool) {
    case "setTrigger":
      return "trigger";
    case "setAgent":
      return "agent";
    case "setInstructions":
      return "instructions";
  }
}

/** Map a workflow proposal to the builder reducer actions that apply it. */
export function proposalToActions(
  proposal: WorkflowCopilotProposal,
): BuilderAction[] {
  switch (proposal.tool) {
    case "setTrigger":
      return [{ type: "setTrigger", trigger: proposal.params.trigger }];
    case "setAgent":
      return [{ type: "setAgentId", id: proposal.params.agentId }];
    case "setInstructions":
      return [{ type: "setInstructions", markdown: proposal.params.markdown }];
  }
}

const SECTION_ICONS: Record<WorkflowSection, ProposalDescription["icon"]> = {
  trigger: Zap,
  agent: Bot,
  instructions: FileText,
};

/** Presentation for an off-surface proposal (server bug — apply is a no-op). */
export function unsupportedProposalDescription(
  proposal: CopilotProposal,
): ProposalDescription {
  return {
    icon: Sparkles,
    title: `Unsupported suggestion (${proposal.tool})`,
    before: null,
    after: null,
  };
}

export function describeWorkflowProposal(
  proposal: WorkflowCopilotProposal,
  definition: WorkflowConfig,
  agents: readonly AgentSummaryDto[],
): ProposalDescription {
  const icon = SECTION_ICONS[sectionOfProposal(proposal)];
  switch (proposal.tool) {
    case "setTrigger": {
      const next = triggerSummary({
        ...definition,
        trigger: proposal.params.trigger,
      });
      const current = triggerSummary(definition);
      return {
        icon,
        title: `Set trigger: ${next.typeLabel} — ${next.detail}`,
        before: `${current.typeLabel} · ${current.detail}`,
        after: `${next.typeLabel} · ${next.detail}`,
      };
    }
    case "setAgent": {
      const current = agentChipSummary(definition.agentId, agents);
      const next = agentChipSummary(proposal.params.agentId, agents);
      // Fall back to the raw id when the inventory can't resolve it, so the
      // model's intent stays visible rather than "Unknown agent" twice.
      const nextName = next.agent ? next.name : proposal.params.agentId;
      return {
        icon,
        title: `Set agent: ${nextName}`,
        before: current.status === "none" ? "No agent" : current.name,
        after: nextName,
      };
    }
    case "setInstructions": {
      const before = definition.instructions.markdown;
      return {
        icon,
        title:
          before.trim().length === 0
            ? "Write instructions"
            : "Rewrite instructions",
        before: null, // the diff carries the preview
        after: null,
        diff: { before, after: proposal.params.markdown },
      };
    }
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

const SCAFFOLD_PROMPTS = [
  "Set this up to triage Slack mentions",
  "Delegate this to the right agent",
  "Draft the instructions",
] as const;

const REFINE_PROMPTS = [
  "Tighten the instructions",
  "Explain this workflow's issues",
  "Make the trigger more specific",
] as const;

export interface WorkflowCopilotAdapterOptions {
  workflowId: string;
  /** Must read the LIVE draft (a ref-backed closure, never a stale capture). */
  getDraft: () => WorkflowConfig;
  /** The builder controller's dispatch (single writer). */
  dispatch: (action: BuilderAction) => void;
  /** Workspace agent inventory (resolves `setAgent` ids to names). */
  agents: readonly AgentSummaryDto[];
  /** Fired after an accepted proposal is applied (section flash). */
  onApplied?: (section: WorkflowSection) => void;
}

export function workflowCopilotAdapter(
  options: WorkflowCopilotAdapterOptions,
): CopilotSurfaceAdapter<WorkflowConfig> {
  const { workflowId, getDraft, dispatch, agents, onApplied } = options;
  return {
    entityRef: { surface: "workflow", entityId: workflowId },
    getDraft,
    applyProposal: (proposal) => {
      if (!isWorkflowProposal(proposal)) return;
      for (const action of proposalToActions(proposal)) dispatch(action);
      onApplied?.(sectionOfProposal(proposal));
    },
    describeProposal: (proposal) =>
      isWorkflowProposal(proposal)
        ? describeWorkflowProposal(proposal, getDraft(), agents)
        : unsupportedProposalDescription(proposal),
    emptyStateCopy: {
      title: "Build this workflow with copilot",
      description:
        "Describe what you want — suggestions land as Apply/Preview cards you can accept one by one.",
    },
    promptChips: () =>
      getDraft().instructions.markdown.trim().length === 0
        ? SCAFFOLD_PROMPTS
        : REFINE_PROMPTS,
  };
}
