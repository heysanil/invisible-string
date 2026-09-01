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
 *   inventing a second one. The dock upserts those items by key GLOBALLY, so
 *   every `thought`/`step` key must be unique for the whole SOCKET, not merely
 *   within a turn — see {@link CopilotThoughtFrame}.
 * - Each `user_message` names its `surface` ("workflow" | "agent"); the
 *   server exposes the matching toolset — proposals for the other surface's
 *   tools are a server bug. The workflow surface additionally exposes a READ
 *   toolset ({@link workflowCopilotReadParamSchemas}) the server executes
 *   inline — pure inventory lookups that emit `step` frames only, never
 *   proposals.
 * - AGENT IDENTITY rides BESIDE the draft, never inside it (spec D7.3/D7.4):
 *   `agents.name`/`agents.description` are row columns, not part of the
 *   `AgentDefinition` a client serializes as `draft`, so the frame carries
 *   them in its own typed {@link copilotAgentIdentitySchema} field — see it
 *   for the precedence rule against the persisted row.
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
import {
  newStepId,
  pipelineStepSchema,
  STEP_ID_PATTERN,
} from "./pipeline-config";
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

/** A minted `st_` step id naming an EXISTING step in the client's draft. */
const stepIdParamSchema = z
  .string()
  .regex(STEP_ID_PATTERN, "expected a minted st_ step id");

/**
 * Where a step lands in the tree (addStep/moveStep).
 *
 * - `after` — the sibling to insert after; `null` = the head of the target
 *   list.
 * - `parent` absent — the top-level `steps` list.
 * - `parent.slot` — `body` (a for_each's steps), `then` (a branch lane) or
 *   `else` (its else list). Slots use {@link StepWalkEntry}'s vocabulary. A
 *   branch may have several `then` lanes; the LANE is resolved from `after`
 *   (which lane that sibling lives in), and `after: null` with `slot: "then"`
 *   targets the FIRST lane — validate.ts owns that resolution, plus rejecting
 *   a slot the parent kind does not have.
 */
export const stepPositionSchema = z.object({
  after: stepIdParamSchema.nullable(),
  parent: z
    .object({
      stepId: stepIdParamSchema,
      slot: z.enum(["body", "then", "else"]),
    })
    .optional(),
});
export type StepPosition = z.infer<typeof stepPositionSchema>;

/**
 * `addStep` inserts a NEW step at `position`.
 *
 * STEP IDS ARE MINTED SERVER-SIDE, NEVER MODEL-SUPPLIED (the model is told
 * "never invent stepIds"): `pipelineStepSchema` requires a shaped `st_` id on
 * every node, so validate.ts runs {@link mintStepIds} over the RAW tool-call
 * args before parsing them against this schema. A proposal that reaches a
 * client therefore always carries minted, tree-unique ids and is directly
 * applicable to the draft.
 */
export const addStepParamsSchema = z.object({
  step: pipelineStepSchema,
  position: stepPositionSchema,
});
export type AddStepParams = z.infer<typeof addStepParamsSchema>;

/**
 * `updateStep` replaces the WHOLE step named by `stepId` (no partial
 * patches — the model re-emits the step, keeping any nested ids it wants to
 * preserve). validate.ts forces `step.id === stepId` after minting (see
 * {@link addStepParamsSchema}) — a replacement can rename a slug but never
 * re-identify a step.
 */
export const updateStepParamsSchema = z.object({
  stepId: stepIdParamSchema,
  step: pipelineStepSchema,
});
export type UpdateStepParams = z.infer<typeof updateStepParamsSchema>;

/** `removeStep` deletes the step (and, for containers, its whole subtree). */
export const removeStepParamsSchema = z.object({
  stepId: stepIdParamSchema,
});
export type RemoveStepParams = z.infer<typeof removeStepParamsSchema>;

/** `moveStep` relocates an existing step (subtree and all) to `position`. */
export const moveStepParamsSchema = z.object({
  stepId: stepIdParamSchema,
  position: stepPositionSchema,
});
export type MoveStepParams = z.infer<typeof moveStepParamsSchema>;

