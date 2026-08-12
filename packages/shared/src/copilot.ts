/**
 * Copilot WS protocol (spec §12, PLAN Phase 4) — typed frames exchanged over
 * `WS /workspaces/:workspaceId/copilot` between a docked copilot rail (the
 * workflow editor OR the agent editor — one socket, two surfaces) and the
 * control plane, plus the per-tool mutation param schemas.
 *
 * Contract highlights:
 * - The copilot NEVER mutates the draft server-side. Every edit is a
 *   structured **proposal** `{id, tool, params, rationale}` streamed to the
 *   client; the client previews it and applies accepted mutations through the
 *   editor controller (single writer), then reports the outcome back with a
 *   `mutation_result` frame so the model's tool loop can continue.
 * - ALLOW-EDITS MODE (2026-08-11 spec D7) does not move the writer: the client
 *   still applies, but it stops asking first. The client carries the toggle on
 *   every `user_message` and the server echoes `autoApplied: true` on the
 *   proposals it did not wait for — see {@link CopilotProposalFrame}.
 * - The dock renders the same rail-in-box grammar as the main chat, fed by
 *   `thought` / `step` frames whose vocabulary deliberately mirrors the chat's
 *   `ThoughtItem` / `ToolItem` (apps/web/src/lib/chat/run-view.ts) rather than
 *   inventing a second one.
 * - Each `user_message` names its `surface` ("workflow" | "agent"); the
 *   server exposes the matching toolset — proposals for the other surface's
 *   tools are a server bug.
 * - Mutation param schemas mirror `workflow-config.ts` /
 *   `agent-definition.ts` exactly — a proposal that parses here is directly
 *   applicable to the draft.
 */
import { z } from "zod";

import {
  modelPresetSlugSchema,
  reasoningEffortSchema,
} from "./agent-definition";
import { agentNameSchema, connectionIdSchema } from "./api";
import { triggerConfigSchema } from "./workflow-config";

// ── surfaces ─────────────────────────────────────────────────────────────────

/** Which editor a copilot turn is about. */
export const copilotSurfaceSchema = z.enum(["workflow", "agent"]);
export type CopilotSurface = z.infer<typeof copilotSurfaceSchema>;

// ── workflow-surface mutation tools ──────────────────────────────────────────

/** `setTrigger` replaces the whole trigger config. */
export const setTriggerParamsSchema = z.object({
  trigger: triggerConfigSchema,
});
export type SetTriggerParams = z.infer<typeof setTriggerParamsSchema>;

/** `setAgent` points the workflow at an agent (must exist and be published). */
export const setAgentParamsSchema = z.object({
  /** `agents` row id — must exist in the workspace inventory. */
  agentId: z.uuid(),
});
export type SetAgentParams = z.infer<typeof setAgentParamsSchema>;

/** `setInstructions` replaces the workflow's instructions markdown wholesale. */
export const setInstructionsParamsSchema = z.object({
  markdown: z.string().min(1),
});
export type SetInstructionsParams = z.infer<typeof setInstructionsParamsSchema>;

/** Workflow-surface tool schemas — the validation source for its proposals. */
export const workflowCopilotMutationParamSchemas = {
  setTrigger: setTriggerParamsSchema,
  setAgent: setAgentParamsSchema,
  setInstructions: setInstructionsParamsSchema,
} as const;

export type WorkflowCopilotMutationTool =
  keyof typeof workflowCopilotMutationParamSchemas;

export const WORKFLOW_COPILOT_MUTATION_TOOLS = Object.keys(
  workflowCopilotMutationParamSchemas,
) as WorkflowCopilotMutationTool[];

// ── agent-surface mutation tools ─────────────────────────────────────────────

/** `setPersona` replaces the agent's persona markdown wholesale. */
export const setPersonaParamsSchema = z.object({
  markdown: z.string().min(1),
});
export type SetPersonaParams = z.infer<typeof setPersonaParamsSchema>;

/**
 * `setModel` updates the agent's model block. All fields optional so the
 * copilot can change just the reasoning effort or just the preset, but at
 * least one field must be present (an empty setModel is meaningless).
 */
