/**
 * Workflow editor model — a pure reducer over the v2 {@link WorkflowConfig}
 * pipeline (TRIGGER → STEPS). The UI dispatches semantic actions; the config
 * the reducer carries is EXACTLY what gets PATCHed to `workflows.draft`
 * (round-trip lossless: `definitionOf(initBuilderState(d))` deep-equals `d` —
 * proven in __tests__/builder-model.test.ts).
 *
 * The step actions (`addStep` / `updateStep` / `removeStep` / `moveStep`)
 * carry EXACTLY the copilot mutation param shapes (packages/shared/copilot.ts)
 * so an accepted proposal dispatches straight through the same single-writer
 * path as a manual edit — plus `patchStepParams`, the keystroke-level partial
 * the inspector forms use (never exposed to the copilot: proposals replace
 * whole steps).
 *
 * Trigger configs are kept per-type in `triggerDrafts` so switching a
 * trigger's type back and forth never loses work (e.g. a designed form
 * survives a peek at "webhook").
 */
import {
  findStep,
  newStepId,
  WORKFLOW_CONFIG_VERSION,
  type AddStepParams,
  type FormField,
  type FormFieldType,
  type MoveStepParams,
  type PipelineStep,
  type PipelineStepKind,
  type RemoveStepParams,
  type SlackTriggerBinding,
  type StepPosition,
  type TriggerConfig,
  type UpdateStepParams,
  type WorkflowConfig,
  type WorkflowOnComplete,
  type WorkflowOverlapPolicy,
  walkSteps,
} from "@invisible-string/shared";

export type TriggerType = TriggerConfig["type"];

export const TRIGGER_TYPES: readonly TriggerType[] = [
  "manual",
  "form",
  "webhook",
  "slack",
  "schedule",
];

// ── State ───────────────────────────────────────────────────────────────────

type TriggerOf<T extends TriggerType> = Extract<TriggerConfig, { type: T }>;

/** One draft per trigger type — switching types never destroys config. */
export interface TriggerDrafts {
  manual: TriggerOf<"manual">;
  form: TriggerOf<"form">;
  webhook: TriggerOf<"webhook">;
  slack: TriggerOf<"slack">;
  schedule: TriggerOf<"schedule">;
}

export interface BuilderState {
  definition: WorkflowConfig;
  triggerDrafts: TriggerDrafts;
}

// ── Defaults ────────────────────────────────────────────────────────────────

export function defaultFormField(existing: readonly FormField[]): FormField {
  let n = existing.length + 1;
  let key = `field-${n}`;
  const keys = new Set(existing.map((field) => field.key));
  while (keys.has(key)) {
    n += 1;
    key = `field-${n}`;
  }
  return { key, label: "", type: "text", required: false };
}

function defaultTriggerDrafts(): TriggerDrafts {
  return {
    manual: { type: "manual" },
    form: { type: "form", fields: [defaultFormField([])] },
    webhook: { type: "webhook" },
    slack: {
      type: "slack",
      binding: { mentionOnly: true, includeDirectMessages: false },
    },
    schedule: { type: "schedule", cron: "0 9 * * 1" },
  };
}

/**
 * A shape-valid empty v2 config for a brand-new workflow: no steps yet (a
 * valid DRAFT — publish requires ≥1), default overlap policy.
 */
export function emptyDefinition(): WorkflowConfig {
  return {
    version: WORKFLOW_CONFIG_VERSION,
    trigger: { type: "manual" },
    steps: [],
    overlap: "skip",
  };
}

/**
 * A fresh step of `kind` with a minted id and a unique default slug (so the
 * step is referenceable the moment it exists — publish requires non-empty
 * slugs anyway). The AddStepMenu dispatches these through `addStep`.
 */
export function newStep(
  kind: PipelineStepKind,
  existing: readonly PipelineStep[],
): PipelineStep {
  const base = {
    id: newStepId(),
    slug: defaultStepSlug(kind, existing),
  };
  switch (kind) {
    case "tool":
      return { ...base, kind, connectionId: "", tool: "", args: {}, sideEffect: "at_least_once" };
    case "infer":
      return { ...base, kind, preset: "quick", prompt: { markdown: "" } };
    case "agent":
      return { ...base, kind, agentId: null, instructions: { markdown: "" }, session: "fresh" };
    case "for_each":
      return { ...base, kind, items: { $ref: "" }, steps: [], maxItems: 100, onItemError: "halt" };
    case "branch":
      return { ...base, kind, branches: [{ when: { truthy: { $ref: "" } }, steps: [] }] };
    case "filter":
      return { ...base, kind, where: { truthy: { $ref: "" } } };
    case "state":
      return { ...base, kind, set: {} };
  }
}

