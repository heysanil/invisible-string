/**
 * WORKFLOW-surface copilot adapter (see adapter.ts for the seam) — the
 * pipeline redesign's toolset: `setTrigger` plus the four granular step
 * mutations (`addStep` / `updateStep` / `removeStep` / `moveStep`). The
 * memo-era `setAgent`/`setInstructions` retired with the memo editor.
 *
 * `proposalToActions` maps a typed workflow proposal (shared protocol:
 * `{id, tool, params, rationale}`) onto the builder reducer actions 1:1 —
 * the action shapes MIRROR THE COPILOT PARAM SHAPES EXACTLY (the pipelines
 * plan decrees it, so the copilot and manual edits ride the same reducer
 * vocabulary). `describeWorkflowProposal` turns a proposal + the CURRENT
 * config into the card's icon, title, compact before→after strings AND the
 * rich {@link StepPreview} (compact step-card diff, args key-value table,
 * markdown DiffView) the SuggestionCard renders via StepDiffPreview.
 */
import {
  Bot,
  Database,
  Filter as Funnel,
  Plug,
  Repeat,
  Sparkles,
  Split,
  Zap,
} from "lucide-react";
import {
  findStep,
  walkSteps,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  type AgentSummaryDto,
  type CopilotProposal,
  type PipelineStep,
  type PipelineStepKind,
  type StepPosition,
  type TemplateValue,
  type TriggerConfig,
  type WorkflowConfig,
  type WorkflowCopilotMutationTool,
} from "@invisible-string/shared";

import {
  STEP_KIND_LABELS,
  stepChipSummary,
  stepSummary,
  triggerSummary,
  type StepSummaryContext,
} from "../builder/summary";
import type {
  ArgsDiffRow,
  CopilotSurfaceAdapter,
  ProposalDescription,
  StepCardData,
  StepPreview,
} from "./adapter";

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

// ── Builder actions ─────────────────────────────────────────────────────────

/**
 * The builder reducer actions the workflow copilot maps onto. DECREED by the
 * pipelines plan: `lib/builder/model.ts`'s `BuilderAction` union must include
 * these members VERBATIM (the reducer's step actions mirror the copilot param
 * shapes 1:1), so the controller's dispatch is directly assignable to
 * {@link WorkflowCopilotAdapterOptions.dispatch}.
 */
export type WorkflowBuilderStepAction =
  | { type: "setTrigger"; trigger: TriggerConfig }
  | { type: "addStep"; step: PipelineStep; position: StepPosition }
  | { type: "updateStep"; stepId: string; step: PipelineStep }
  | { type: "removeStep"; stepId: string }
  | { type: "moveStep"; stepId: string; position: StepPosition };

/** Map a workflow proposal to the builder reducer actions that apply it (1:1). */
export function proposalToActions(
  proposal: WorkflowCopilotProposal,
): WorkflowBuilderStepAction[] {
  switch (proposal.tool) {
    case "setTrigger":
      return [{ type: "setTrigger", trigger: proposal.params.trigger }];
    case "addStep":
      return [
        {
          type: "addStep",
          step: proposal.params.step,
          position: proposal.params.position,
        },
      ];
    case "updateStep":
      return [
        {
          type: "updateStep",
          stepId: proposal.params.stepId,
          step: proposal.params.step,
        },
      ];
    case "removeStep":
      return [{ type: "removeStep", stepId: proposal.params.stepId }];
    case "moveStep":
      return [
        {
          type: "moveStep",
          stepId: proposal.params.stepId,
          position: proposal.params.position,
        },
      ];
  }
}

/**
 * Where an applied proposal LANDS (strip flash + scroll target). The trigger
 * card or one step card — the memo-era section vocabulary retired with the
 * memo editor. For `addStep` the id is the server-minted `step.id`, which is
 * exactly the id the strip renders once the reducer inserts it.
 */
export type WorkflowApplyTarget =
  | { kind: "trigger" }
  | { kind: "step"; stepId: string };

export function applyTargetOfProposal(
  proposal: WorkflowCopilotProposal,
): WorkflowApplyTarget {
  switch (proposal.tool) {
    case "setTrigger":
      return { kind: "trigger" };
    case "addStep":
      return { kind: "step", stepId: proposal.params.step.id };
    case "updateStep":
    case "removeStep":
    case "moveStep":
      return { kind: "step", stepId: proposal.params.stepId };
  }
}

// ── Step display vocabulary ─────────────────────────────────────────────────

