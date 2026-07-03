/**
 * Copilot mutation presentation + application.
 *
 * `mutationToAction` maps a typed copilot mutation onto the EXISTING builder
 * reducer action (single writer — the same path manual edits take, so
 * autosave / dirty state / dry-run all just work). `describeMutation` turns
 * a mutation + the CURRENT definition into the card's title, rationale
 * context, affected pillar, and a compact before→after preview.
 */
import type {
  AgentPresetDto,
  CopilotMutation,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import type { BuilderAction, Pillar } from "../builder/model";
import type { ContextResources } from "../builder/resources";
import { agentSummary, triggerSummary } from "../builder/summary";

/** Map a copilot mutation to the builder reducer action that applies it. */
export function mutationToAction(mutation: CopilotMutation): BuilderAction {
  switch (mutation.kind) {
    case "setTrigger":
      return { type: "setTrigger", trigger: mutation.trigger };
    case "addContext":
      return mutation.contextKind === "connection"
        ? { type: "addConnection", id: mutation.id }
        : { type: "addSkill", id: mutation.id };
    case "removeContext":
      return mutation.contextKind === "connection"
        ? { type: "removeConnection", id: mutation.id }
        : { type: "removeSkill", id: mutation.id };
    case "setAgent":
      return { type: "setAgentPreset", id: mutation.agentPresetId };
    case "setModelPreset":
      return { type: "setModelPreset", preset: mutation.preset ?? undefined };
    case "setInstructions":
      return { type: "setInstructions", markdown: mutation.markdown };
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
  mutation: Extract<CopilotMutation, { kind: "addContext" | "removeContext" }>,
  resources: ContextResources,
): string {
  if (mutation.contextKind === "connection") {
    return resources.connectionById.get(mutation.id)?.name ?? mutation.id;
  }
  return resources.skillById.get(mutation.id)?.name ?? mutation.id;
}

export function describeMutation(
  mutation: CopilotMutation,
  definition: WorkflowDefinition,
  resources: ContextResources,
  agentPresets: readonly AgentPresetDto[],
  modelPresets: readonly ModelPresetDto[],
): MutationDescription {
  switch (mutation.kind) {
    case "setTrigger": {
      const next = triggerSummary({ ...definition, trigger: mutation.trigger });
      const current = triggerSummary(definition);
      return {
        pillar: "trigger",
        title: `Set trigger: ${next.typeLabel} — ${next.detail}`,
        before: `${current.typeLabel} · ${current.detail}`,
        after: `${next.typeLabel} · ${next.detail}`,
      };
    }
    case "addContext": {
      const name = contextName(mutation, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        pillar: "context",
        title: `Add ${mutation.contextKind}: ${name}`,
        before: `${count} source${count === 1 ? "" : "s"}`,
        after: `${count + 1} sources — + ${name}`,
      };
    }
    case "removeContext": {
      const name = contextName(mutation, resources);
      const count =
        definition.context.mcpConnectionIds.length +
        definition.context.skillIds.length;
      return {
        pillar: "context",
        title: `Remove ${mutation.contextKind}: ${name}`,
        before: `${count} source${count === 1 ? "" : "s"}`,
        after: `${Math.max(0, count - 1)} sources — − ${name}`,
      };
    }
    case "setAgent": {
      const nextName =
        agentPresets.find((p) => p.id === mutation.agentPresetId)?.name ??
        mutation.agentPresetId;
      const current = agentSummary(definition, agentPresets, modelPresets);
      return {
        pillar: "agent",
        title: `Set agent: ${nextName}`,
        before: current.presetName,
        after: nextName,
      };
    }
    case "setModelPreset": {
      const current = agentSummary(definition, agentPresets, modelPresets);
      const nextLabel = mutation.preset ?? "preset default";
      return {
        pillar: "agent",
        title:
          mutation.preset === null
            ? "Clear model preset override"
            : `Set model preset: ${mutation.preset}`,
        before: current.modelChain,
        after: nextLabel,
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