/**
 * Workflow-surface tool schemas — the validation source for its proposals.
 * Granular by design (pipelines redesign): a whole-pipeline `setPipeline`
 * was rejected as unreviewable, and the memo-era `setAgent`/`setInstructions`
 * retired with the memo editor — agents now bind per `agent` STEP.
 */
export const workflowCopilotMutationParamSchemas = {
  setTrigger: setTriggerParamsSchema,
  addStep: addStepParamsSchema,
  updateStep: updateStepParamsSchema,
  removeStep: removeStepParamsSchema,
  moveStep: moveStepParamsSchema,
} as const;

export type WorkflowCopilotMutationTool =
  keyof typeof workflowCopilotMutationParamSchemas;

export const WORKFLOW_COPILOT_MUTATION_TOOLS = Object.keys(
  workflowCopilotMutationParamSchemas,
) as WorkflowCopilotMutationTool[];

// ── workflow-surface read tools ──────────────────────────────────────────────
//
// Server-executed INLINE (pure inventory lookups over connections +
// tools_cache): no proposal park, no client round-trip — progress rides the
// existing `step` frames, whose docstring already covers read tools. The
// system prompt's hard rule ("call searchConnectionTools before proposing a
// tool step — never invent tool names") is what these exist to satisfy.

/**
 * `searchConnectionTools` finds MCP tools across the workspace's enabled
 * connections (cached `tools_cache` lookup — never a live server call). An
 * EMPTY query with a `connectionId` browses that connection's whole tool list.
 */
export const searchConnectionToolsParamsSchema = z.object({
  query: z.string().max(200),
  /** Restrict to one connection; absent = search every enabled connection. */
  connectionId: connectionIdSchema.optional(),
});
export type SearchConnectionToolsParams = z.infer<
  typeof searchConnectionToolsParamsSchema
>;

/**
 * `getConnectionTool` returns one cached tool's detail (description + the
 * trimmed `inputSchema` when the probe cached one) — what the model needs to
 * shape a tool step's `args` without guessing parameter names.
 */
export const getConnectionToolParamsSchema = z.object({
  connectionId: connectionIdSchema,
  toolName: z.string().min(1),
});
export type GetConnectionToolParams = z.infer<
  typeof getConnectionToolParamsSchema
>;

/** Workflow-surface READ tool schemas (executed inline, no proposals). */
export const workflowCopilotReadParamSchemas = {
  searchConnectionTools: searchConnectionToolsParamsSchema,
  getConnectionTool: getConnectionToolParamsSchema,
} as const;

export type WorkflowCopilotReadTool =
  keyof typeof workflowCopilotReadParamSchemas;

export const WORKFLOW_COPILOT_READ_TOOLS = Object.keys(
  workflowCopilotReadParamSchemas,
) as WorkflowCopilotReadTool[];

/** Params union for the read tools, keyed by tool (post-parse shapes). */
export type WorkflowCopilotReadParams = {
  [T in WorkflowCopilotReadTool]: z.infer<
    (typeof workflowCopilotReadParamSchemas)[T]
  >;
};

// ── step-id minting (the validate.ts pre-parse walk) ─────────────────────────

/**
 * Deep-copy a RAW candidate step (an addStep/updateStep tool-call arg,
 * pre-parse), minting an `st_` id on every step-shaped node whose `id` is
 * missing, malformed, or a duplicate of one already seen in this walk. The
 * walk mirrors the tree shape exactly — `for_each.steps`, `branch.branches[n]
 * .steps`, `branch.else` — and touches nothing else (args, conditions, and
 * unknown keys pass through untouched), so a value that would not parse still
 * would not: this only ever REPAIRS ids.
 *
 * validate.ts calls this before parsing against
 * {@link workflowCopilotMutationParamSchemas}; ids against the EXISTING draft
 * (unknown stepId, an id collision with a step outside this subtree) remain
 * its semantic checks — a pure function over one subtree cannot see the
 * draft.
 */
