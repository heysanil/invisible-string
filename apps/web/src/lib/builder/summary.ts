/**
 * Summary derivation for the pipeline editor — turns the live config (+ the
 * workspace inventories) into the compact "what's configured" strings the
 * trigger card, step cards, proposal previews and list rows render. Pure and
 * display-only (no validation; that is diagnostics.ts).
 */
import {
  type AgentSummaryDto,
  type ConnectionDto,
  type PipelineCondition,
  type PipelineStep,
  type PipelineStepKind,
  type RefValue,
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

// ── AGENT (the chip an agent STEP wears) ────────────────────────────────────

export type AgentChipStatus =
  /** The step names no agent yet. */
  | "none"
  /** Agent inventory still loading — render a ghost chip. */
  | "loading"
  /** The referenced agent row no longer exists. */
  | "missing"
  /** Agent exists but has never been published (blocks workflow publish). */
  | "draft"
  | "published";

/** The "who does the work" chip: agent step cards + proposal previews. */
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
export function connectionGating(connection: ConnectionDto): string | null {
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

/** First non-empty line of a markdown surface, truncated for a card row. */
export function markdownPreview(markdown: string, max = 80): string {
  const firstContent =
    markdown.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstContent.length > max
    ? `${firstContent.slice(0, max - 1)}…`
    : firstContent;
}

/** `{$ref: "steps.search.result"}` → "@steps.search.result" (display only). */
export function displayRef(ref: RefValue): string {
  return ref.$ref.trim() === "" ? "@…" : `@${ref.$ref}`;
}

// ── Conditions ──────────────────────────────────────────────────────────────

type ConditionOperandLike =
  | string
  | number
  | boolean
  | null
  | (string | number | boolean | null)[]
  | RefValue;

function displayOperand(operand: ConditionOperandLike): string {
  if (operand !== null && typeof operand === "object" && !Array.isArray(operand)) {
    return displayRef(operand);
  }
  if (Array.isArray(operand)) {
    return `[${operand.map((entry) => displayOperand(entry)).join(", ")}]`;
  }
  if (typeof operand === "string") {
    const text = operand.length > 24 ? `${operand.slice(0, 23)}…` : operand;
    return `"${text}"`;
  }
  return String(operand);
}

/** How deep {@link describeCondition} renders before eliding to "…". */
const MAX_CONDITION_DISPLAY_DEPTH = 4;

/**
 * A compact one-line rendering of a condition AST — filter cards, branch lane
 * labels and proposal previews all share it. Display-only: the evaluator
 * lives in packages/shared (pipeline-template.ts).
 */
export function describeCondition(
  condition: PipelineCondition,
  depth = 0,
): string {
  if (depth >= MAX_CONDITION_DISPLAY_DEPTH) return "…";
  const group = (inner: string): string => (depth > 0 ? `(${inner})` : inner);

  if ("and" in condition) {
    return group(
      condition.and.map((c) => describeCondition(c, depth + 1)).join(" and "),
    );
  }
  if ("or" in condition) {
    return group(
      condition.or.map((c) => describeCondition(c, depth + 1)).join(" or "),
    );
  }
  if ("not" in condition) {
    return `not ${describeCondition(condition.not, depth + 1)}`;
  }
  if ("eq" in condition) {
    return `${displayOperand(condition.eq[0])} = ${displayOperand(condition.eq[1])}`;
  }
  if ("ne" in condition) {
    return `${displayOperand(condition.ne[0])} ≠ ${displayOperand(condition.ne[1])}`;
  }
  if ("gt" in condition) {
    return `${displayOperand(condition.gt[0])} > ${displayOperand(condition.gt[1])}`;
  }
  if ("gte" in condition) {
    return `${displayOperand(condition.gte[0])} ≥ ${displayOperand(condition.gte[1])}`;
  }
  if ("lt" in condition) {
    return `${displayOperand(condition.lt[0])} < ${displayOperand(condition.lt[1])}`;
  }
  if ("lte" in condition) {
    return `${displayOperand(condition.lte[0])} ≤ ${displayOperand(condition.lte[1])}`;
  }
  if ("contains" in condition) {
    return `${displayOperand(condition.contains[0])} contains ${displayOperand(condition.contains[1])}`;
  }
  if ("startsWith" in condition) {
    return `${displayOperand(condition.startsWith[0])} starts with ${displayOperand(condition.startsWith[1])}`;
  }
  if ("endsWith" in condition) {
    return `${displayOperand(condition.endsWith[0])} ends with ${displayOperand(condition.endsWith[1])}`;
  }
  if ("exists" in condition) {
    return `${displayOperand(condition.exists)} exists`;
  }
  if ("truthy" in condition) {
    return displayOperand(condition.truthy);
  }
  if ("empty" in condition) {
    return `${displayOperand(condition.empty)} is empty`;
  }
  return `${displayOperand(condition.in[0])} in ${displayOperand(condition.in[1])}`;
}

// ── STEPS ───────────────────────────────────────────────────────────────────

/** Card-header label per step kind (icons live with the components). */
export const STEP_KIND_LABELS: Record<PipelineStepKind, string> = {
  tool: "Tool call",
  infer: "Infer",
  agent: "Agent",
  for_each: "For each",
  branch: "Branch",
  filter: "Filter",
  state: "State",
};

/** Inventory the step summaries resolve names against (null = loading). */
export interface StepSummaryContext {
  /** Merged workspace+user connection inventory. */
  connections: readonly Pick<ConnectionDto, "id" | "name">[] | null;
  /** Workspace agent inventory. */
  agents: readonly AgentSummaryDto[] | null;
}

/** The connection/agent/preset chip a step card wears (null = no chip). */
export interface StepChipSummary {
  label: string;
  status: "ok" | "none" | "loading" | "missing" | "draft";
}

export function stepChipSummary(
  step: PipelineStep,
  ctx: StepSummaryContext,
): StepChipSummary | null {
  switch (step.kind) {
    case "tool": {
      if (step.connectionId === "") {
        return { label: "No connection", status: "none" };
      }
      if (ctx.connections === null) {
        return { label: "Loading…", status: "loading" };
      }
      const connection = ctx.connections.find((c) => c.id === step.connectionId);
      return connection
        ? { label: connection.name, status: "ok" }
        : { label: "Unknown connection", status: "missing" };
    }
    case "infer":
      return { label: step.preset, status: "ok" };
    case "agent": {
      const chip = agentChipSummary(step.agentId, ctx.agents);
      return {
        label: chip.name,
        status: chip.status === "published" ? "ok" : chip.status,
      };
    }
    case "for_each":
    case "branch":
    case "filter":
    case "state":
      return null;
  }
}

function countSteps(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

/**
 * The one-line "what this step does" a card renders under its name — also
 * what proposal previews and the pipeline list reuse. Draft-lenient: an
 * unconfigured step describes what is still missing rather than erroring.
 */
export function stepSummary(step: PipelineStep, ctx: StepSummaryContext): string {
  switch (step.kind) {
    case "tool": {
      if (step.tool === "") {
        const connection =
          step.connectionId !== "" && ctx.connections !== null
            ? ctx.connections.find((c) => c.id === step.connectionId)
            : undefined;
        return connection
          ? `Pick a tool on ${connection.name}`
          : "Pick a connection and tool";
      }
      const argCount = Object.keys(step.args).length;
      const args = argCount === 0 ? "no args" : `${argCount} arg${argCount === 1 ? "" : "s"}`;
      return `${step.tool} · ${args}`;
    }
    case "infer": {
      const preview = markdownPreview(step.prompt.markdown);
      const structured = step.output !== undefined ? " → structured output" : "";
      return preview === "" ? "Write a prompt" : `${preview}${structured}`;
    }
    case "agent": {
      const preview = markdownPreview(step.instructions.markdown);
      const thread = step.session === "thread" ? " · continues the Slack thread" : "";
      return preview === "" ? "Write instructions" : `${preview}${thread}`;
    }
    case "for_each": {
      const continues =
        step.onItemError === "continue" ? " · continues on item errors" : "";
      return `For each item of ${displayRef(step.items)} · ${countSteps(step.steps.length)}${continues}`;
    }
    case "branch": {
      const lanes = step.branches.length;
      const withElse = step.else !== undefined ? " · else" : "";
      const first = step.branches[0];
      const when = first ? ` · when ${describeCondition(first.when)}` : "";
      return `${lanes} branch${lanes === 1 ? "" : "es"}${withElse}${when}`;
    }
    case "filter":
      return `Continue when ${describeCondition(step.where)}`;
    case "state": {
      const keys = Object.keys(step.set);
      return keys.length === 0 ? "No keys set" : `Set ${keys.join(", ")}`;
    }
  }
}
