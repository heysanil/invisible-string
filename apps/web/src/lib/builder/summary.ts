/**
 * Pillar-card summary derivation — turns the live definition + resolved
 * workspace resources into the compact "what's configured" strings the left
 * rail renders. Pure and display-only (no validation; that is diagnostics.ts).
 */
import {
  buildReferenceInventory,
  type AgentPresetDto,
  type McpConnectionDto,
  type ModelPresetDto,
  type ModelPresetSlug,
  type SkillDto,
  type WorkflowDefinition,
} from "@invisible-string/shared";

// ── TRIGGER ─────────────────────────────────────────────────────────────────

export interface TriggerSummary {
  typeLabel: string;
  /** e.g. "3 fields" / "any channel · @mentions" / "0 9 * * 1". */
  detail: string;
}

const TRIGGER_TYPE_LABELS: Record<WorkflowDefinition["trigger"]["type"], string> =
  {
    manual: "Manual",
    form: "Form",
    webhook: "Webhook",
    slack: "Slack",
    schedule: "Schedule",
  };

export function triggerSummary(
  definition: WorkflowDefinition,
): TriggerSummary {
  const trigger = definition.trigger;
  const typeLabel = TRIGGER_TYPE_LABELS[trigger.type];
  switch (trigger.type) {
    case "manual":
      return { typeLabel, detail: "Runs from chat" };
    case "form": {
      const n = trigger.fields.length;
      return { typeLabel, detail: `${n} field${n === 1 ? "" : "s"}` };
    }
    case "webhook":
      return { typeLabel, detail: "Token generated at publish" };
    case "slack": {
      const where = trigger.binding.channelId
        ? `#${trigger.binding.channelId}`
        : "any channel";
      const how = trigger.binding.mentionOnly ? "@mentions" : "all messages";
      const dm = trigger.binding.includeDirectMessages ? " · DMs" : "";
      return { typeLabel, detail: `${where} · ${how}${dm}` };
    }
    case "schedule":
      return { typeLabel, detail: trigger.cron };
  }
}

// ── CONTEXT ─────────────────────────────────────────────────────────────────

export interface ContextChip {
  id: string;
  name: string;
  kind: "connection" | "skill";
  /** Connections only: gating hint, e.g. "send gated" when a tool asks. */
  gating?: string | null;
}

/** Summarize a connection's approval policy into a short gating phrase. */
export function connectionGating(connection: McpConnectionDto): string | null {
  const policy = connection.approvalPolicy;
  if (!policy) return null;
  const toolEntries = Object.entries(policy.tools ?? {});
  const gatedTools = toolEntries.filter(([, decision]) => decision === "always");
  if (policy.default === "always") return "all gated";
  if (gatedTools.length === 1) return `${gatedTools[0]![0]} gated`;
  if (gatedTools.length > 1) return `${gatedTools.length} tools gated`;
  const onceTools = toolEntries.filter(([, decision]) => decision === "once");
  if (policy.default === "once" || onceTools.length > 0) return "asks once";
  return null;
}

export function contextChips(
  definition: WorkflowDefinition,
  connections: readonly McpConnectionDto[],
  skills: readonly SkillDto[],
): ContextChip[] {
  const connectionById = new Map(connections.map((c) => [c.id, c]));
  const skillById = new Map(skills.map((s) => [s.id, s]));
  const chips: ContextChip[] = [];

  for (const id of definition.context.mcpConnectionIds) {
    const connection = connectionById.get(id);
    chips.push({
      id,
      kind: "connection",
      name: connection?.name ?? "Unknown connection",
      gating: connection ? connectionGating(connection) : null,
    });
  }
  for (const id of definition.context.skillIds) {
    const skill = skillById.get(id);
    chips.push({
      id,
      kind: "skill",
      name: skill?.name ?? "Unknown skill",
    });
  }
  return chips;
}

// ── AGENT ───────────────────────────────────────────────────────────────────

export interface AgentSummary {
  presetName: string;
  /** Resolved chain, e.g. "balanced → deepseek-v4-pro" or "override → …". */
  modelChain: string;
  reasoning: string;
}

const PRESET_SLUG_LABEL: Record<ModelPresetSlug, string> = {
  powerful: "powerful",
  balanced: "balanced",
  quick: "quick",
};

/** Strip a provider prefix from a model id for compact display. */
export function shortModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

export function agentSummary(
  definition: WorkflowDefinition,
  presets: readonly AgentPresetDto[],
  modelPresets: readonly ModelPresetDto[],
): AgentSummary {
  const agent = definition.agent;
  const preset = presets.find((p) => p.id === agent.agentPresetId);
  const presetName = preset?.name ?? "No preset";

  // Effective model-preset slug: override wins, else the agent preset's default.
  const slug: ModelPresetSlug | undefined =
    agent.modelPreset ?? preset?.modelPreset;

  let modelChain: string;
  if (agent.modelId) {
    modelChain = `override → ${shortModelId(agent.modelId)}`;
  } else if (preset?.modelId) {
    modelChain = `preset model → ${shortModelId(preset.modelId)}`;
  } else if (slug) {
    const mapped = modelPresets.find((mp) => mp.slug === slug);
    modelChain = mapped
      ? `${PRESET_SLUG_LABEL[slug]} → ${shortModelId(mapped.modelId)}`
      : PRESET_SLUG_LABEL[slug];
  } else {
    modelChain = "—";
  }

  const reasoning = agent.reasoning ?? preset?.reasoningEffort ?? "medium";
  return { presetName, modelChain, reasoning };
}

// ── INSTRUCTIONS ────────────────────────────────────────────────────────────

export interface InstructionsSummary {
  lineCount: number;
  refCount: number;
  /** First non-empty line, truncated — the card preview. */
  preview: string;
  isEmpty: boolean;
}

export function instructionsSummary(
  definition: WorkflowDefinition,
): InstructionsSummary {
  const markdown = definition.instructions.markdown;
  const trimmed = markdown.trim();
  const isEmpty = trimmed.length === 0;
  const lines = markdown.split("\n");
  const firstContent = lines.find((line) => line.trim().length > 0) ?? "";
  const preview =
    firstContent.length > 80 ? `${firstContent.slice(0, 79)}…` : firstContent;
  const refCount = buildReferenceInventory(markdown).all.length;
  return {
    lineCount: isEmpty ? 0 : lines.length,
    refCount,
    preview,
    isEmpty,
  };
}
