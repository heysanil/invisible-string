/**
 * PipelineStep — the step tree of a v2 workflow config (pipeline redesign
 * spec). A workflow is a pipeline the control plane INTERPRETS: deterministic
 * `tool` calls against workspace MCP connections, two agentic weights
 * (`infer` = direct model call, `agent` = a real eve session as a child run),
 * and control verbs (`for_each` / `branch` / `filter` / `state`). Publishing
 * still builds nothing.
 *
 * Draft-lenient by design, exactly like the trigger schemas next door in
 * workflow-config.ts: this module guards SHAPE only. Empty `connectionId` /
 * `tool` strings, a null `agentId`, and empty `slug`s all parse — the publish
 * validator (control plane) is what demands a runnable pipeline. What IS
 * enforced here: minted-id shape, slug/state-key charset, template-value and
 * condition tags, and the output-schema subset — the invariants every surface
 * (builder, copilot validate.ts, runner) leans on.
 *
 * `script` is deliberately ABSENT from the union: the `run_step_kind` pgEnum
 * reserves it day one (enum ordering is awkward later), but the config gains
 * it only when the sandboxed executor ships (Phase 5).
 *
 * Recursion note: `for_each`/`branch` nest steps, so the step types are
 * authored manually and the schemas annotated — zod cannot infer through the
 * cycle. Keep the interfaces and schemas in lockstep.
 */
import { z } from "zod";

import { newId } from "./id";
import {
  outputSchemaSchema,
  type OutputSchemaNode,
} from "./pipeline-output-schema";

// ── Step identity ───────────────────────────────────────────────────────────

/** Step ids are `st_` + 16-char lowercase-alnum nanoid (house convention). */
export const STEP_ID_PREFIX = "st";

/** Shape of a minted step id. Ids are machine-minted — never user-typed. */
export const STEP_ID_PATTERN = /^st_[0-9a-z]{16}$/;

/** Mint a step id (`st_…`). The builder and copilot validate.ts call this — the model never supplies ids. */
export function newStepId(): string {
  return newId(STEP_ID_PREFIX);
}

/**
 * Slugs are the `@steps.<slug>` handle, so the charset must stay a subset of
 * the `@reference` segment charset (see `parseReferences` in
 * workflow-config.ts) — same lockstep rule as form-field keys. State keys
 * (`@state.<key>`) share it.
 */
export const STEP_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const stepSlugSchema = z
  .string()
  .regex(
    STEP_SLUG_PATTERN,
    "slug must start with a letter and contain only letters, digits, _ or -",
  )
  .or(z.literal("")); // draft-lenient; publish requires non-empty unique slugs

/** Fields every step carries. `slug` must be unique across the whole tree. */
const stepBaseShape = {
  id: z.string().regex(STEP_ID_PATTERN, "expected a minted st_ step id"),
  slug: stepSlugSchema,
  /** Optional display name for the step card; the slug is the handle. */
  name: z.string().optional(),
};

// ── Template values (tagged-JSON walk) ──────────────────────────────────────

/** Whole-value reference: replaced by the value at `$ref`, type preserved. */
export interface RefValue {
  $ref: string;
}

/** String template: `@references` in the text interpolate (markdown rules). */
export interface TplValue {
  $tpl: string;
}

/**
 * One templatable JSON value (tool args, state writes). Bare strings stay
 * LITERAL — interpolation is opt-in via `{"$tpl": …}`, whole-value references
 * via `{"$ref": "dot.path"}` (type-preserving). Everything else is literal
 * JSON, walked recursively. Resolution lives in pipeline-template.ts.
 */
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | RefValue
  | TplValue
  | TemplateValue[]
  | { [key: string]: TemplateValue };

/** `{$ref}` tag — strict, so `{$ref, …extras}` falls through to a literal object. */
export const refValueSchema = z.strictObject({ $ref: z.string() });

/** `{$tpl}` tag — strict for the same reason. */
export const tplValueSchema = z.strictObject({ $tpl: z.string() });

export const templateValueSchema: z.ZodType<TemplateValue, TemplateValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      refValueSchema,
      tplValueSchema,
      z.array(templateValueSchema),
      z.record(z.string(), templateValueSchema),
    ]),
  );

// ── Condition AST ───────────────────────────────────────────────────────────

/**
 * A comparison operand: a scalar literal, a literal scalar list (membership
 * targets for `in`/`contains`), or a `{$ref}` into the run scope. Literal
 * OBJECTS are deliberately not operands — an object with a `$ref` key must
 * be unambiguous.
 */