export const setModelParamsSchema = z
  .object({
    preset: modelPresetSlugSchema.optional(),
    /** Specific-model override; must pass the workspace allowlist. */
    modelId: z.string().min(1).optional(),
    /**
     * Reasoning effort. Three-valued on the wire, because the model must be
     * able to say "go back to inheriting" as an ACTION:
     * - absent  → leave the agent's current effort alone
     * - `null`  → clear the override (inherit the preset's effort); applied as
     *   `setReasoning(undefined)` on the draft
     * - a value → set that explicit override
     * `null !== undefined`, so the at-least-one-field refine below still
     * counts an inherit-me proposal as a real edit.
     */
    reasoning: reasoningEffortSchema.nullable().optional(),
  })
  .refine(
    (params) =>
      params.preset !== undefined ||
      params.modelId !== undefined ||
      params.reasoning !== undefined,
    { message: "setModel requires at least one of preset/modelId/reasoning" },
  );
export type SetModelParams = z.infer<typeof setModelParamsSchema>;

/** What an addContext/removeContext id points at. */
export const copilotContextKindSchema = z.enum(["connection", "skill"]);
export type CopilotContextKind = z.infer<typeof copilotContextKindSchema>;

/** `addContext` equips the agent with an existing workspace/user resource. */
export const addContextParamsSchema = z.object({
  kind: copilotContextKindSchema,
  /**
   * `connections.id` or `skills.id` — must exist in the workspace inventory.
   * `connectionIdSchema` (uuid OR `cn_` nanoid) covers both: skill ids are
   * always uuids, which the union's first branch accepts.
   */
  id: connectionIdSchema,
});
export type AddContextParams = z.infer<typeof addContextParamsSchema>;

/** `removeContext` detaches a currently-attached context resource. */
export const removeContextParamsSchema = addContextParamsSchema;
export type RemoveContextParams = AddContextParams;

/**
 * `setName` renames the agent (2026-08-11 spec D7).
 *
 * NOTE this and {@link setDescriptionParamsSchema} are the only agent-surface
 * mutations that edit the `agents` ROW rather than the definition draft — the
 * editor controller applies them to the same in-memory editor state and the
 * PATCH route persists both, so the copilot sees no difference. The schema is
 * literally the route's own {@link agentNameSchema}: a proposal that validates
 * here must be one the PATCH accepts.
 *
 * Duplicate names across a workspace are legal (spec D1 dropped the unique
 * index), so a rename never has to be refused for collision.
 */
export const setNameParamsSchema = z.object({
  name: agentNameSchema,
});
export type SetNameParams = z.infer<typeof setNameParamsSchema>;

/**
 * Max length of a copilot-proposed agent description. DELIBERATELY far below
 * `updateAgentRequest`'s 2000: this is the ONE-LINE summary rendered on agent
 * cards and in the editor header, and a model handed a 2000-char budget writes
 * a paragraph. The stricter bound is the product decision, not a wire limit.
 */
export const COPILOT_MAX_DESCRIPTION_CHARS = 200;

/** `setDescription` sets the agent's one-line description (spec D7). */
export const setDescriptionParamsSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .max(COPILOT_MAX_DESCRIPTION_CHARS)
    // One LINE, enforced rather than trusted — a model that emits a bulleted
    // list here would break the single-line layout everywhere it renders.
    .refine((value) => !/[\r\n]/.test(value), {
      message: "description must be a single line",
    }),
});
export type SetDescriptionParams = z.infer<typeof setDescriptionParamsSchema>;

/** Agent-surface tool schemas — the validation source for its proposals. */
export const agentCopilotMutationParamSchemas = {
  setName: setNameParamsSchema,
  setDescription: setDescriptionParamsSchema,
  setPersona: setPersonaParamsSchema,
  setModel: setModelParamsSchema,
  addContext: addContextParamsSchema,
  removeContext: removeContextParamsSchema,
} as const;

export type AgentCopilotMutationTool =
  keyof typeof agentCopilotMutationParamSchemas;

export const AGENT_COPILOT_MUTATION_TOOLS = Object.keys(
  agentCopilotMutationParamSchemas,
) as AgentCopilotMutationTool[];

// ── combined registry (proposal frames are surface-agnostic) ─────────────────

/** Per-tool zod schemas across both surfaces (tool names never collide). */
export const copilotMutationParamSchemas = {
  ...workflowCopilotMutationParamSchemas,
  ...agentCopilotMutationParamSchemas,
} as const;

export type CopilotMutationTool = keyof typeof copilotMutationParamSchemas;

export const COPILOT_MUTATION_TOOLS = Object.keys(
  copilotMutationParamSchemas,
) as CopilotMutationTool[];

