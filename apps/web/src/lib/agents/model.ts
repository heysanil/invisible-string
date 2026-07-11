/**
 * Agent editor model — a pure reducer over the agent's editable server state:
 * the {@link AgentDefinition} draft (PERSONA · MODEL · CONTEXT) plus the two
 * row-level fields the editor owns (description, run-as). The UI dispatches
 * semantic actions; {@link agentPatchOf} is EXACTLY what gets PATCHed to
 * `/workspaces/:id/agents/:agentId` (the editor always writes whole
 * definitions — round-trip lossless, proven in __tests__/agent-editor.test.tsx).
 *
 * The agent NAME is deliberately not here: the header commits it directly
 * (its own PATCH), mirroring the workflow builder's split.
 */
import {
  parseAgentDefinition,
  type AgentDefinition,
  type AgentDto,
  type ModelPresetSlug,
  type ReasoningEffort,
  type UpdateAgentRequest,
} from "@invisible-string/shared";

// ── Sections (the rail's anchor cards + diagnostics routing) ────────────────

export const AGENT_SECTIONS = ["persona", "model", "context", "access"] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

export const AGENT_SECTION_LABELS: Record<AgentSection, string> = {
  persona: "Persona",
  model: "Model",
  context: "Context",
  access: "Access",
};

// ── State ───────────────────────────────────────────────────────────────────

export interface AgentEditorState {
  /** The `agents.draft` definition (what publish snapshots + compiles). */
  definition: AgentDefinition;
  /** Card-grid one-liner (`agents.description` column, not part of the draft). */
  description: string | null;
  /** Credentials owner — chat and every delegating workflow run as this member. */
  runAsUserId: string;
}

/** A shape-valid empty definition for a brand-new agent draft. */
export function emptyAgentDefinition(): AgentDefinition {
  return {
    persona: "",
    model: { preset: "balanced", reasoning: "medium" },
    context: { mcpConnectionIds: [], skillIds: [] },
  };
}

/**
 * Seed the reducer from the stored row. A shape-invalid stored draft (never
 * written by this editor) degrades to an empty definition rather than a
 * crashed screen.
 */
export function initAgentEditorState(agent: AgentDto): AgentEditorState {
  return {
    definition: parseAgentDefinition(agent.draft) ?? emptyAgentDefinition(),
    description: agent.description,
    runAsUserId: agent.runAsUserId,
  };
}

/** The PATCH body the editor would persist right now (full replacement). */
export function agentPatchOf(state: AgentEditorState): UpdateAgentRequest {
  return {
    draft: state.definition,
    description: state.description,
    runAsUserId: state.runAsUserId,
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type AgentEditorAction =
  | { type: "setPersona"; markdown: string }
  | { type: "setDescription"; description: string }
  | { type: "setModelPreset"; preset: ModelPresetSlug }
  | { type: "setModelId"; modelId: string | undefined }
  | { type: "setReasoning"; reasoning: ReasoningEffort }
  | { type: "addConnection"; id: string }
  | { type: "removeConnection"; id: string }
  | { type: "addSkill"; id: string }
  | { type: "removeSkill"; id: string }
  | { type: "setRunAs"; userId: string };

// ── Reducer ─────────────────────────────────────────────────────────────────

function withDefinition(
  state: AgentEditorState,
  definition: AgentDefinition,
): AgentEditorState {
  return { ...state, definition };
}

/** Model rebuild — omits a cleared override instead of writing undefined. */
function withModel(
  state: AgentEditorState,
  patch: Partial<Pick<AgentDefinition["model"], "preset" | "reasoning">> & {
    modelId?: string | undefined | null;
  },
): AgentEditorState {
  const current = state.definition.model;
  const next: AgentDefinition["model"] = {
    preset: patch.preset ?? current.preset,
    reasoning: patch.reasoning ?? current.reasoning,
  };
  const modelId = "modelId" in patch ? patch.modelId : current.modelId;
  if (modelId != null) next.modelId = modelId;
  return withDefinition(state, { ...state.definition, model: next });
}

export function agentEditorReducer(
  state: AgentEditorState,
  action: AgentEditorAction,
): AgentEditorState {
  switch (action.type) {
    case "setPersona":
      return withDefinition(state, {
        ...state.definition,
        persona: action.markdown,
      });

    case "setDescription":
      // An emptied input clears the column (DTO stores null, not "").
      return {
        ...state,
        description: action.description === "" ? null : action.description,
      };

    case "setModelPreset":
      return withModel(state, { preset: action.preset });

    case "setModelId":
      return withModel(state, { modelId: action.modelId ?? null });

    case "setReasoning":
      return withModel(state, { reasoning: action.reasoning });

    case "addConnection": {
      const context = state.definition.context;
      if (context.mcpConnectionIds.includes(action.id)) return state;
      return withDefinition(state, {
        ...state.definition,
        context: {
          ...context,
          mcpConnectionIds: [...context.mcpConnectionIds, action.id],
        },
      });
    }

    case "removeConnection": {
      const context = state.definition.context;
      return withDefinition(state, {
        ...state.definition,
        context: {
          ...context,
          mcpConnectionIds: context.mcpConnectionIds.filter(
            (id) => id !== action.id,
          ),
        },
      });
    }

    case "addSkill": {
      const context = state.definition.context;
      if (context.skillIds.includes(action.id)) return state;
      return withDefinition(state, {
        ...state.definition,
        context: { ...context, skillIds: [...context.skillIds, action.id] },
      });
    }

    case "removeSkill": {
      const context = state.definition.context;
      return withDefinition(state, {
        ...state.definition,
        context: {
          ...context,
          skillIds: context.skillIds.filter((id) => id !== action.id),
        },
      });
    }

    case "setRunAs":
      return { ...state, runAsUserId: action.userId };
  }
}

// ── Small helpers the UI shares ─────────────────────────────────────────────

/** Structural equality on editor states (undefined-key insensitive). */
export function agentEditorStatesEqual(
  a: AgentEditorState,
  b: AgentEditorState,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
