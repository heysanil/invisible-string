/**
 * AGENT-surface copilot adapter (see adapter.ts for the seam).
 *
 * Maps the agent toolset (`setPersona` / `setModel` / `addContext` /
 * `removeContext`) onto the agent editor reducer actions (single writer —
 * the same path manual edits take). `setPersona` previews as a full DiffView
 * diff (persona is a document, like workflow instructions); the rest get the
 * compact before→after row.
 */
import { Cpu, FileText, Plug } from "lucide-react";
import {
  AGENT_COPILOT_MUTATION_TOOLS,
  type AgentCopilotMutationTool,
  type AgentDefinition,
  type AgentModel,
  type CopilotProposal,
} from "@invisible-string/shared";

import type { AgentEditorAction, AgentSection } from "../agents/model";
import type { ContextResources } from "../builder/resources";
import { shortModelId } from "../builder/summary";
import type { CopilotSurfaceAdapter, ProposalDescription } from "./adapter";
import { unsupportedProposalDescription } from "./mutations";

/** Proposals belonging to the agent surface (any other tool = server bug). */
export type AgentCopilotProposal = Extract<
  CopilotProposal,
  { tool: AgentCopilotMutationTool }
>;

export function isAgentProposal(
  proposal: CopilotProposal,
): proposal is AgentCopilotProposal {
  return (AGENT_COPILOT_MUTATION_TOOLS as readonly string[]).includes(
    proposal.tool,
  );
}

/**
 * The editor section a proposal lands on (rail flash + card icon). The
 * copilot never touches "access" — run-as is a human trust decision.
 */
export function agentSectionOfProposal(
  proposal: AgentCopilotProposal,
): AgentSection {
  switch (proposal.tool) {
    case "setPersona":
      return "persona";
    case "setModel":
      return "model";
    case "addContext":
    case "removeContext":
      return "context";
  }
}

/** Map an agent proposal to the editor reducer actions that apply it. */
export function agentProposalToActions(
  proposal: AgentCopilotProposal,
): AgentEditorAction[] {
  switch (proposal.tool) {
    case "setPersona":
      return [{ type: "setPersona", markdown: proposal.params.markdown }];
    case "setModel": {
      // Fan out to one action per provided field (the schema guarantees at
      // least one) — untouched fields keep their current values.
      const { preset, modelId, reasoning } = proposal.params;
      const actions: AgentEditorAction[] = [];
      if (preset !== undefined) actions.push({ type: "setModelPreset", preset });
      if (modelId !== undefined) actions.push({ type: "setModelId", modelId });
      if (reasoning !== undefined) {
        actions.push({ type: "setReasoning", reasoning });
      }
      return actions;
    }
    case "addContext":
      return [
        proposal.params.kind === "connection"
          ? { type: "addConnection", id: proposal.params.id }
          : { type: "addSkill", id: proposal.params.id },
      ];
    case "removeContext":
      return [
        proposal.params.kind === "connection"
          ? { type: "removeConnection", id: proposal.params.id }
          : { type: "removeSkill", id: proposal.params.id },
      ];
  }
}

// ── Descriptions ─────────────────────────────────────────────────────────────

function contextName(
  params: { kind: "connection" | "skill"; id: string },
  resources: ContextResources,
): string {
  if (params.kind === "connection") {
    return resources.connectionById.get(params.id)?.name ?? params.id;
  }
  return resources.skillById.get(params.id)?.name ?? params.id;
}

function sourceCount(count: number): string {
  return `${count} source${count === 1 ? "" : "s"}`;
}

/** Compact one-liner for the current model block, e.g. "balanced · reasoning medium". */
function modelLine(model: AgentModel): string {
  const base = model.modelId
    ? `override → ${shortModelId(model.modelId)}`
    : model.preset;
  return `${base} · reasoning ${model.reasoning}`;
}

export function describeAgentProposal(
  proposal: AgentCopilotProposal,
  definition: AgentDefinition,
  resources: ContextResources,
): ProposalDescription {
  switch (proposal.tool) {
    case "setPersona": {
      const before = definition.persona;
      return {
        icon: FileText,
        title:
          before.trim().length === 0 ? "Write persona" : "Rewrite persona",
        before: null, // the diff carries the preview
        after: null,
        diff: { before, after: proposal.params.markdown },
      };
    }
    case "setModel": {
      const { preset, modelId, reasoning } = proposal.params;
      const parts: string[] = [];
      if (preset !== undefined) parts.push(`preset ${preset}`);
      if (modelId !== undefined) parts.push(`model ${shortModelId(modelId)}`);
      if (reasoning !== undefined) parts.push(`reasoning ${reasoning}`);
      return {
        icon: Cpu,
        title: `Set model: ${parts.join(" · ")}`,
        before: modelLine(definition.model),
        after: parts.join(" · "),
      };
    }
    case "addContext": {
      const name = contextName(proposal.params, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        icon: Plug,
        title: `Add ${proposal.params.kind}: ${name}`,
        before: sourceCount(count),
        after: `${sourceCount(count + 1)} — + ${name}`,
      };
    }
    case "removeContext": {
      const name = contextName(proposal.params, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        icon: Plug,
        title: `Remove ${proposal.params.kind}: ${name}`,
        before: sourceCount(count),
        after: `${sourceCount(Math.max(0, count - 1))} — − ${name}`,
      };
    }
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

const SCAFFOLD_PROMPTS = [
  "Draft a persona for an executive assistant",
  "Attach the right tools for email and calendar",
  "Make this agent more cautious with approvals",
] as const;

const REFINE_PROMPTS = [
  "Tighten the persona",
  "Explain this agent's issues",
] as const;

export interface AgentCopilotAdapterOptions {
  agentId: string;
  /** Must read the LIVE draft (a ref-backed closure, never a stale capture). */
  getDraft: () => AgentDefinition;
  /** The agent editor controller's dispatch (single writer). */
  dispatch: (action: AgentEditorAction) => void;
  /** Merged workspace+user resources (resolves context ids to names). */
  resources: ContextResources;
  /** Fired after an accepted proposal is applied (rail section flash). */
  onApplied?: (section: AgentSection) => void;
}

export function agentCopilotAdapter(
  options: AgentCopilotAdapterOptions,
): CopilotSurfaceAdapter<AgentDefinition> {
  const { agentId, getDraft, dispatch, resources, onApplied } = options;
  return {
    entityRef: { surface: "agent", entityId: agentId },
    getDraft,
    applyProposal: (proposal) => {
      if (!isAgentProposal(proposal)) return;
      for (const action of agentProposalToActions(proposal)) dispatch(action);
      onApplied?.(agentSectionOfProposal(proposal));
    },
    describeProposal: (proposal) =>
      isAgentProposal(proposal)
        ? describeAgentProposal(proposal, getDraft(), resources)
        : unsupportedProposalDescription(proposal),
    emptyStateCopy: {
      title: "Shape this agent with copilot",
      description:
        "Describe the teammate you're hiring — persona, model and tool suggestions land as Apply/Preview cards you can accept one by one.",
    },
    promptChips: () => {
      const draft = getDraft();
      const untouched =
        draft.persona.trim().length === 0 &&
        draft.context.mcpConnectionIds.length === 0 &&
        draft.context.skillIds.length === 0;
      return untouched ? SCAFFOLD_PROMPTS : REFINE_PROMPTS;
    },
  };
}