export type ConditionScalar = string | number | boolean | null;
export type ConditionOperand = ConditionScalar | ConditionScalar[] | RefValue;

/**
 * JSON predicate AST for `filter.where` / `branch.branches[].when`. Pure
 * evaluation (depth-capped, no regex) lives in pipeline-template.ts.
 */
export type PipelineCondition =
  | { and: PipelineCondition[] }
  | { or: PipelineCondition[] }
  | { not: PipelineCondition }
  | { eq: [ConditionOperand, ConditionOperand] }
  | { ne: [ConditionOperand, ConditionOperand] }
  | { gt: [ConditionOperand, ConditionOperand] }
  | { gte: [ConditionOperand, ConditionOperand] }
  | { lt: [ConditionOperand, ConditionOperand] }
  | { lte: [ConditionOperand, ConditionOperand] }
  | { contains: [ConditionOperand, ConditionOperand] }
  | { startsWith: [ConditionOperand, ConditionOperand] }
  | { endsWith: [ConditionOperand, ConditionOperand] }
  | { exists: ConditionOperand }
  | { truthy: ConditionOperand }
  | { empty: ConditionOperand }
  | { in: [ConditionOperand, ConditionOperand] };

const conditionScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const conditionOperandSchema: z.ZodType<ConditionOperand, ConditionOperand> =
  z.union([
    conditionScalarSchema,
    z.array(conditionScalarSchema),
    refValueSchema,
  ]);

const operandPair = z.tuple([conditionOperandSchema, conditionOperandSchema]);

export const pipelineConditionSchema: z.ZodType<
  PipelineCondition,
  PipelineCondition
> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(pipelineConditionSchema) }),
    z.strictObject({ or: z.array(pipelineConditionSchema) }),
    z.strictObject({ not: pipelineConditionSchema }),
    z.strictObject({ eq: operandPair }),
    z.strictObject({ ne: operandPair }),
    z.strictObject({ gt: operandPair }),
    z.strictObject({ gte: operandPair }),
    z.strictObject({ lt: operandPair }),
    z.strictObject({ lte: operandPair }),
    z.strictObject({ contains: operandPair }),
    z.strictObject({ startsWith: operandPair }),
    z.strictObject({ endsWith: operandPair }),
    z.strictObject({ exists: conditionOperandSchema }),
    z.strictObject({ truthy: conditionOperandSchema }),
    z.strictObject({ empty: conditionOperandSchema }),
    z.strictObject({ in: operandPair }),
  ]),
);

// ── Step types (manual — see the recursion note in the module doc) ──────────

export type StepSideEffect = "at_least_once" | "at_most_once";
export type ForEachItemErrorPolicy = "continue" | "halt";
export type AgentStepSession = "fresh" | "thread";

/** Hard cap on `for_each.maxItems`; overflow FAILS the loop (never truncates). */
export const MAX_FOR_EACH_ITEMS = 100;

/** Hard cap on per-step `timeoutMs`. */
export const MAX_STEP_TIMEOUT_MS = 300_000;

interface PipelineStepBase {
  id: string;
  slug: string;
  name?: string;
}

/** Deterministic MCP tool call on a workspace connection. */
export interface ToolStep extends PipelineStepBase {
  kind: "tool";
  /** `cn_` connection id ("" while drafting). */
  connectionId: string;
  /** Tool name as the server lists it ("" while drafting). */
  tool: string;
  /** Tagged-template args (see {@link TemplateValue}). */
  args: Record<string, TemplateValue>;
  timeoutMs?: number;
  retry?: { maxAttempts: number };
  /** Crash-window retry stance; "at_most_once" fails `interrupted` instead. */
  sideEffect: StepSideEffect;
}

export interface ToolStepInput extends PipelineStepBase {
  kind: "tool";
  connectionId?: string;
  tool?: string;
  args?: Record<string, TemplateValue>;
  timeoutMs?: number;
  retry?: { maxAttempts: number };
  sideEffect?: StepSideEffect;
}

/** Direct control-plane model call on a workspace preset (titler precedent). */
export interface InferStep extends PipelineStepBase {
  kind: "infer";
  /** Workspace model-preset slug. */
  preset: string;
  prompt: { markdown: string };
  output?: { schema: OutputSchemaNode };
  maxOutputTokens?: number;
}

export interface InferStepInput extends PipelineStepBase {
  kind: "infer";
  preset?: string;
  prompt: { markdown?: string };
  output?: { schema: OutputSchemaNode };
  maxOutputTokens?: number;
}

