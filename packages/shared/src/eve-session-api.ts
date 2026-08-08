/**
 * eve session API **v2** — the ID-addressed HTTP contract of eve@0.31.3.
 *
 * Single source of truth for the wire shapes the control plane speaks to a
 * compiled agent (through the worker's reverse proxy at
 * `/agents/:hash/eve/v1/...`). Cross-checked against the shipped package:
 * `dist/src/public/channels/eve.js` (the route handlers), `dist/src/protocol/
 * {routes,message,cancel-turn,clear-session,compact-session,reset-session}.d.ts`
 * and `dist/src/channel/types.d.ts`.
 *
 * WHAT CHANGED FROM 0.19 (this is a forced migration, not a refactor):
 *
 * 1. **Continuation tokens are gone.** Sessions are addressed by id in the
 *    PATH. eve now runs `rejectSessionContinuationToken()` on EVERY session
 *    route — create, follow-up, cancel, clear, compact, reset — and the check
 *    is `"continuationToken" in body`, NOT a truthiness test. A body carrying
 *    the key with value `undefined` is fine only because `JSON.stringify`
 *    drops it; `{ continuationToken: null }` is a hard 400. Build bodies from
 *    {@link eveSessionFollowUpRequestSchema} and the key can never appear.
 * 2. **Follow-ups are send XOR respond.** `message` and `inputResponses` are
 *    mutually exclusive: both → 400, neither → 400.
 * 3. **`session_not_active`** is the only stable machine-readable error code
 *    on this surface (409 on the follow-up route). It is a SEMANTIC WIDENING
 *    of 0.19's busy 409 — it covers unknown, terminal AND reset sessions, so
 *    it is PERMANENT for that session id. Every other 4xx here carries
 *    `error` but no `code`.
 * 4. **Four control routes** — cancel / clear / compact / reset.
 *
 * ROUTE TABLE (status codes verified in the shipped handler):
 *
 * ```
 * POST /eve/v1/session                    create + first message
 *      202 {ok,sessionId,status:"accepted"}  + x-eve-session-id
 *      (no 409 path; internal failure is 500)
 * POST /eve/v1/session/:id                follow-up — send XOR respond
 *      202 {ok,sessionId,status:"accepted"}  + x-eve-session-id
 *      409 {ok:false,code:"session_not_active",error}
 * POST /eve/v1/session/:id/cancel         optional {turnId}
 *      202 {ok,sessionId,status:"accepted"} | 200 {ok,status:"no_active_turn"}
 * POST /eve/v1/session/:id/clear          optional empty body
 *      202 {ok,sessionId,status:"accepted"} | 200 {ok,status:"no_active_session"}
 * POST /eve/v1/session/:id/compact        optional empty body
 *      202 {ok,sessionId,status:"accepted"} | 200 {ok,status:"no_active_session"}
 * POST /eve/v1/session/:id/reset          optional {reason}
 *      200 {ok,previousSessionId,status:"reset"} | 200 {ok,status:"no_active_session"}
 * GET  /eve/v1/session/:id/stream         ?startIndex=&includeTailIndex=
 *      200 NDJSON | 404 {ok:false,error:"Session not found."}
 * ```
 *
 * TRAPS worth knowing before you write a client:
 * - **reset is the odd one out**: BOTH outcomes are HTTP 200 (never 202), and
 *   its id field is `previousSessionId`, not `sessionId`. The retired id can
 *   never accept another message — a replacement needs a fresh create.
 * - **`no_active_turn` / `no_active_session` do NOT mean "nothing was running"**.
 *   Empirically (spike, 0.31.3) a cancel against a live-but-idle session
 *   answers 202 `accepted`; eve renders ONE condition — a dead session command
 *   hook — as `session_not_active` (send), `no_active_turn` (cancel) and
 *   `no_active_session` (clear/compact/reset). So a 200 here carries the same
 *   terminal meaning as a 409 on send, and 202 never proves a turn was stopped.
 * - **Cancellation is cooperative**, at durable step boundaries: an in-flight
 *   tool call runs to completion and still emits its `action.result`. The turn
 *   then ends with `turn.cancelled` → `session.waiting` — never `turn.failed`.
 * - A cancel posted before `turn.started` is accepted and consumed as a no-op;
 *   it does NOT arm a pending cancellation.
 * - **Compacting an empty/already-cleared context emits no `compaction.*`
 *   events at all** — the 202 is the only reliable acknowledgement.
 * - **There is no `follow` query parameter.** `follow: false` is an
 *   `eve/client` SDK construct; over raw HTTP the opt-in is
 *   `includeTailIndex=1`, and the caller enforces its own bound.
 * - `streamReconnectPolicy: { reconnect: false }` is likewise an `eve/client`
 *   option, not a wire field. The control plane's tailer speaks raw fetch and
 *   already owns cursor recovery, so it has those semantics structurally — but
 *   ANY future `eve/client` usage (spike harnesses, evals) MUST pass it, or
 *   eve's internal reconnect loop contends with ours and double-consumes.
 */