/** Kind icons — the strip's vocabulary (Plug/Sparkles/Bot/Repeat/Split/Funnel/Database). */
export const STEP_KIND_ICONS: Record<
  PipelineStepKind,
  ProposalDescription["icon"]
> = {
  tool: Plug,
  infer: Sparkles,
  agent: Bot,
  for_each: Repeat,
  branch: Split,
  filter: Funnel,
  state: Database,
};

/** Minimal name lookup — `ConnectionDto` and `AgentSummaryDto` both satisfy it. */
export interface NamedRef {
  id: string;
  name: string;
}

/** Inventories that resolve step ids to display names on the cards. */
export interface WorkflowNameLookups {
  agents: readonly AgentSummaryDto[];
  connections: readonly NamedRef[];
}

const EMPTY_LOOKUPS: WorkflowNameLookups = { agents: [], connections: [] };

/** The builder summary helpers' context shape for a lookups pair. */
function summaryContext(lookups: WorkflowNameLookups): StepSummaryContext {
  return { connections: lookups.connections, agents: lookups.agents };
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Display name for a step: name → slug → kind label. Never empty. */
export function stepDisplayTitle(step: PipelineStep): string {
  const name = step.name?.trim() ?? "";
  if (name.length > 0) return name;
  if (step.slug.length > 0) return step.slug;
  return `${STEP_KIND_LABELS[step.kind]} step`;
}

/**
 * Display string for one template value: `{$ref}` → `@path`, `{$tpl}` → the
 * template text verbatim, scalars as JSON, anything nested as capped compact
 * JSON. Display-only — resolution lives in shared pipeline-template.ts.
 */
export function displayTemplateValue(value: TemplateValue): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof (value as { $ref?: unknown }).$ref === "string") {
      return `@${(value as { $ref: string }).$ref}`;
    }
    if (keys.length === 1 && typeof (value as { $tpl?: unknown }).$tpl === "string") {
      return (value as { $tpl: string }).$tpl;
    }
  }
  if (typeof value === "string") return JSON.stringify(value);
  return truncate(JSON.stringify(value) ?? "null");
}

// ── Compact step cards ──────────────────────────────────────────────────────
//
// One vocabulary with the strip: the summary line and the chip come from the
// builder summary helpers (`stepSummary` / `stepChipSummary`), so a proposal
// preview and the step card it becomes can never describe the same step in
// two dialects.

export function stepCardData(
  step: PipelineStep,
  lookups: WorkflowNameLookups = EMPTY_LOOKUPS,
): StepCardData {
  const ctx = summaryContext(lookups);
  return {
    kind: step.kind,
    title: stepDisplayTitle(step),
    summary: stepSummary(step, ctx),
    chip: stepChipSummary(step, ctx)?.label ?? null,
  };
}

// ── Positions ───────────────────────────────────────────────────────────────

function stepLabelById(steps: readonly PipelineStep[], stepId: string): string {
  const step = findStep(steps, stepId);
  return step ? stepDisplayTitle(step) : stepId;
}

/**
 * Human phrase for a {@link StepPosition} against the CURRENT draft, e.g.
 * `after “search”, inside “each message”` or `at the start`.
 */
export function describeStepPosition(
  position: StepPosition,
  steps: readonly PipelineStep[],
): string {
  const after =
    position.after === null
      ? "at the start"
      : `after “${stepLabelById(steps, position.after)}”`;
  if (!position.parent) return after;
  const parentLabel = stepLabelById(steps, position.parent.stepId);
  const where =
    position.parent.slot === "body"
      ? `inside “${parentLabel}”`
      : position.parent.slot === "then"
        ? `in a “${parentLabel}” branch`
        : `in “${parentLabel}”'s else lane`;
  return `${after}, ${where}`;
}

/** The phrase for where a step currently SITS (moveStep's before side). */
function describeCurrentPosition(
  steps: readonly PipelineStep[],
  stepId: string,
): string | null {
  const entries = walkSteps(steps);
  const index = entries.findIndex((entry) => entry.step.id === stepId);
  if (index === -1) return null;
  const entry = entries[index]!;
  const prefix = JSON.stringify(entry.configPath.slice(0, -1));
  const position = entry.configPath.at(-1) as number;
  const sibling =
    position === 0
      ? null
      : entries.find(
          (candidate) =>
            JSON.stringify(candidate.configPath.slice(0, -1)) === prefix &&
            candidate.configPath.at(-1) === position - 1,
        );
  const after = sibling
    ? `after “${stepDisplayTitle(sibling.step)}”`
    : "at the start";
  const parent = entry.ancestors.at(-1);
  if (!parent) return after;
  const parentLabel = stepDisplayTitle(parent);
  const where =
    entry.slot === "body"
      ? `inside “${parentLabel}”`
      : entry.slot === "then"
        ? `in a “${parentLabel}” branch`
        : `in “${parentLabel}”'s else lane`;
  return `${after}, ${where}`;
}