/** Real eve session against a bound published Agent, run as a child run. */
export interface AgentStep extends PipelineStepBase {
  kind: "agent";
  /** Null while drafting; publish requires a published agent. */
  agentId: string | null;
  instructions: { markdown: string };
  /** "thread" is legal only with slack triggers and no output schema (publish rule). */
  session: AgentStepSession;
  output?: { schema: OutputSchemaNode };
}

export interface AgentStepInput extends PipelineStepBase {
  kind: "agent";
  agentId?: string | null;
  instructions: { markdown?: string };
  session?: AgentStepSession;
  output?: { schema: OutputSchemaNode };
}

/** Sequential per-item loop. No nested for_each in v1 (workflowConfigSchema enforces). */
export interface ForEachStep extends PipelineStepBase {
  kind: "for_each";
  /** Must resolve to an array at run time. */
  items: RefValue;
  steps: PipelineStep[];
  maxItems: number;
  onItemError: ForEachItemErrorPolicy;
}

export interface ForEachStepInput extends PipelineStepBase {
  kind: "for_each";
  items: RefValue;
  steps: PipelineStepInput[];
  maxItems?: number;
  onItemError?: ForEachItemErrorPolicy;
}

/** First branch whose `when` holds runs; `else` when none do. */
export interface BranchStep extends PipelineStepBase {
  kind: "branch";
  branches: { when: PipelineCondition; steps: PipelineStep[] }[];
  else?: PipelineStep[];
}

export interface BranchStepInput extends PipelineStepBase {
  kind: "branch";
  branches: { when: PipelineCondition; steps: PipelineStepInput[] }[];
  else?: PipelineStepInput[];
}

/**
 * Gate: `where` false at the top level skips every remaining step (run still
 * succeeds); inside a for_each it drops the current item.
 */
export interface FilterStep extends PipelineStepBase {
  kind: "filter";
  where: PipelineCondition;
}

export interface FilterStepInput extends PipelineStepBase {
  kind: "filter";
  where: PipelineCondition;
}

/** Write-only state update; reads are `@state.*` references. */
export interface StateStep extends PipelineStepBase {
  kind: "state";
  set: Record<string, TemplateValue>;
}

export interface StateStepInput extends PipelineStepBase {
  kind: "state";
  set?: Record<string, TemplateValue>;
}

export type PipelineStep =
  | ToolStep
  | InferStep
  | AgentStep
  | ForEachStep
  | BranchStep
  | FilterStep
  | StateStep;

export type PipelineStepInput =
  | ToolStepInput
  | InferStepInput
  | AgentStepInput
  | ForEachStepInput
  | BranchStepInput
  | FilterStepInput
  | StateStepInput;

/** Config-union kinds (what a v2 config may hold today). */
export const PIPELINE_STEP_KINDS = [
  "tool",
  "infer",
  "agent",
  "for_each",
  "branch",
  "filter",
  "state",
] as const;
export type PipelineStepKind = (typeof PIPELINE_STEP_KINDS)[number];

/**
 * Ledger kinds — mirrors the packages/db `run_step_kind` pgEnum, which
 * additionally reserves `script` (Phase 5). Keep them in lockstep.
 */
export const RUN_STEP_KINDS = [...PIPELINE_STEP_KINDS, "script"] as const;
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

// ── Step schemas ────────────────────────────────────────────────────────────

/** Nested step lists (for_each body, branch lanes) — lazy to close the cycle. */
const pipelineStepListSchema: z.ZodType<PipelineStep[], PipelineStepInput[]> =
  z.lazy(() => z.array(pipelineStepSchema));

export const toolStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("tool"),
  connectionId: z.string().default(""),
  tool: z.string().default(""),
  args: z.record(z.string(), templateValueSchema).default({}),
  timeoutMs: z.number().int().positive().max(MAX_STEP_TIMEOUT_MS).optional(),
  retry: z
    .object({ maxAttempts: z.number().int().min(1).max(5) })
    .optional(),
  sideEffect: z
    .enum(["at_least_once", "at_most_once"])
    .default("at_least_once"),
});

export const inferStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("infer"),
  preset: z.string().min(1).default("quick"),
  prompt: z.object({ markdown: z.string().default("") }),
  output: z.object({ schema: outputSchemaSchema }).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const agentStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("agent"),
  agentId: z.uuid().nullable().default(null),
  instructions: z.object({ markdown: z.string().default("") }),
  session: z.enum(["fresh", "thread"]).default("fresh"),
  output: z.object({ schema: outputSchemaSchema }).optional(),
});