export function mintStepIds(value: unknown, seen?: Set<string>): unknown {
  const seenIds = seen ?? new Set<string>();
  const visit = (node: unknown): unknown => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return node;
    }
    const step = node as Record<string, unknown>;
    const out: Record<string, unknown> = { ...step };
    const id = out.id;
    if (
      typeof id !== "string" ||
      !STEP_ID_PATTERN.test(id) ||
      seenIds.has(id)
    ) {
      out.id = newStepId();
    }
    seenIds.add(out.id as string);
    if (step.kind === "for_each" && Array.isArray(step.steps)) {
      out.steps = step.steps.map(visit);
    } else if (step.kind === "branch") {
      if (Array.isArray(step.branches)) {
        out.branches = step.branches.map((branch) => {
          if (
            branch === null ||
            typeof branch !== "object" ||
            Array.isArray(branch)
          ) {
            return branch;
          }
          const lane = branch as Record<string, unknown>;
          return Array.isArray(lane.steps)
            ? { ...lane, steps: lane.steps.map(visit) }
            : lane;
        });
      }
      if (Array.isArray(step.else)) {
        out.else = step.else.map(visit);
      }
    }
    return out;
  };
  return visit(value);
}

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

/** Bounds on the identity strings interpolated into the system prompt. */
export const COPILOT_MAX_IDENTITY_NAME_CHARS = 120;
export const COPILOT_MAX_IDENTITY_DESCRIPTION_CHARS = 2_000;

/**
 * The agent's IDENTITY as the EDITOR currently holds it (spec D7.3/D7.4).
 *
 * `agents.name` and `agents.description` are columns on the `agents` ROW; the
 * `draft` a client sends is an `AgentDefinition`, which has neither. Without
 * this field the copilot is blind to what the agent is called — it cannot
 * answer "what is this agent named?", and the server's "you already proposed
 * exactly this name" checks (validate.ts) can never fire because their
 * baseline is always absent. So identity travels alongside the draft, in its
 * own typed field, rather than being smuggled into the loose draft record.
 *
 * Both bounds are deliberately the ROW's, not the copilot's:
 * `COPILOT_MAX_DESCRIPTION_CHARS` (200) is what the copilot may PROPOSE, while
 * an existing description may be up to the DTO's 2000 and must still be
 * describable to the model.
 *
 * Deliberately permissive where the PATCH schemas are strict — an empty name
 * is a legal MID-EDIT state and must not fail the whole frame; the server
 * reads a blank name as "no identity to state" rather than as a value.
 *
 * PRECEDENCE (server contract): this field WINS over the persisted row. The
 * editor is the single writer and holds edits the database has not seen yet
 * (the description is reducer state until the user saves). When it is absent —
 * the workflow surface, or a client that does not send it — the server falls
 * back to the `agents` row it already loads with the turn's inventory, so the
 * copilot is never blind about the agent named by `entityId`.
 */
export const copilotAgentIdentitySchema = z.object({
  name: z.string().max(COPILOT_MAX_IDENTITY_NAME_CHARS),
  /** `null` = the agent genuinely has no description (a real state). */
  description: z
    .string()
    .max(COPILOT_MAX_IDENTITY_DESCRIPTION_CHARS)
    .nullable(),
});
export type CopilotAgentIdentity = z.infer<typeof copilotAgentIdentitySchema>;

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
   * AGENT-SURFACE identity (spec D7.3/D7.4) — see
   * {@link copilotAgentIdentitySchema} for what it is and why it is not part
   * of `draft`. Optional: the workflow surface has no identity to send, and an
   * omission falls back to the persisted row rather than blinding the model.
   */
  identity: copilotAgentIdentitySchema.optional(),
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
  /**
   * Stable per-block key — server convention `turn:<turnIndex>:step:<stepIndex>`.
   *
   * It MUST be unique for the LIFETIME OF THE SOCKET, not just within a turn:
   * the dock upserts timeline items by key globally (thread.ts), so a key
   * reused on the next turn would overwrite the first turn's thought inside
   * its old work block instead of opening a new one beside the new answer —
   * silently rewriting history the D7 audit trail exists to keep. The turn
   * index is what carries that uniqueness; the step index alone restarts at
   * zero every turn. Opaque to the client: it never parses this.
   */
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
