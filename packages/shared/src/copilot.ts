/**
 * Copilot WS protocol (spec §12) — typed frames exchanged over
 * `WS /workspaces/:workspaceId/copilot?workflowId=…`.
 *
 * The copilot NEVER mutates the draft server-side: it streams assistant
 * prose plus structured {@link CopilotMutation} suggestions; the CLIENT
 * applies accepted mutations through the builder controller (single
 * writer) and reports the decision back with `suggestion_decision`.
 */
import { z } from "zod";

import {
  modelPresetSlugSchema,
  triggerConfigSchema,
  workflowDefinitionSchema,
} from "./workflow-definition";

// ── Mutations ────────────────────────────────────────────────────────────────

export const copilotContextKindSchema = z.enum(["connection", "skill"]);
export type CopilotContextKind = z.infer<typeof copilotContextKindSchema>;

/** Typed draft edits the copilot may propose — nothing else is applyable. */
export const copilotMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setTrigger"), trigger: triggerConfigSchema }),
  z.object({
    kind: z.literal("addContext"),
    contextKind: copilotContextKindSchema,
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("removeContext"),
    contextKind: copilotContextKindSchema,
    id: z.string().min(1),
  }),
  z.object({ kind: z.literal("setAgent"), agentPresetId: z.string().min(1) }),
  z.object({
    kind: z.literal("setModelPreset"),
    preset: modelPresetSlugSchema.nullable(),
  }),
  z.object({ kind: z.literal("setInstructions"), markdown: z.string() }),
]);
export type CopilotMutation = z.infer<typeof copilotMutationSchema>;

export const copilotSuggestionSchema = z.object({
  id: z.string().min(1),
  mutation: copilotMutationSchema,
  /** One-line human rationale rendered under the card title. */
  rationale: z.string(),
});
export type CopilotSuggestion = z.infer<typeof copilotSuggestionSchema>;

// ── Client → server frames ───────────────────────────────────────────────────

export const copilotClientFrameSchema = z.discriminatedUnion("type", [
  /** Sent on every (re)connect so the server can (re)build its context. */
  z.object({
    type: z.literal("client_hello"),
    workflowId: z.string().min(1),
    draft: workflowDefinitionSchema,
  }),
  z.object({
    type: z.literal("user_message"),
    text: z.string().min(1),
    /** Current draft — the copilot always reasons over the live definition. */
    draft: workflowDefinitionSchema,
  }),
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("suggestion_decision"),
    suggestionId: z.string().min(1),
    decision: z.enum(["accepted", "rejected"]),
  }),
]);
export type CopilotClientFrame = z.infer<typeof copilotClientFrameSchema>;

// ── Server → client frames ───────────────────────────────────────────────────

export const copilotServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assistant_delta"),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  z.object({ type: z.literal("assistant_done"), messageId: z.string().min(1) }),
  z.object({
    type: z.literal("suggestion"),
    suggestion: copilotSuggestionSchema,
  }),
  z.object({ type: z.literal("copilot_error"), message: z.string() }),
]);
export type CopilotServerFrame = z.infer<typeof copilotServerFrameSchema>;

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