export const forEachStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("for_each"),
  items: refValueSchema,
  steps: pipelineStepListSchema,
  maxItems: z.number().int().min(1).max(MAX_FOR_EACH_ITEMS).default(MAX_FOR_EACH_ITEMS),
  onItemError: z.enum(["continue", "halt"]).default("halt"),
});

export const branchStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("branch"),
  branches: z
    .array(z.object({ when: pipelineConditionSchema, steps: pipelineStepListSchema }))
    .min(1),
  else: pipelineStepListSchema.optional(),
});

export const filterStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("filter"),
  where: pipelineConditionSchema,
});

export const stateStepSchema = z.object({
  ...stepBaseShape,
  kind: z.literal("state"),
  set: z
    .record(
      z
        .string()
        .regex(
          STEP_SLUG_PATTERN,
          "state keys must start with a letter and contain only letters, digits, _ or -",
        ),
      templateValueSchema,
    )
    .default({}),
});

/**
 * The step union, discriminated on `kind`. Annotated with the manual types —
 * the annotation doubles as the lockstep check between interfaces and shapes.
 */
export const pipelineStepSchema: z.ZodType<PipelineStep, PipelineStepInput> =
  z.discriminatedUnion("kind", [
    toolStepSchema,
    inferStepSchema,
    agentStepSchema,
    forEachStepSchema,
    branchStepSchema,
    filterStepSchema,
    stateStepSchema,
  ]);

// ── Tree helpers ────────────────────────────────────────────────────────────

/** One step in a pre-order (document-order) walk of the tree. */
export interface StepWalkEntry {
  step: PipelineStep;
  /** Enclosing container steps, outermost first; [] at the top level. */
  ancestors: PipelineStep[];
  /**
   * Slot within the innermost ancestor: a for_each `body`, a branch lane
   * (`then`), or a branch `else`. Null at the top level. Matches the copilot
   * step-position slot vocabulary.
   */
  slot: "body" | "then" | "else" | null;
  /** Lane index when `slot` is "then". */
  branchIndex: number | null;
  /**
   * Path from the config's `steps` array to this step — e.g.
   * `[0, "branches", 1, "steps", 2]` — so validators can address diagnostics
   * (`steps.0.branches.1.steps.2.args.title`).
   */
  configPath: (string | number)[];
}

/** Pre-order walk of the whole step tree (containers before their children). */
export function walkSteps(steps: readonly PipelineStep[]): StepWalkEntry[] {
  const entries: StepWalkEntry[] = [];
  const visit = (
    list: readonly PipelineStep[],
    ancestors: PipelineStep[],
    slot: StepWalkEntry["slot"],
    branchIndex: number | null,
    prefix: (string | number)[],
  ): void => {
    list.forEach((step, index) => {
      const configPath = [...prefix, index];
      entries.push({ step, ancestors, slot, branchIndex, configPath });
      if (step.kind === "for_each") {
        visit(step.steps, [...ancestors, step], "body", null, [
          ...configPath,
          "steps",
        ]);
      } else if (step.kind === "branch") {
        step.branches.forEach((branch, lane) => {
          visit(branch.steps, [...ancestors, step], "then", lane, [
            ...configPath,
            "branches",
            lane,
            "steps",
          ]);
        });
        if (step.else) {
          visit(step.else, [...ancestors, step], "else", null, [
            ...configPath,
            "else",
          ]);
        }
      }
    });
  };
  visit(steps, [], null, null, []);
  return entries;
}

/** Find a step anywhere in the tree by id. */
export function findStep(
  steps: readonly PipelineStep[],
  stepId: string,
): PipelineStep | null {
  for (const entry of walkSteps(steps)) {
    if (entry.step.id === stepId) return entry.step;
  }
  return null;
}

/**
 * Steps whose output is addressable FROM the given step's position: every
 * step strictly before it in document order, minus its own ancestors (a
 * container has no output while you are inside it). Purely lexical — steps in
 * an earlier branch's other lanes are included even though a given run may
 * have skipped them (their refs resolve "(not provided)"). Reference
 * autocomplete and the publish validator both key off this.
 */
export function stepsBefore(
  steps: readonly PipelineStep[],
  stepId: string,
): PipelineStep[] {
  const entries = walkSteps(steps);
  const targetIndex = entries.findIndex((entry) => entry.step.id === stepId);
  if (targetIndex === -1) return [];
  const target = entries[targetIndex];
  if (!target) return [];
  const ancestorIds = new Set(target.ancestors.map((ancestor) => ancestor.id));
  return entries
    .slice(0, targetIndex)
    .filter((entry) => !ancestorIds.has(entry.step.id))
    .map((entry) => entry.step);
}
