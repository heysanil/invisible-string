/**
 * TriggerEvent — the ONE normalized trigger envelope, persisted on
 * `runs.trigger_event` as a STORAGE/PROVENANCE record. It is NEVER sent to
 * agents: compiled agents expose only eve's default channel, and what they
 * receive is the rendered task message (`renderTaskMessage` in render.ts).
 *
 * Every trigger type is pluggable behind this shape:
 * - Control-plane trigger ADAPTERS (form, webhook, slack, …) convert raw
 *   inbound platform events into a `TriggerEvent`. Raw platform parsing lives
 *   ONLY in adapters, never anywhere downstream.
 * - The dispatcher renders the workflow's instructions against this
 *   envelope's `message`/`data`/`context` (instruction `@trigger.*` refs
 *   resolve against `data` — `parseReferences` in workflow-config.ts), sends
 *   THAT string to the agent's eve session, and stores the envelope on the
 *   run row for audit/provenance.
 */
import { z } from "zod";

/**
 * Trigger types with first-class adapters/config today. `TriggerEvent`
 * deliberately accepts ANY non-empty string (spec §8: `"manual" | "form" |
 * "webhook" | "slack" | string`) so new adapters need no schema change.
 */
export const KNOWN_TRIGGER_TYPES = [
  "manual",
  "form",
  "webhook",
  "slack",
  "schedule",
] as const;

export type KnownTriggerType = (typeof KNOWN_TRIGGER_TYPES)[number];

/** Open union: known types keep autocomplete, unknown strings stay valid. */
export type TriggerType = KnownTriggerType | (string & {});

/**
 * Size cap for INLINE (base64) file payloads on a TriggerEvent, in DECODED
 * bytes. Enforced at ingress (`/t/:token`, Slack events, chat uploads):
 * anything larger must be uploaded to object storage and passed by URL
 * instead. Spec §8: "inline base64 for small payloads; object-store URL
 * otherwise. Enforce size caps at ingress."
 */
export const TRIGGER_EVENT_INLINE_FILE_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Decoded byte length of a base64 string (padded or unpadded) WITHOUT
 * decoding it — ingress uses this to enforce
 * {@link TRIGGER_EVENT_INLINE_FILE_MAX_BYTES} cheaply.
 */
export function base64DecodedByteLength(base64: string): number {
  const trimmed = base64.trim();
  if (trimmed.length === 0) return 0;
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/**
 * Who/what triggered the run. Identity/audit ONLY — credential resolution
 * uses the workflow's `run_as` user, NOT the principal (spec §2 locked).
 */
export const triggerPrincipalSchema = z.object({
  /** Workspace = Better Auth organization id. */
  workspaceId: z.string().min(1),
  /** Platform user id when the principal is a known user (chat, form, …). */
  userId: z.string().min(1).optional(),
  /** Free-form origin descriptor, e.g. "chat", "slack:U12345", "webhook". */
  source: z.string().min(1),
});

export type TriggerPrincipal = z.infer<typeof triggerPrincipalSchema>;

/**
 * One file attached to a trigger event. `data` is inline base64 for small
 * payloads (≤ {@link TRIGGER_EVENT_INLINE_FILE_MAX_BYTES} decoded bytes) or
 * an object-store URL otherwise. `URL` instances only survive in-process —
 * over the wire they serialize to strings.
 */
export const triggerFileSchema = z.object({
  name: z.string().min(1),
  mediaType: z.string().min(1),
  data: z.union([z.string().min(1), z.instanceof(URL)]),
});

export type TriggerFile = z.infer<typeof triggerFileSchema>;

/** The normalized trigger envelope (spec §8 shape, agents-first keys). */
export const triggerEventSchema = z.object({
  /** Agent whose published version handled the run. */
  agentId: z.uuid(),
  /** Workflow that delegated the run; null for direct chat sessions. */
  workflowId: z.uuid().nullable(),
  /** Open string union — see {@link TriggerType}. */
  triggerType: z.string().min(1),
  /** Model-facing prompt / primary input. */
  message: z.string(),
  /** Structured fields that `@trigger.*` references resolve against. */
  data: z.record(z.string(), z.unknown()),
  files: z.array(triggerFileSchema).optional(),
  principal: triggerPrincipalSchema,
  /** Maps conversational/threaded triggers onto an existing agent session. */
  continuationToken: z.string().min(1).optional(),
  /**
   * Extra platform context blocks. `renderTaskMessage` folds them into the
   * task message's `<trigger-context>` block after the resolved trigger
   * values.
   */
  context: z.array(z.string()).optional(),
});

export interface TriggerEvent {
  agentId: string;
  workflowId: string | null;
  triggerType: TriggerType;
  message: string;
  data: Record<string, unknown>;
  files?: TriggerFile[];
  principal: TriggerPrincipal;
  continuationToken?: string;
  context?: string[];
}

// Compile-time guard: the hand-written interface (kept for the `TriggerType`
// alias + doc comments) must stay mutually assignable with the zod schema.
type _SchemaToType = z.infer<typeof triggerEventSchema> extends TriggerEvent
  ? true
  : never;
type _TypeToSchema = TriggerEvent extends z.infer<typeof triggerEventSchema>
  ? true
  : never;
const _triggerEventShapeCheck: [_SchemaToType, _TypeToSchema] = [true, true];
void _triggerEventShapeCheck;