/** Params union keyed by tool (post-parse shapes). */
export type CopilotMutationParams = {
  [T in CopilotMutationTool]: z.infer<(typeof copilotMutationParamSchemas)[T]>;
};

/** A single previewable/appliable draft mutation, validated server-side. */
export type CopilotProposal = {
  [T in CopilotMutationTool]: {
    /** Stable id (the model tool-call id) the client echoes in mutation_result. */
    id: string;
    tool: T;
    params: CopilotMutationParams[T];
    /** Model-provided one-liner shown on the suggestion card. */
    rationale: string;
  };
}[CopilotMutationTool];

export const copilotProposalSchema = z.discriminatedUnion(
  "tool",
  COPILOT_MUTATION_TOOLS.map((tool) =>
    z.object({
      id: z.string().min(1),
      tool: z.literal(tool),
      params: copilotMutationParamSchemas[tool],
      rationale: z.string(),
    }),
  ) as never,
) as z.ZodType<CopilotProposal>;

// ── client → server frames ───────────────────────────────────────────────────

/**
 * Hard bound on the serialized draft a client may send per turn. The draft is
 * interpolated into the model's system prompt, so unbounded drafts would let a
 * client inflate input-token spend on the platform key without limit.
 */
export const COPILOT_MAX_DRAFT_CHARS = 131_072;

export const copilotUserMessageFrameSchema = z.object({
  type: z.literal("user_message"),
  /** Which editor this turn is about — selects the toolset and prompt. */
  surface: copilotSurfaceSchema,
  /**
   * The workflow/agent being edited (per `surface`) — its org must match the
   * socket's workspace.
   */
  entityId: z.uuid(),
  /**
   * The CURRENT draft as the client sees it (the client is the single
   * writer; the server never trusts its own cached copy across turns).
   * Loose object: drafts may be mid-edit / pre-default shapes — but bounded
   * in serialized size (see COPILOT_MAX_DRAFT_CHARS).
   */
  draft: z
    .record(z.string(), z.unknown())
    .refine((draft) => JSON.stringify(draft).length <= COPILOT_MAX_DRAFT_CHARS, {
      message: `draft exceeds ${COPILOT_MAX_DRAFT_CHARS} serialized characters`,
    }),
  message: z.string().min(1).max(8_000),
  /**
   * ALLOW-EDITS (spec D7). A session-scoped toggle, carried per turn rather
   * than held as server session state on purpose: the server never has to
   * reconcile a toggle the user flipped mid-turn, and a reconnect cannot
   * silently resume with the wrong mode. When true the server streams each
   * validated proposal with `autoApplied: true` and CONTINUES ITS TOOL LOOP
   * IMMEDIATELY instead of parking for a `mutation_result`.
   *
   * Default false — a client that omits it gets the accept gate, which is the
   * safe direction for an omission.
   */
  allowEdits: z.boolean().optional(),
});

export const copilotMutationResultFrameSchema = z.object({
  type: z.literal("mutation_result"),
  /** Echoes CopilotProposal.id. */
  proposalId: z.string().min(1),
  outcome: z.enum(["accepted", "rejected"]),
  /** Optional user-facing reason (fed back to the model on rejection). */
  reason: z.string().max(2_000).optional(),
});

export const copilotAbortFrameSchema = z.object({
  type: z.literal("abort"),
});

export const copilotClientFrameSchema = z.discriminatedUnion("type", [
  copilotUserMessageFrameSchema,
  copilotMutationResultFrameSchema,
  copilotAbortFrameSchema,
]);

export type CopilotClientFrame = z.infer<typeof copilotClientFrameSchema>;
export type CopilotMutationOutcome = z.infer<
  typeof copilotMutationResultFrameSchema
>["outcome"];

// ── server → client frames ───────────────────────────────────────────────────

export const COPILOT_ERROR_CODES = [
  /** Frame failed schema validation (client bug). */
  "invalid_frame",
  /** entityId does not resolve to a surface row inside the socket's workspace. */
  "entity_not_found",
  /** A turn is already streaming on this socket. */
  "turn_in_progress",
  /** Per-workspace concurrent copilot session cap reached. */
  "session_limit",
  /** Per-turn OR per-workspace-window token/turn budget exceeded. */
  "over_budget",
  /** Upstream model call failed. */
  "llm_error",
  /** Session/membership no longer valid — the socket is closed after this. */
  "unauthorized",
] as const;

export type CopilotErrorCode = (typeof COPILOT_ERROR_CODES)[number];

