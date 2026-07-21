/**
 * Workflow editor model — a pure reducer over the {@link WorkflowConfig}
 * delegation (TRIGGER → AGENT → INSTRUCTIONS). The UI dispatches semantic
 * actions; the config the reducer carries is EXACTLY what gets PATCHed to
 * `workflows.draft` (round-trip lossless: `definitionOf(initBuilderState(d))`
 * deep-equals `d` — proven in __tests__/builder-model.test.ts).
 *
 * Trigger configs are kept per-type in `triggerDrafts` so switching a
 * trigger's type back and forth never loses work (e.g. a designed form
 * survives a peek at "webhook").
 */
import type {
  FormField,
  FormFieldType,
  SlackTriggerBinding,
  TriggerConfig,
  WorkflowConfig,
} from "@invisible-string/shared";

// ── Sections ────────────────────────────────────────────────────────────────
//
// The delegation memo's three sections, in reading order: when it runs → who
// does the work → what they should do. Diagnostics, copilot section flashes
// and the editor column all key off these.

export const WORKFLOW_SECTIONS = ["trigger", "agent", "instructions"] as const;
export type WorkflowSection = (typeof WORKFLOW_SECTIONS)[number];

export const WORKFLOW_SECTION_LABELS: Record<WorkflowSection, string> = {
  trigger: "Trigger",
  agent: "Agent",
  instructions: "Instructions",
};

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
 * A shape-valid empty config for a brand-new workflow. The caller supplies
 * the workspace's first PUBLISHED agent id — or null when none exists yet
 * (the draft stays saveable; the Agent section surfaces the gap and publish
 * is blocked until an agent is chosen).
 */
export function emptyDefinition(agentId: string | null): WorkflowConfig {
  return {
    trigger: { type: "manual" },
    agentId,
    instructions: { markdown: "" },
  };
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

// ── Actions ─────────────────────────────────────────────────────────────────

export type BuilderAction =
  | { type: "setTriggerType"; triggerType: TriggerType }
  | { type: "setTrigger"; trigger: TriggerConfig }
  | { type: "addFormField" }
  | { type: "updateFormField"; index: number; patch: Partial<FormField> }
  | { type: "removeFormField"; index: number }
  | { type: "moveFormField"; index: number; direction: -1 | 1 }
  | { type: "setSlackBinding"; patch: Partial<SlackTriggerBinding> }
  | { type: "setCron"; cron: string }
  | { type: "setAgentId"; id: string | null }
  | { type: "setInstructions"; markdown: string };

// ── Reducer ─────────────────────────────────────────────────────────────────

function withTrigger(state: BuilderState, trigger: TriggerConfig): BuilderState {
  return {
    ...state,
    definition: { ...state.definition, trigger },
    triggerDrafts: { ...state.triggerDrafts, [trigger.type]: trigger },
  };
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
      // Whole-config replacement (copilot suggestions land here) — same
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

    case "setAgentId":
      return {
        ...state,
        definition: { ...state.definition, agentId: action.id },
      };

    case "setInstructions":
      return {
        ...state,
        definition: {
          ...state.definition,
          instructions: { markdown: action.markdown },
        },
      };
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