// ── Args diff table ─────────────────────────────────────────────────────────

/** Tool `args` / state `set` for the given step; null for other kinds. */
function templateRecordOf(
  step: PipelineStep,
): Record<string, TemplateValue> | null {
  if (step.kind === "tool") return step.args;
  if (step.kind === "state") return step.set;
  return null;
}

/** Key-value rows over the union of before/after keys (top-level keys only). */
export function argsDiffRows(
  before: Record<string, TemplateValue> | null,
  after: Record<string, TemplateValue> | null,
): ArgsDiffRow[] {
  const keys = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ];
  return keys.map((key) => {
    const beforeValue =
      before && key in before ? displayTemplateValue(before[key]!) : null;
    const afterValue =
      after && key in after ? displayTemplateValue(after[key]!) : null;
    return {
      key,
      before: beforeValue,
      after: afterValue,
      changed: beforeValue !== afterValue,
    };
  });
}

/** The markdown document a step carries (infer prompt / agent instructions). */
function markdownOf(step: PipelineStep): string | null {
  if (step.kind === "infer") return step.prompt.markdown;
  if (step.kind === "agent") return step.instructions.markdown;
  return null;
}

// ── Descriptions ────────────────────────────────────────────────────────────

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

function describeAddStep(
  step: PipelineStep,
  position: StepPosition,
  definition: WorkflowConfig,
  lookups: WorkflowNameLookups,
): ProposalDescription {
  const card = stepCardData(step, lookups);
  const markdown = markdownOf(step);
  const record = templateRecordOf(step);
  const preview: StepPreview = {
    mode: "add",
    before: null,
    after: card,
    position: describeStepPosition(position, definition.steps),
    ...(markdown !== null && markdown.trim().length > 0
      ? { markdownDiff: { before: "", after: markdown } }
      : {}),
    ...(record !== null && Object.keys(record).length > 0
      ? { argsDiff: argsDiffRows(null, record) }
      : {}),
  };
  return {
    icon: STEP_KIND_ICONS[step.kind],
    title: `Add step: ${card.title}`,
    before: null,
    after: card.summary,
    stepPreview: preview,
  };
}

function describeUpdateStep(
  stepId: string,
  step: PipelineStep,
  definition: WorkflowConfig,
  lookups: WorkflowNameLookups,
): ProposalDescription {
  const current = findStep(definition.steps, stepId);
  const card = stepCardData(step, lookups);
  const beforeMarkdown = current ? markdownOf(current) : null;
  const afterMarkdown = markdownOf(step);
  const markdownChanged =
    afterMarkdown !== null && afterMarkdown !== (beforeMarkdown ?? "");
  const rows = argsDiffRows(
    current ? templateRecordOf(current) : null,
    templateRecordOf(step),
  );
  const preview: StepPreview = {
    mode: "update",
    before: current ? stepCardData(current, lookups) : null,
    after: card,
    ...(markdownChanged
      ? { markdownDiff: { before: beforeMarkdown ?? "", after: afterMarkdown } }
      : {}),
    ...(rows.length > 0 ? { argsDiff: rows } : {}),
  };
  return {
    icon: STEP_KIND_ICONS[step.kind],
    title: `Update step: ${card.title}`,
    before: current ? stepSummary(current, summaryContext(lookups)) : null,
    after: card.summary,
    stepPreview: preview,
  };
}

function describeRemoveStep(
  stepId: string,
  definition: WorkflowConfig,
  lookups: WorkflowNameLookups,
): ProposalDescription {
  const current = findStep(definition.steps, stepId);
  const title = current ? stepDisplayTitle(current) : stepId;
  return {
    icon: current ? STEP_KIND_ICONS[current.kind] : Sparkles,
    title: `Remove step: ${title}`,
    before: current ? stepSummary(current, summaryContext(lookups)) : null,
    after: null,
    stepPreview: {
      mode: "remove",
      before: current ? stepCardData(current, lookups) : null,
      after: null,
    },
  };
}