import { z } from "zod";

import type { EveInputResponse } from "./eve-events";

// ── Routes ──────────────────────────────────────────────────────────────────

/** Framework-owned prefix reserved for eve's runtime transport surfaces. */
export const EVE_ROUTE_PREFIX = "/eve/v1";

/** `POST` here to create an ID-addressed session with its first message. */
export const EVE_SESSION_ROUTE_PATH = "/eve/v1/session";

/** eve's health probe (unauthenticated in eve, JWT-gated through our proxy). */
export const EVE_HEALTH_ROUTE_PATH = "/eve/v1/health";

const seg = (sessionId: string): string => encodeURIComponent(sessionId);

/** `POST` a follow-up (send XOR respond) to one exact session. */
export function eveSessionPath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${seg(sessionId)}`;
}

/** `POST` to cancel the in-flight turn of one exact session. */
export function eveSessionCancelPath(sessionId: string): string {
  return `${eveSessionPath(sessionId)}/cancel`;
}

/** `POST` to clear one session's durable model-message history. */
export function eveSessionClearPath(sessionId: string): string {
  return `${eveSessionPath(sessionId)}/clear`;
}

/** `POST` to compact one session's visible history. */
export function eveSessionCompactPath(sessionId: string): string {
  return `${eveSessionPath(sessionId)}/compact`;
}

/** `POST` to retire one exact session id permanently. */
export function eveSessionResetPath(sessionId: string): string {
  return `${eveSessionPath(sessionId)}/reset`;
}

/** `GET` the NDJSON event stream of one session. */
export function eveSessionStreamPath(sessionId: string): string {
  return `${eveSessionPath(sessionId)}/stream`;
}

// ── Headers / stream constants ──────────────────────────────────────────────

/** Set on every create/follow-up response and on the stream response. */
export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
/** Only present when the request asked for it via `includeTailIndex`. */
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";

export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
/** eve@0.31.3 stream version (`meta.id` arrived in 20). */
export const EVE_MESSAGE_STREAM_VERSION = "21";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE =
  "application/x-ndjson; charset=utf-8";

/** `x-eve-stream-tail-index` value for a stream with no events yet. */
export const EVE_EMPTY_STREAM_TAIL_INDEX = -1;

// ── The forbidden key ───────────────────────────────────────────────────────

/**
 * Keys eve rejects with a 400 on EVERY session route, by key PRESENCE.
 * A partial migration that cleans up one path and leaves the key on another
 * fails closed with a body that reads like a malformed request rather than a
 * protocol mismatch — so check bodies, don't assume.
 */
export const EVE_FORBIDDEN_SESSION_BODY_KEYS = ["continuationToken"] as const;

/**
 * Returns the first eve-forbidden key present on `body` (own OR inherited —
 * eve's check is `key in body`), or null. Values are irrelevant: `null` and
 * `undefined` both trip eve's guard once the key survives serialization.
 */
export function forbiddenEveSessionBodyKey(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  for (const key of EVE_FORBIDDEN_SESSION_BODY_KEYS) {
    if (key in body) return key;
  }
  return null;
}

// ── Request bodies ──────────────────────────────────────────────────────────

/**
 * Session mode, chosen at CREATE and fixed for the session's life.
 *
 * - `conversation` (eve's default) — the session can reach a human, so
 *   crossing the input-token budget parks on a `kind: "session-limit"`
 *   Approve/Stop input request.
 * - `task` — no input proxying; a budget crossing fails the next model call
 *   with `SESSION_TOKEN_LIMIT_REACHED` instead of parking forever on a prompt
 *   nobody will answer.
 *
 * eve derives `capabilities` from this when it is not sent explicitly:
 * `capabilities ?? (mode === "task" ? undefined : { requestInput: true })`.
 *
 * THE PLATFORM DELIBERATELY NEVER SENDS THIS. Every dispatch path — chat,
 * webhook, form, Slack, schedule, manual run — lands in a session a user can
 * open in chat and answer, so eve's default (`conversation`, hence
 * `requestInput: true`) is the correct mode for all of them: a budget
 * crossing parks on an answerable `session-limit` request instead of failing
 * the run outright. Modelled here because it is part of eve's request
 * contract, and so a future non-interactive path (an unattended batch job
 * with no chat surface) has the field ready rather than inventing it.
 */
export const eveSessionModeSchema = z.enum(["conversation", "task"]);
export type EveSessionMode = z.infer<typeof eveSessionModeSchema>;

export const eveSessionCapabilitiesSchema = z.strictObject({
  /** Whether the session may raise HITL input requests. */
  requestInput: z.boolean().optional(),
});
export type EveSessionCapabilities = z.infer<
  typeof eveSessionCapabilitiesSchema
>;

/**
 * `POST /eve/v1/session` body. `inputResponses` is a hard 400 here — it is
 * only accepted for an existing session. `message` must be non-empty.
 *
 * (eve also accepts `clientContext`, `outputSchema`, `callback` and
 * `forwardedPrincipal`; the platform sends none of them, and `strictObject`
 * keeps it that way until someone deliberately widens this contract.)
 */
export const eveCreateSessionRequestSchema = z.strictObject({
  message: z.string().min(1),
  mode: eveSessionModeSchema.optional(),
  capabilities: eveSessionCapabilitiesSchema.optional(),
});
export type EveCreateSessionRequest = z.infer<
  typeof eveCreateSessionRequestSchema
>;

/** One HITL answer, exactly as eve's `inputResponseSchema` declares it. */
export const eveInputResponseSchema = z.strictObject({
  requestId: z.string().min(1),
  optionId: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});

/** Follow-up, "send" form: continue the session with a user message. */
export const eveSessionSendRequestSchema = z.strictObject({
  message: z.string().min(1),
});

/** Follow-up, "respond" form: answer parked HITL input requests. */
export const eveSessionRespondRequestSchema = z.strictObject({
  inputResponses: z.array(eveInputResponseSchema).min(1),
});

/**
 * `POST /eve/v1/session/:sessionId` body — send XOR respond, enforced.
 *
 * Both arms are strict, so a body carrying BOTH keys (or a stray
 * `continuationToken`) fails here instead of at eve's 400.
 */
export const eveSessionFollowUpRequestSchema = z.union([
  eveSessionSendRequestSchema,
  eveSessionRespondRequestSchema,
]);

/**
 * The illegal state is unrepresentable: `?: never` means a literal can carry
 * `message` or `inputResponses`, never both, mirroring eve's own
 * `HandleMessageRequestBody`.
 */
export type EveSessionFollowUpRequest =
  | { readonly message: string; readonly inputResponses?: never }
  | {
      readonly inputResponses: readonly EveInputResponse[];
      readonly message?: never;
    };

// Compile-time guard: schema output must satisfy the declared contract. (Only
// one direction — the schema infers a MUTABLE array, which is assignable to
// the readonly contract but not the reverse.)
type _FollowUpLockstep = z.infer<
  typeof eveSessionFollowUpRequestSchema
> extends EveSessionFollowUpRequest
  ? true
  : never;
const _followUpLockstep: _FollowUpLockstep = true;
void _followUpLockstep;

/** Narrows a follow-up body to its "respond" arm. */
export function isEveRespondRequest(
  request: EveSessionFollowUpRequest,
): request is Extract<
  EveSessionFollowUpRequest,
  { inputResponses: readonly EveInputResponse[] }
> {
  return request.inputResponses !== undefined;
}

/**
 * `POST .../cancel` body (optional). Scoping with `turnId` is safe: a turnId
 * naming any other turn is accepted and consumed as a no-op, so a guarded
 * cancel racing a turn boundary cannot stop a turn the user never saw.
 */
export const eveCancelTurnRequestSchema = z.strictObject({
  turnId: z.string().min(1).optional(),
});
export type EveCancelTurnRequest = z.infer<typeof eveCancelTurnRequestSchema>;

/** `POST .../reset` body (optional). Audit note only. */
export const eveResetSessionRequestSchema = z.strictObject({
  reason: z.string().min(1).optional(),
});
export type EveResetSessionRequest = z.infer<
  typeof eveResetSessionRequestSchema
>;

// ── Response bodies ─────────────────────────────────────────────────────────

/** 202 body of create AND of an accepted follow-up. */
export const eveSessionAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  status: z.literal("accepted"),
});
export type EveSessionAcceptedResponse = z.infer<
  typeof eveSessionAcceptedResponseSchema
>;

/** `POST .../cancel` — 202 accepted / 200 no_active_turn. Both are success. */
export const eveCancelTurnResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.object({ ok: z.literal(true), status: z.literal("no_active_turn") }),
]);
export type EveCancelTurnResponse = z.infer<typeof eveCancelTurnResponseSchema>;

/** `POST .../clear` — 202 accepted / 200 no_active_session. */
export const eveClearSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.object({ ok: z.literal(true), status: z.literal("no_active_session") }),
]);
export type EveClearSessionResponse = z.infer<
  typeof eveClearSessionResponseSchema
>;

/** `POST .../compact` — structurally identical to clear. */
export const eveCompactSessionResponseSchema = eveClearSessionResponseSchema;
export type EveCompactSessionResponse = EveClearSessionResponse;

/**
 * `POST .../reset` — ALWAYS HTTP 200, and the id field is
 * `previousSessionId`. The retired id is permanently unusable.
 */
export const eveResetSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    previousSessionId: z.string().min(1),
    status: z.literal("reset"),
  }),
  z.object({ ok: z.literal(true), status: z.literal("no_active_session") }),
]);
export type EveResetSessionResponse = z.infer<
  typeof eveResetSessionResponseSchema
>;

/**
 * Non-2xx body. `code` is present ONLY on the 409 `session_not_active`; every
 * 400/404 carries `error` alone, and 500s add an `errorId`.
 */
export const eveSessionErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  errorId: z.string().optional(),
});
export type EveSessionErrorBody = z.infer<typeof eveSessionErrorBodySchema>;

// ── Error semantics ─────────────────────────────────────────────────────────

/**
 * eve's only stable machine-readable session error code (409 on the follow-up
 * route). PERMANENT for that session id: unknown, terminal and reset sessions
 * all answer it, so the recovery is "release the claim and start a new
 * session", never "wait and retry".
 *
 * Distinct from the PLATFORM's own `session_busy` (one run per session at a
 * time), which is transient. Do not collapse the two.
 */
export const EVE_SESSION_NOT_ACTIVE_CODE = "session_not_active";

/** HTTP status of an accepted async command. */
export const EVE_SESSION_ACCEPTED_STATUS = 202;
/** HTTP status carrying {@link EVE_SESSION_NOT_ACTIVE_CODE}. */
export const EVE_SESSION_NOT_ACTIVE_STATUS = 409;

/**
 * True when a follow-up response is eve's terminal-session 409.
 *
 * MUST be checked on `status` AND `code` together — never on 409 alone: the
 * eve client's default `retryableErrorStatuses` treats 404/409 as retryable on
 * STREAM OPEN, so a 409 seen while opening a stream is not this condition.
 */
export function isEveSessionNotActive(
  status: number,
  body: unknown,
): body is EveSessionErrorBody {
  if (status !== EVE_SESSION_NOT_ACTIVE_STATUS) return false;
  const parsed = eveSessionErrorBodySchema.safeParse(body);
  return parsed.success && parsed.data.code === EVE_SESSION_NOT_ACTIVE_CODE;
}

// ── Stream query / tail index ───────────────────────────────────────────────

/**
 * Query parameters of `GET /eve/v1/session/:id/stream` — the ONLY two eve
 * parses. Anything else (notably `follow`) is silently ignored.
 */
export interface EveStreamQuery {
  /**
   * Absolute event count to resume from. Non-negative = absolute; negative =
   * tail-relative (`-1` = the latest event). Omitted/0 = from the beginning.
   */
  readonly startIndex?: number;
  /**
   * Opt in to the {@link EVE_STREAM_TAIL_INDEX_HEADER} response header for a
   * BOUNDED catch-up read. Request it only on the FIRST open of such a read —
   * re-requesting it on every reconnect re-pins the bound and turns the read
   * into a moving target that never terminates.
   */
  readonly includeTailIndex?: boolean;
}

/** Builds the stream query string (`""` when nothing needs to be sent). */
export function eveStreamQueryString(query: EveStreamQuery = {}): string {
  const params = new URLSearchParams();
  if (query.startIndex !== undefined && query.startIndex !== 0) {
    params.set("startIndex", String(query.startIndex));
  }
  if (query.includeTailIndex === true) params.set("includeTailIndex", "1");
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * Parses the `x-eve-stream-tail-index` response header — the zero-based index
 * of the last durably recorded event, or {@link EVE_EMPTY_STREAM_TAIL_INDEX}
 * (-1) when the stream is empty.
 *
 * Returns null when the header is ABSENT or unparseable; callers must
 * distinguish that (fall back to their own cursor) from `-1` (a real, empty
 * stream — a cursor of 0 is already past it, so return without yielding
 * rather than looping).
 */
export function parseEveStreamTailIndex(
  value: string | null | undefined,
): number | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