/** kebab `<kind>-<n>` avoiding every slug already in the tree. */
export function defaultStepSlug(
  kind: PipelineStepKind,
  existing: readonly PipelineStep[],
): string {
  const taken = new Set(
    walkSteps(existing).map((entry) => entry.step.slug),
  );
  const base = kind.replace(/_/g, "-");
  let n = 1;
  let slug = `${base}-${n}`;
  while (taken.has(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

export function initBuilderState(definition: WorkflowConfig): BuilderState {
  const drafts = defaultTriggerDrafts();
  const trigger = definition.trigger;
  // Seed the matching per-type draft with the stored config.
  const triggerDrafts: TriggerDrafts = { ...drafts, [trigger.type]: trigger };
  return { definition, triggerDrafts };
}

/** The config the builder would persist right now. */
export function definitionOf(state: BuilderState): WorkflowConfig {
  return state.definition;
}

// ── Step tree operations (pure) ─────────────────────────────────────────────
//
// The client-side twin of the copilot server's validate.ts application logic:
// positions use the shared {@link StepPosition} vocabulary (`after` sibling +
// optional container `parent`/`slot`; a branch's `then` LANE is resolved from
// `after`, `after: null` targeting the first lane). Every operation is
// all-or-nothing: an unresolvable position returns null and the reducer
// no-ops, leaving the draft exactly as it was.

/** Remove `stepId` (subtree and all) wherever it sits. */
export function removeStepFromTree(
  steps: readonly PipelineStep[],
  stepId: string,
): { steps: PipelineStep[]; removed: PipelineStep | null } {
  let removed: PipelineStep | null = null;

  const visit = (list: readonly PipelineStep[]): PipelineStep[] => {
    const next: PipelineStep[] = [];
    for (const step of list) {
      if (step.id === stepId) {
        removed = step;
        continue;
      }
      if (removed !== null) {
        // Already found — copy the rest verbatim.
        next.push(step);
        continue;
      }
      if (step.kind === "for_each") {
        const body = visit(step.steps);
        next.push(removed !== null ? { ...step, steps: body } : step);
      } else if (step.kind === "branch") {
        const branches = step.branches.map((branch) => ({
          ...branch,
          steps: visit(branch.steps),
        }));
        const elseSteps = step.else && removed === null ? visit(step.else) : step.else;
        next.push(
          removed !== null
            ? { ...step, branches, ...(elseSteps ? { else: elseSteps } : {}) }
            : step,
        );
      } else {
        next.push(step);
      }
    }
    return next;
  };

  const result = visit(steps);
  return removed === null
    ? { steps: [...steps], removed: null }
    : { steps: result, removed };
}

/** Insert `step` into a sibling list after `after` (null = head). */
function insertIntoList(
  list: readonly PipelineStep[],
  step: PipelineStep,
  after: string | null,
): PipelineStep[] | null {
  if (after === null) return [step, ...list];
  const index = list.findIndex((sibling) => sibling.id === after);
  if (index === -1) return null;
  const next = [...list];
  next.splice(index + 1, 0, step);
  return next;
}

/**
 * Insert `step` at `position`. Null when the position does not resolve: an
 * unknown `after`/`parent` id, a slot the parent kind does not have, or (for
 * branch `then`) an anchor living in no lane. A missing `else` list is
 * created — targeting it is how the first else step arrives.
 */
export function insertStepAt(
  steps: readonly PipelineStep[],
  step: PipelineStep,
  position: StepPosition,
): PipelineStep[] | null {
  const parent = position.parent;
  if (parent === undefined) {
    return insertIntoList(steps, step, position.after);
  }

  let found = false;
  let failed = false;

  const visit = (list: readonly PipelineStep[]): PipelineStep[] =>
    list.map((candidate) => {
      if (found || failed || candidate.id !== parent.stepId) {
        if (candidate.kind === "for_each" && !found && !failed) {
          return { ...candidate, steps: visit(candidate.steps) };
        }
        if (candidate.kind === "branch" && !found && !failed) {
          const branches = candidate.branches.map((branch) => ({
            ...branch,
            steps: visit(branch.steps),
          }));
          const elseSteps = candidate.else ? visit(candidate.else) : candidate.else;
          return {
            ...candidate,
            branches,
            ...(elseSteps ? { else: elseSteps } : {}),
          };
        }
        return candidate;
      }

      // This is the parent — place `step` into the requested slot.
      if (candidate.kind === "for_each" && parent.slot === "body") {
        const body = insertIntoList(candidate.steps, step, position.after);
        if (body === null) {
          failed = true;
          return candidate;
        }
        found = true;
        return { ...candidate, steps: body };
      }
      if (candidate.kind === "branch" && parent.slot === "then") {
        const laneIndex =
          position.after === null
            ? 0
            : candidate.branches.findIndex((branch) =>
                branch.steps.some((sibling) => sibling.id === position.after),
              );
        const lane = candidate.branches[laneIndex];
        if (lane === undefined) {
          failed = true;
          return candidate;
        }
        const laneSteps = insertIntoList(lane.steps, step, position.after);
        if (laneSteps === null) {
          failed = true;
          return candidate;
        }
        found = true;
        const branches = [...candidate.branches];
        branches[laneIndex] = { ...lane, steps: laneSteps };
        return { ...candidate, branches };
      }
      if (candidate.kind === "branch" && parent.slot === "else") {
        const elseSteps = insertIntoList(candidate.else ?? [], step, position.after);
        if (elseSteps === null) {
          failed = true;
          return candidate;
        }
        found = true;
        return { ...candidate, else: elseSteps };
      }

      // The parent exists but has no such slot (e.g. body on a filter).
      failed = true;
      return candidate;
    });

  const next = visit(steps);
  return found && !failed ? next : null;
}

/** Replace the step named `stepId` in place (position preserved). */
export function replaceStepInTree(
  steps: readonly PipelineStep[],
  stepId: string,
  replacement: PipelineStep,
): PipelineStep[] | null {
  let found = false;

  const visit = (list: readonly PipelineStep[]): PipelineStep[] =>
    list.map((candidate) => {
      if (found) return candidate;
      if (candidate.id === stepId) {
        found = true;
        return replacement;
      }
      if (candidate.kind === "for_each") {
        return { ...candidate, steps: visit(candidate.steps) };
      }
      if (candidate.kind === "branch") {
        const branches = candidate.branches.map((branch) => ({
          ...branch,
          steps: visit(branch.steps),
        }));
        const elseSteps = candidate.else ? visit(candidate.else) : candidate.else;
        return { ...candidate, branches, ...(elseSteps ? { else: elseSteps } : {}) };
      }
      return candidate;
    });

  const next = visit(steps);
  return found ? next : null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Keystroke-level partial for one step's own fields (`id`/`kind` are
 * identity and never patchable). Same-kind by contract: the inspector form
 * that dispatches this renders exactly one step's fields.
 */
type PatchOf<S extends PipelineStep> = Partial<Omit<S, "id" | "kind">>;
export type StepParamsPatch =
  | PatchOf<Extract<PipelineStep, { kind: "tool" }>>
  | PatchOf<Extract<PipelineStep, { kind: "infer" }>>
  | PatchOf<Extract<PipelineStep, { kind: "agent" }>>
  | PatchOf<Extract<PipelineStep, { kind: "for_each" }>>
  | PatchOf<Extract<PipelineStep, { kind: "branch" }>>
  | PatchOf<Extract<PipelineStep, { kind: "filter" }>>
  | PatchOf<Extract<PipelineStep, { kind: "state" }>>;

export type BuilderAction =
  | { type: "setTriggerType"; triggerType: TriggerType }
  | { type: "setTrigger"; trigger: TriggerConfig }
  | { type: "addFormField" }
  | { type: "updateFormField"; index: number; patch: Partial<FormField> }
  | { type: "removeFormField"; index: number }
  | { type: "moveFormField"; index: number; direction: -1 | 1 }
  | { type: "setSlackBinding"; patch: Partial<SlackTriggerBinding> }
  | { type: "setCron"; cron: string }
  // Step mutations — payloads are the copilot param shapes verbatim.
  | ({ type: "addStep" } & AddStepParams)
  | ({ type: "updateStep" } & UpdateStepParams)
  | ({ type: "removeStep" } & RemoveStepParams)
  | ({ type: "moveStep" } & MoveStepParams)
  | { type: "patchStepParams"; stepId: string; patch: StepParamsPatch }
  // Run-policy / delivery edits.
  | { type: "setOverlap"; overlap: WorkflowOverlapPolicy }
  | { type: "setOnComplete"; onComplete: WorkflowOnComplete | undefined };

// ── Reducer ─────────────────────────────────────────────────────────────────

function withTrigger(state: BuilderState, trigger: TriggerConfig): BuilderState {
  return {
    ...state,
    definition: { ...state.definition, trigger },
    triggerDrafts: { ...state.triggerDrafts, [trigger.type]: trigger },
  };
}

function withSteps(
  state: BuilderState,
  steps: PipelineStep[] | null,
): BuilderState {
  // Null = the tree operation could not resolve (stale id, bad slot) — the
  // draft stays untouched rather than half-applied.
  if (steps === null) return state;
  return { ...state, definition: { ...state.definition, steps } };
}

function updateFormFields(
  state: BuilderState,
  update: (fields: readonly FormField[]) => FormField[],
): BuilderState {
  const trigger = state.definition.trigger;
  if (trigger.type !== "form") return state;
  return withTrigger(state, { ...trigger, fields: update(trigger.fields) });
}

/** Strip `options` unless the field is (still) a select. */
function normalizeField(field: FormField): FormField {
  if (field.type === "select") {
    return { ...field, options: field.options ?? [] };
  }
  if (field.options === undefined) return field;
  const { options: _options, ...rest } = field;
  return rest;
}

export function builderReducer(
  state: BuilderState,
  action: BuilderAction,
): BuilderState {
  switch (action.type) {
    case "setTrigger":
      // Whole-config replacement (copilot proposals land here) — same
      // draft-preserving path as manual edits.
      return withTrigger(state, action.trigger);

    case "setTriggerType": {
      if (state.definition.trigger.type === action.triggerType) return state;
      return withTrigger(state, state.triggerDrafts[action.triggerType]);
    }

    case "addFormField":
      return updateFormFields(state, (fields) => [
        ...fields,
        defaultFormField(fields),
      ]);

    case "updateFormField":
      return updateFormFields(state, (fields) =>
        fields.map((field, index) =>
          index === action.index
            ? normalizeField({ ...field, ...action.patch })
            : field,
        ),
      );

    case "removeFormField":
      return updateFormFields(state, (fields) =>
        fields.filter((_field, index) => index !== action.index),
      );

    case "moveFormField":
      return updateFormFields(state, (fields) => {
        const target = action.index + action.direction;
        if (action.index < 0 || action.index >= fields.length) return [...fields];
        if (target < 0 || target >= fields.length) return [...fields];
        const next = [...fields];
        const [moved] = next.splice(action.index, 1);
        if (moved !== undefined) next.splice(target, 0, moved);
        return next;
      });

    case "setSlackBinding": {
      const trigger = state.definition.trigger;
      if (trigger.type !== "slack") return state;
      const binding: SlackTriggerBinding = { ...trigger.binding, ...action.patch };
      // Clearing the channel means "any channel" — drop the key entirely.
      if (
        ("channelId" in action.patch && action.patch.channelId === undefined) ||
        binding.channelId === ""
      ) {
        delete binding.channelId;
      }
      return withTrigger(state, { ...trigger, binding });
    }

    case "setCron": {
      const trigger = state.definition.trigger;
      if (trigger.type !== "schedule") return state;
      return withTrigger(state, { ...trigger, cron: action.cron });
    }

    case "addStep":
      return withSteps(
        state,
        insertStepAt(state.definition.steps, action.step, action.position),
      );

    case "updateStep": {
      // A replacement can rename a slug but never re-identify the step — the
      // same invariant validate.ts enforces server-side.
      const replacement = { ...action.step, id: action.stepId };
      return withSteps(
        state,
        replaceStepInTree(state.definition.steps, action.stepId, replacement),
      );
    }

    case "removeStep": {
      const { steps, removed } = removeStepFromTree(
        state.definition.steps,
        action.stepId,
      );
      return withSteps(state, removed === null ? null : steps);
    }

    case "moveStep": {
      const { steps, removed } = removeStepFromTree(
        state.definition.steps,
        action.stepId,
      );
      if (removed === null) return state;
      // A position inside the moved subtree (its parent/anchor is gone from
      // the pruned tree) makes insertStepAt return null → whole move no-ops.
      return withSteps(state, insertStepAt(steps, removed, action.position));
    }

    case "patchStepParams": {
      const current = findStep(state.definition.steps, action.stepId);
      if (current === null) return state;
      // Same-kind merge by the inspector-form contract; id/kind are pinned so
      // a stray patch can never re-identify or re-kind a step.
      const next = {
        ...current,
        ...action.patch,
        id: current.id,
        kind: current.kind,
      } as PipelineStep;
      return withSteps(
        state,
        replaceStepInTree(state.definition.steps, action.stepId, next),
      );
    }

    case "setOverlap":
      return {
        ...state,
        definition: { ...state.definition, overlap: action.overlap },
      };

    case "setOnComplete": {
      if (action.onComplete === undefined) {
        const { onComplete: _onComplete, ...rest } = state.definition;
        return { ...state, definition: rest };
      }
      return {
        ...state,
        definition: { ...state.definition, onComplete: action.onComplete },
      };
    }
  }
}

// ── Small helpers the UI shares ─────────────────────────────────────────────

/** Structural equality on configs (undefined-key insensitive). */
export function definitionsEqual(
  a: WorkflowConfig,
  b: WorkflowConfig,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const FORM_FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Text",
  textarea: "Long text",
  number: "Number",
  select: "Select",
  checkbox: "Checkbox",
  date: "Date",
};