/** Assistant token delta (streamed as tokens arrive). */
export interface CopilotDeltaFrame {
  type: "delta";
  text: string;
}

/**
 * Copilot step lifecycle. The three values the server can emit are exactly the
 * chat rail's (`StepState` in apps/web/src/lib/chat/run-view.ts) — no parallel
 * vocabulary. The chat's other states have no copilot analogue:
 * there is no HITL approval here (`awaiting`/`rejected`), and a step left
 * `pending` when a `done` frame lands with `reason: "aborted"` is rendered
 * canceled by the CLIENT, since the server emits nothing further for it.
 */
export const COPILOT_STEP_STATES = ["pending", "ok", "error"] as const;
export type CopilotStepState = (typeof COPILOT_STEP_STATES)[number];

/**
 * Model reasoning/thinking for one block — mirrors the chat's `ThoughtItem`.
 *
 * `text` is CUMULATIVE (eve's `reasoningSoFar` convention), so a dropped frame
 * self-heals on the next one and the client upserts by {@link key} rather than
 * appending. `streaming: false` seals the block; a later frame under the same
 * key is a new block only if the server issues a new key.
 */
export interface CopilotThoughtFrame {
  type: "thought";
  /** Stable per-block key (server convention: `step:<stepIndex>`). */
  key: string;
  text: string;
  streaming: boolean;
}

/**
 * One tool step's progress — mirrors the chat's `ToolItem`. Covers BOTH the
 * copilot's read tools (inventory lookups) and its mutation tools; a mutation
 * step's `proposal` frame carries the previewable payload, this carries only
 * its lifecycle.
 */
export interface CopilotStepFrame {
  type: "step";
  /** The model tool-call id — the upsert key (matches `CopilotProposal.id`). */
  key: string;
  /** Raw tool name; the dock humanizes it for display. */
  toolName: string;
  state: CopilotStepState;
  /** One-line result summary; null while pending and on failures with no body. */
  resultPreview: string | null;
}

/**
 * A validated mutation proposal.
 *
 * With the accept gate (the default) the server PARKS here until the client
 * answers with `mutation_result`. Under allow-edits it does not: `autoApplied`
 * is true, the loop has already continued, and the client applies the mutation
 * and renders the card as already-applied — the card still renders, so the
 * turn remains an audit trail instead of a silent edit. A `mutation_result`
 * for an auto-applied proposal is ignored by the server (there is nothing left
 * to unblock), so a client that cannot apply one must surface that locally.
 */
export interface CopilotProposalFrame {
  type: "proposal";
  proposal: CopilotProposal;
  /** True when the server did not wait for an accept (allow-edits mode). */
  autoApplied?: boolean;
}

/** Turn finished (model stopped calling tools, or the client aborted). */
export interface CopilotDoneFrame {
  type: "done";
  reason: "completed" | "aborted";
  /** Total model output tokens consumed by the turn (when known). */
  outputTokens?: number;
}

export interface CopilotErrorFrame {
  type: "error";
  code: CopilotErrorCode;
  message: string;
}

export type CopilotServerFrame =
  | CopilotDeltaFrame
  | CopilotThoughtFrame
  | CopilotStepFrame
  | CopilotProposalFrame
  | CopilotDoneFrame
  | CopilotErrorFrame;

export const copilotServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("thought"),
    key: z.string().min(1),
    text: z.string(),
    streaming: z.boolean(),
  }),
  z.object({
    type: z.literal("step"),
    key: z.string().min(1),
    toolName: z.string().min(1),
    state: z.enum(COPILOT_STEP_STATES),
    resultPreview: z.string().nullable(),
  }),
  z.object({
    type: z.literal("proposal"),
    proposal: copilotProposalSchema as z.ZodType<CopilotProposal>,
    autoApplied: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("done"),
    reason: z.enum(["completed", "aborted"]),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum(COPILOT_ERROR_CODES),
    message: z.string(),
  }),
]) as z.ZodType<CopilotServerFrame>;

// ── parse helpers ────────────────────────────────────────────────────────────

/** Parse a raw WS payload into a server frame (null on any invalid frame). */
export function parseCopilotServerFrame(raw: unknown): CopilotServerFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const result = copilotServerFrameSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Parse a raw WS payload into a client frame (null on any invalid frame). */
export function parseCopilotClientFrame(raw: unknown): CopilotClientFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const result = copilotClientFrameSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
