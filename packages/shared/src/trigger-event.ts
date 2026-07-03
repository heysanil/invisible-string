/**
 * TriggerEvent — the ONE normalized trigger envelope (INITIAL-SPEC.md §8).
 *
 * Every trigger type is pluggable behind this shape:
 * - Control-plane trigger ADAPTERS (form, webhook, slack, …) convert raw
 *   inbound platform events into a `TriggerEvent`. Raw platform parsing lives
 *   ONLY in adapters, never in compiled agents.
 * - The dispatcher POSTs the envelope (platform-JWT authenticated) to the
 *   compiled agent's matching trigger channel, authored under
 *   `/eve/v1/platform/<trigger>` (locked route convention — spike/REPORT.md
 *   finding 7; rides the proxy's forwarded `/eve/` prefix).
 * - Instruction `@trigger.*` references resolve against `data` at dispatch
 *   time (see `parseReferences` in workflow-definition.ts).
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

/** The normalized trigger envelope, exactly per INITIAL-SPEC.md §8. */
export const triggerEventSchema = z.object({
  workflowId: z.string().min(1),
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
   * Extra blocks injected before the model sees `message`. NOT a `send()`
   * option (PLAN correction 2): the eve channel injects these via its
   * `onMessage` hook (`return { auth, context: [...] }`); custom trigger
   * channels fold them into the message content.
   */
  context: z.array(z.string()).optional(),
});

export interface TriggerEvent {
  workflowId: string;
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
