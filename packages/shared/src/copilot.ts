/**
 * Copilot WS protocol (spec §12, PLAN Phase 4) — typed frames exchanged over
 * `WS /workspaces/:workspaceId/copilot` between the builder's docked copilot
 * rail and the control plane, plus the per-tool mutation param schemas.
 *
 * Contract highlights:
 * - The copilot NEVER mutates the draft server-side. Every edit is a
 *   structured **proposal** `{id, tool, params, rationale}` streamed to the
 *   client; the client previews it and applies accepted mutations through the
 *   builder controller (single writer), then reports the outcome back with a
 *   `mutation_result` frame so the model's tool loop can continue.
 * - Mutation param schemas mirror `workflow-definition.ts` exactly — a
 *   proposal that parses here is directly applicable to the draft.
 */
import { z } from "zod";

import {
  modelPresetSlugSchema,
  reasoningEffortSchema,
  triggerConfigSchema,
} from "./workflow-definition";

// ── mutation tools ───────────────────────────────────────────────────────────

/** What an addContext/removeContext id points at. */
export const copilotContextKindSchema = z.enum(["connection", "skill"]);
export type CopilotContextKind = z.infer<typeof copilotContextKindSchema>;

/** `setTrigger` replaces the whole TRIGGER pillar with a full trigger config. */
export const setTriggerParamsSchema = z.object({
  trigger: triggerConfigSchema,
});
export type SetTriggerParams = z.infer<typeof setTriggerParamsSchema>;

/** `addContext` attaches an existing workspace/user resource to the CONTEXT pillar. */
export const addContextParamsSchema = z.object({
  kind: copilotContextKindSchema,
  /** `mcp_connections.id` or `skills.id` — must exist in the workspace inventory. */
  id: z.uuid(),
});
export type AddContextParams = z.infer<typeof addContextParamsSchema>;

/** `removeContext` detaches a currently-attached context resource. */
export const removeContextParamsSchema = addContextParamsSchema;
export type RemoveContextParams = AddContextParams;

/**
 * `setAgent` updates the AGENT pillar. All fields optional so the copilot can
 * change just the reasoning effort or just the preset, but at least one field
 * must be present (an empty setAgent is meaningless).
 */
export const setAgentParamsSchema = z
  .object({
    /** `agents` row id — must exist in the workspace inventory. */
    agentPresetId: z.uuid().optional(),
    reasoning: reasoningEffortSchema.optional(),
    /** Specific-model override; must pass the workspace allowlist. */
    modelId: z.string().min(1).optional(),
  })
  .refine(
    (params) =>
      params.agentPresetId !== undefined ||
      params.reasoning !== undefined ||
      params.modelId !== undefined,
    { message: "setAgent requires at least one of agentPresetId/reasoning/modelId" },
  );
export type SetAgentParams = z.infer<typeof setAgentParamsSchema>;

/** `setModelPreset` re-points the AGENT pillar's model preset override. */
export const setModelPresetParamsSchema = z.object({
  slug: modelPresetSlugSchema,
});
export type SetModelPresetParams = z.infer<typeof setModelPresetParamsSchema>;

/** `setInstructions` replaces the INSTRUCTIONS pillar markdown wholesale. */
export const setInstructionsParamsSchema = z.object({
  markdown: z.string().min(1),
});
export type SetInstructionsParams = z.infer<typeof setInstructionsParamsSchema>;

/** Per-tool zod schemas — the single validation source for proposals. */
export const copilotMutationParamSchemas = {
  setTrigger: setTriggerParamsSchema,
  addContext: addContextParamsSchema,
  removeContext: removeContextParamsSchema,
  setAgent: setAgentParamsSchema,
  setModelPreset: setModelPresetParamsSchema,
  setInstructions: setInstructionsParamsSchema,
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
  /** Workflow being edited — its org must match the socket's workspace. */
  workflowId: z.uuid(),
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
  /** workflowId does not resolve inside the socket's workspace. */
  "workflow_not_found",
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

/** A validated mutation proposal awaiting client accept/reject. */
export interface CopilotProposalFrame {
  type: "proposal";
  proposal: CopilotProposal;
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
  | CopilotProposalFrame
  | CopilotDoneFrame
  | CopilotErrorFrame;

export const copilotServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("proposal"),
    proposal: copilotProposalSchema as z.ZodType<CopilotProposal>,
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
