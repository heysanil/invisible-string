/**
 * Builder editor model — a pure reducer over the four-pillar
 * {@link WorkflowDefinition}. The UI dispatches semantic actions; the
 * definition the reducer carries is EXACTLY what gets PATCHed to
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
  ModelPresetSlug,
  ReasoningEffort,
  SlackTriggerBinding,
  TriggerConfig,
  WorkflowDefinition,
} from "@invisible-string/shared";

// ── Pillars ─────────────────────────────────────────────────────────────────

export const PILLARS = ["trigger", "context", "agent", "instructions"] as const;
export type Pillar = (typeof PILLARS)[number];

export const PILLAR_LABELS: Record<Pillar, string> = {
  trigger: "Trigger",
  context: "Context",
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
  definition: WorkflowDefinition;
  triggerDrafts: TriggerDrafts;
  activePillar: Pillar;
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
 * A shape-valid empty definition for a brand-new workflow. The caller
 * supplies the workspace's first agent preset id — a definition without one
 * cannot be saved (agentPresetId must be a uuid).
 */
export function emptyDefinition(agentPresetId: string): WorkflowDefinition {
  return {
    trigger: { type: "manual" },
    context: { mcpConnectionIds: [], skillIds: [] },
    agent: { agentPresetId },
    instructions: { markdown: "" },
  };
}

export function initBuilderState(definition: WorkflowDefinition): BuilderState {
  const drafts = defaultTriggerDrafts();
  const trigger = definition.trigger;
  // Seed the matching per-type draft with the stored config.
  const triggerDrafts: TriggerDrafts = { ...drafts, [trigger.type]: trigger };
  return { definition, triggerDrafts, activePillar: "trigger" };
}

/** The definition the builder would persist right now. */
export function definitionOf(state: BuilderState): WorkflowDefinition {
  return state.definition;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type BuilderAction =
  | { type: "focusPillar"; pillar: Pillar }
  | { type: "setTriggerType"; triggerType: TriggerType }
  | { type: "setTrigger"; trigger: TriggerConfig }
  | { type: "addFormField" }
  | { type: "updateFormField"; index: number; patch: Partial<FormField> }
  | { type: "removeFormField"; index: number }
  | { type: "moveFormField"; index: number; direction: -1 | 1 }
  | { type: "setSlackBinding"; patch: Partial<SlackTriggerBinding> }
  | { type: "setCron"; cron: string }
  | { type: "addConnection"; id: string }
  | { type: "removeConnection"; id: string }
  | { type: "addSkill"; id: string }
  | { type: "removeSkill"; id: string }
  | { type: "setAgentPreset"; id: string }
  | { type: "setModelPreset"; preset: ModelPresetSlug | undefined }
  | { type: "setModelId"; modelId: string | undefined }
  | { type: "setReasoning"; reasoning: ReasoningEffort | undefined }
  | { type: "setInstructions"; markdown: string };

// ── Reducer ─────────────────────────────────────────────────────────────────

function withTrigger(state: BuilderState, trigger: TriggerConfig): BuilderState {
  return {
    ...state,
    definition: { ...state.definition, trigger },
    triggerDrafts: { ...state.triggerDrafts, [trigger.type]: trigger },
  };
}

/** Agent pillar rebuild — omits cleared overrides instead of writing undefined. */
function withAgent(
  state: BuilderState,
  patch: {
    agentPresetId?: string;
    modelPreset?: ModelPresetSlug | undefined | null;
    modelId?: string | undefined | null;
    reasoning?: ReasoningEffort | undefined | null;
  },
): BuilderState {
  const current = state.definition.agent;
  const next: WorkflowDefinition["agent"] = {
    agentPresetId: patch.agentPresetId ?? current.agentPresetId,
  };
  const modelPreset =
    "modelPreset" in patch ? patch.modelPreset : current.modelPreset;
  const modelId = "modelId" in patch ? patch.modelId : current.modelId;
  const reasoning = "reasoning" in patch ? patch.reasoning : current.reasoning;
  if (modelPreset != null) next.modelPreset = modelPreset;
  if (modelId != null) next.modelId = modelId;
  if (reasoning != null) next.reasoning = reasoning;
  return { ...state, definition: { ...state.definition, agent: next } };
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
    case "focusPillar":
      return { ...state, activePillar: action.pillar };

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

    case "addConnection": {
      const context = state.definition.context;
      if (context.mcpConnectionIds.includes(action.id)) return state;
      return {
        ...state,
        definition: {
          ...state.definition,
          context: {
            ...context,
            mcpConnectionIds: [...context.mcpConnectionIds, action.id],
          },
        },
      };
    }

    case "removeConnection": {
      const context = state.definition.context;
      return {
        ...state,
        definition: {
          ...state.definition,
          context: {
            ...context,
            mcpConnectionIds: context.mcpConnectionIds.filter(
              (id) => id !== action.id,
            ),
          },
        },
      };
    }

    case "addSkill": {
      const context = state.definition.context;
      if (context.skillIds.includes(action.id)) return state;
      return {
        ...state,
        definition: {
          ...state.definition,
          context: { ...context, skillIds: [...context.skillIds, action.id] },
        },
      };
    }

    case "removeSkill": {
      const context = state.definition.context;
      return {
        ...state,
        definition: {
          ...state.definition,
          context: {
            ...context,
            skillIds: context.skillIds.filter((id) => id !== action.id),
          },
        },
      };
    }

    case "setAgentPreset":
      return withAgent(state, { agentPresetId: action.id });

    case "setModelPreset":
      return withAgent(state, { modelPreset: action.preset ?? null });

    case "setModelId":
      return withAgent(state, { modelId: action.modelId ?? null });

    case "setReasoning":
      return withAgent(state, { reasoning: action.reasoning ?? null });

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

/** Structural equality on definitions (undefined-key insensitive). */
export function definitionsEqual(
  a: WorkflowDefinition,
  b: WorkflowDefinition,
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
