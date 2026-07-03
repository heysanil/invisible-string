/**
 * Copilot proposal presentation + application.
 *
 * `proposalToActions` maps a typed copilot proposal (shared protocol:
 * `{id, tool, params, rationale}`) onto the EXISTING builder reducer actions
 * (single writer — the same path manual edits take, so autosave / dirty
 * state / dry-run all just work). A `setAgent` proposal may touch several
 * agent fields, hence the array. `describeProposal` turns a proposal + the
 * CURRENT definition into the card's title, affected pillar, and a compact
 * before→after preview.
 */
import type {
  AgentPresetDto,
  CopilotProposal,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import type { BuilderAction, Pillar } from "../builder/model";
import type { ContextResources } from "../builder/resources";
import { agentSummary, triggerSummary } from "../builder/summary";

/** The pillar a proposal's mutation lands on (rail flash + card icon). */
export function pillarOfProposal(proposal: CopilotProposal): Pillar {
  switch (proposal.tool) {
    case "setTrigger":
      return "trigger";
    case "addContext":
    case "removeContext":
      return "context";
    case "setAgent":
    case "setModelPreset":
      return "agent";
    case "setInstructions":
      return "instructions";
  }
}

/** Map a copilot proposal to the builder reducer actions that apply it. */
export function proposalToActions(proposal: CopilotProposal): BuilderAction[] {
  switch (proposal.tool) {
    case "setTrigger":
      return [{ type: "setTrigger", trigger: proposal.params.trigger }];
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
    case "setAgent": {
      const { agentPresetId, reasoning, modelId } = proposal.params;
      const actions: BuilderAction[] = [];
      if (agentPresetId !== undefined) {
        actions.push({ type: "setAgentPreset", id: agentPresetId });
      }
      if (reasoning !== undefined) {
        actions.push({ type: "setReasoning", reasoning });
      }
      if (modelId !== undefined) {
        actions.push({ type: "setModelId", modelId });
      }
      return actions;
    }
    case "setModelPreset":
      return [{ type: "setModelPreset", preset: proposal.params.slug }];
    case "setInstructions":
      return [{ type: "setInstructions", markdown: proposal.params.markdown }];
  }
}

export interface MutationDescription {
  pillar: Pillar;
  title: string;
  /** Compact before → after strings (setInstructions uses the diff view). */
  before: string | null;
  after: string | null;
}

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

export function describeProposal(
  proposal: CopilotProposal,
  definition: WorkflowDefinition,
  resources: ContextResources,
  agentPresets: readonly AgentPresetDto[],
  modelPresets: readonly ModelPresetDto[],
): MutationDescription {
  switch (proposal.tool) {
    case "setTrigger": {
      const next = triggerSummary({
        ...definition,
        trigger: proposal.params.trigger,
      });
      const current = triggerSummary(definition);
      return {
        pillar: "trigger",
        title: `Set trigger: ${next.typeLabel} — ${next.detail}`,
        before: `${current.typeLabel} · ${current.detail}`,
        after: `${next.typeLabel} · ${next.detail}`,
      };
    }
    case "addContext": {
      const name = contextName(proposal.params, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        pillar: "context",
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
        pillar: "context",
        title: `Remove ${proposal.params.kind}: ${name}`,
        before: sourceCount(count),
        after: `${sourceCount(Math.max(0, count - 1))} — − ${name}`,
      };
    }
    case "setAgent": {
      const { agentPresetId, reasoning, modelId } = proposal.params;
      const current = agentSummary(definition, agentPresets, modelPresets);
      const parts: string[] = [];
      const afterParts: string[] = [];
      if (agentPresetId !== undefined) {
        const nextName =
          agentPresets.find((p) => p.id === agentPresetId)?.name ??
          agentPresetId;
        parts.push(`Set agent: ${nextName}`);
        afterParts.push(nextName);
      }
      if (reasoning !== undefined) {
        parts.push(`reasoning ${reasoning}`);
        afterParts.push(`reasoning ${reasoning}`);
      }
      if (modelId !== undefined) {
        parts.push(`model ${modelId}`);
        afterParts.push(modelId);
      }
      return {
        pillar: "agent",
        title: parts.join(" · ") || "Update agent",
        before: `${current.presetName} · ${current.modelChain} · reasoning ${current.reasoning}`,
        after: afterParts.join(" · ") || null,
      };
    }
    case "setModelPreset": {
      const current = agentSummary(definition, agentPresets, modelPresets);
      return {
        pillar: "agent",
        title: `Set model preset: ${proposal.params.slug}`,
        before: current.modelChain,
        after: proposal.params.slug,
      };
    }
    case "setInstructions": {
      const isEmpty = definition.instructions.markdown.trim().length === 0;
      return {
        pillar: "instructions",
        title: isEmpty ? "Write instructions" : "Rewrite instructions",
        before: null, // diff view carries the preview
        after: null,
      };
    }
  }
}