function describeMoveStep(
  stepId: string,
  position: StepPosition,
  definition: WorkflowConfig,
  lookups: WorkflowNameLookups,
): ProposalDescription {
  const current = findStep(definition.steps, stepId);
  const title = current ? stepDisplayTitle(current) : stepId;
  const card = current ? stepCardData(current, lookups) : null;
  const destination = describeStepPosition(position, definition.steps);
  return {
    icon: current ? STEP_KIND_ICONS[current.kind] : Sparkles,
    title: `Move step: ${title}`,
    before: describeCurrentPosition(definition.steps, stepId),
    after: destination,
    stepPreview: {
      mode: "move",
      before: card,
      after: card,
      position: destination,
    },
  };
}

export function describeWorkflowProposal(
  proposal: WorkflowCopilotProposal,
  definition: WorkflowConfig,
  lookups: WorkflowNameLookups = EMPTY_LOOKUPS,
): ProposalDescription {
  switch (proposal.tool) {
    case "setTrigger": {
      const next = triggerSummary({
        ...definition,
        trigger: proposal.params.trigger,
      });
      const current = triggerSummary(definition);
      return {
        icon: Zap,
        title: `Set trigger: ${next.typeLabel} — ${next.detail}`,
        before: `${current.typeLabel} · ${current.detail}`,
        after: `${next.typeLabel} · ${next.detail}`,
      };
    }
    case "addStep":
      return describeAddStep(
        proposal.params.step,
        proposal.params.position,
        definition,
        lookups,
      );
    case "updateStep":
      return describeUpdateStep(
        proposal.params.stepId,
        proposal.params.step,
        definition,
        lookups,
      );
    case "removeStep":
      return describeRemoveStep(proposal.params.stepId, definition, lookups);
    case "moveStep":
      return describeMoveStep(
        proposal.params.stepId,
        proposal.params.position,
        definition,
        lookups,
      );
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

const SCAFFOLD_PROMPTS = [
  "Set this up to triage Slack mentions",
  "Build a scheduled digest pipeline",
  "Add the first step",
] as const;

const REFINE_PROMPTS = [
  "Explain this pipeline's issues",
  "Make the trigger more specific",
  "Use the cheapest step kinds that work",
] as const;

/**
 * Offered on single-agent-step pipelines: the conversion is a copilot
 * CONVERSATION, never a background write (pipelines plan).
 */
export const CONVERT_PROMPT = "Convert this workflow into steps";

export interface WorkflowCopilotAdapterOptions {
  workflowId: string;
  /** Must read the LIVE draft (a ref-backed closure, never a stale capture). */
  getDraft: () => WorkflowConfig;
  /**
   * The builder controller's dispatch (single writer). Typed against the
   * decreed step-action mirror so the copilot cannot drift from the reducer.
   */
  dispatch: (action: WorkflowBuilderStepAction) => void;
  /** Workspace agent inventory (resolves agent-step ids to names). */
  agents: readonly AgentSummaryDto[];
  /** Workspace connection inventory (resolves tool-step ids to names). */
  connections?: readonly NamedRef[];
  /** Fired after an accepted proposal is applied (strip flash target). */
  onApplied?: (target: WorkflowApplyTarget) => void;
}

export function workflowCopilotAdapter(
  options: WorkflowCopilotAdapterOptions,
): CopilotSurfaceAdapter<WorkflowConfig> {
  const { workflowId, getDraft, dispatch, agents, connections, onApplied } =
    options;
  const lookups: WorkflowNameLookups = {
    agents,
    connections: connections ?? [],
  };
  return {
    entityRef: { surface: "workflow", entityId: workflowId },
    getDraft,
    applyProposal: (proposal) => {
      if (!isWorkflowProposal(proposal)) return;
      for (const action of proposalToActions(proposal)) dispatch(action);
      onApplied?.(applyTargetOfProposal(proposal));
    },
    describeProposal: (proposal) =>
      isWorkflowProposal(proposal)
        ? describeWorkflowProposal(proposal, getDraft(), lookups)
        : unsupportedProposalDescription(proposal),
    emptyStateCopy: {
      title: "Build this pipeline with copilot",
      description:
        "Describe what you want — trigger and step suggestions land as Apply/Preview cards you can accept one by one.",
    },
    promptChips: () => {
      const steps = getDraft().steps;
      if (steps.length === 0) return SCAFFOLD_PROMPTS;
      // A single agent step is the old memo shape in pipeline clothes — offer
      // the conversion conversation first.
      if (steps.length === 1 && steps[0]!.kind === "agent") {
        return [CONVERT_PROMPT, ...REFINE_PROMPTS.slice(0, 2)];
      }
      return REFINE_PROMPTS;
    },
  };
}
