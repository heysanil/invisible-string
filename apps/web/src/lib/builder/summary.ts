/**
 * Section-summary derivation for the workflow editor — turns the live config
 * (+ the workspace agent inventory) into the compact "what's configured"
 * strings section headers, list rows and copilot previews render. Pure and
 * display-only (no validation; that is diagnostics.ts).
 */
import {
  buildReferenceInventory,
  type AgentSummaryDto,
  type McpConnectionDto,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { describeCron } from "./cron";

// ── TRIGGER ─────────────────────────────────────────────────────────────────

export interface TriggerSummary {
  typeLabel: string;
  /** e.g. "3 fields" / "any channel · @mentions" / "0 9 * * 1". */
  detail: string;
}

const TRIGGER_TYPE_LABELS: Record<WorkflowConfig["trigger"]["type"], string> = {
  manual: "Manual",
  form: "Form",
  webhook: "Webhook",
  slack: "Slack",
  schedule: "Schedule",
};

export function triggerSummary(definition: WorkflowConfig): TriggerSummary {
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
    case "schedule": {
      // Humanize common cron shapes; keep the raw expression alongside so
      // the machine token stays visible (and copyable) next to the phrase.
      const human = describeCron(trigger.cron);
      return {
        typeLabel,
        detail: human ? `${human} · ${trigger.cron}` : trigger.cron,
      };
    }
  }
}

// ── AGENT ───────────────────────────────────────────────────────────────────

export type AgentChipStatus =
  /** The draft names no agent yet. */
  | "none"
  /** Agent inventory still loading — render a ghost chip. */
  | "loading"
  /** The referenced agent row no longer exists. */
  | "missing"
  /** Agent exists but has never been published (blocks workflow publish). */
  | "draft"
  | "published";

/** The "who does the work" chip: workflows list rows + Agent section header. */
export interface AgentChipSummary {
  /** Chip label (falls back to a placeholder when unresolvable). */
  name: string;
  status: AgentChipStatus;
  /** The resolved agent when found (monogram/description needs). */
  agent: AgentSummaryDto | null;
}

export function agentChipSummary(
  agentId: string | null,
  agents: readonly AgentSummaryDto[] | null,
): AgentChipSummary {
  if (agentId === null) {
    return { name: "No agent selected", status: "none", agent: null };
  }
  if (agents === null) {
    return { name: "Loading…", status: "loading", agent: null };
  }
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return { name: "Unknown agent", status: "missing", agent: null };
  }
  return {
    name: agent.name,
    status: agent.publishedVersionId !== null ? "published" : "draft",
    agent,
  };
}

// ── Shared display helpers ──────────────────────────────────────────────────

/** Strip a provider prefix from a model id for compact display. */
export function shortModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/**
 * Summarize a connection's approval policy into a short gating phrase (used
 * by the context-attachment rows in the AGENT editor).
 */
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

// ── INSTRUCTIONS ────────────────────────────────────────────────────────────

export interface InstructionsSummary {
  lineCount: number;
  refCount: number;
  /** First non-empty line, truncated — the card preview. */
  preview: string;
  isEmpty: boolean;
}

export function instructionsSummary(
  definition: WorkflowConfig,
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
