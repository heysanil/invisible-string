/**
 * eve NDJSON session-stream event inventory — FROZEN for eve@0.31.3.
 *
 * README / provenance
 * -------------------
 * Re-captured during the 0.31 upgrade gate (2026-08-07/08) from a self-hosted
 * `eve build` agent running eve@0.31.3 with
 * `@workflow/world-postgres@5.0.0-beta.32` behind the spike reverse proxy.
 * Raw captures live in `spike/tests/fixtures/*.ndjson` (every committed line
 * carries `meta.id`, and every capture reports `eveVersion: "0.31.3"`). Type
 * shapes were cross-checked against eve@0.31.3's own
 * `dist/src/protocol/message.d.ts` (the authoritative wire contract; stream
 * version header `x-eve-stream-version: 21`) and
 * `dist/src/runtime/input/types.d.ts` (HITL request/response).
 *
 * LIVE-OBSERVED on 0.31.3 (see {@link LIVE_OBSERVED_EVE_EVENT_TYPES} and the
 * committed fixtures):
 *   session.started, turn.started, message.received, step.started,
 *   actions.requested, input.requested, action.result, message.appended,
 *   message.completed, step.completed, step.failed, turn.completed,
 *   turn.failed, turn.cancelled, session.waiting
 *
 * ALSO OBSERVED during the spike's control-route test (clear/compact drive
 * them) but not committed to a fixture: `context.cleared`,
 * `compaction.requested`. NOTE compacting an empty/already-cleared context
 * emits NO `compaction.*` events at all — only `session.waiting`.
 *
 * DOCS/TYPES-DERIVED (declared by eve 0.31.3 but not exercised in the spike):
 *   session.completed, session.failed, result.completed, reasoning.appended,
 *   reasoning.completed, compaction.completed, action.partial,
 *   authorization.required, authorization.completed, subagent.called,
 *   subagent.started, subagent.event, subagent.completed
 *
 * Every event line is one JSON object `{ type, data?, meta? }`. The runtime
 * stamps `meta.at` (ISO timestamp) AND, from stream version 20 on, `meta.id`
 * (an `evt_`-prefixed ULID) once, immediately before the durable write — so
 * reconnects, rewinds and full replays yield the SAME id (see
 * {@link EveEventMeta}).
 *
 * Stream resume (0.31): `GET /eve/v1/session/:id/stream?startIndex=<n>` where
 * `startIndex` is an absolute event count (negative = tail-relative), plus the
 * opt-in `&includeTailIndex=1` which sets the `x-eve-stream-tail-index`
 * response header for bounded catch-up reads. Route paths, query builders and
 * header names live in `./eve-session-api`.
 *
 * WIRE NOTE — the NDJSON body opens with a single bare LF before any event
 * (a proxy/flush primer). Readers must skip empty lines and must NOT count
 * them as events, or the resume cursor desynchronizes permanently.
 */

/**
 * Durable envelope stamped by the runtime on persisted events.
 *
 * `id` is an `evt_`-prefixed ULID, stable across reconnects/rewinds/replays —
 * the dedupe KEY. It is deliberately OPTIONAL here even though eve 0.31 always
 * stamps it: `run_events` rows persisted by pre-0.28 agents (i.e. every 0.19-era
 * run already in Postgres) carry `meta.at` only, and SSE replay / delivery
 * recovery / the web reducer re-read those rows indefinitely. Guard for absence.
 *
 * Ids are time-ordered but NOT a total order across steps running in different
 * processes — never use `id > cursor` as a resume cursor. `startIndex` (eve) and
 * `run_events.seq` (ours) stay the cursors; `meta.id` is an overlap guard only.
 * It also does NOT suppress durable-step RETRIES: a retried step re-emits under
 * NEW ids with the same turnId/stepIndex/sequence.
 */
export interface EveEventMeta {
  /** ISO-8601 emission time. */
  readonly at: string;
  /** `evt_` + ULID. Absent only on pre-stream-version-20 persisted rows. */
  readonly id?: string;
}

/** Prefix eve stamps on every `meta.id`. */
export const EVE_EVENT_ID_PREFIX = "evt_";

/** Shape check for a stamped event id (`evt_` + 26-char Crockford ULID). */
export function isEveEventId(value: string): boolean {
  return /^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export type EveJsonValue =
  | string
  | number
  | boolean
  | null
  | EveJsonValue[]
  | { [key: string]: EveJsonValue };

export type EveJsonObject = Record<string, EveJsonValue>;

/** Finish reason for one completed assistant step ("tool-calls" is non-terminal). */
export type EveAssistantStepFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

/** Completion status projected onto action.result. */
export type EveActionResultStatus = "completed" | "failed" | "rejected";

/**
 * One model-requested action.
 *
 * DELIBERATELY NARROWED to `kind: "tool-call"` — the only action kind the
 * platform's compiled agents surface today. eve 0.31 also declares
 * `load-skill`, `subagent-call` and `remote-agent-call` request kinds
 * (`dist/src/runtime/actions/types.d.ts`); modeling them means every consumer
 * must narrow on `kind` before reading `toolName`, which is tracked as a
 * follow-up rather than folded into the upgrade.
 */
export interface EveActionRequest {
  readonly callId: string;
  readonly kind: "tool-call";
  readonly toolName: string;
  readonly input: EveJsonObject;
}

/** One executed action result carried on action.result / action.partial. */
export interface EveActionResult {
  readonly callId: string;
  readonly kind: string; // observed: "tool-result"
  readonly toolName: string;
  readonly output: EveJsonValue;
  readonly isError?: boolean;
}

/** One selectable option on an input request. */
export interface EveInputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: "danger" | "default" | "primary";
}

/**
 * Framework-owned SOURCE of a HITL input request (eve 0.31,
 * `inputRequestKindSchema`). This is the discriminator clients route on —
 * never infer intent from `action.toolName`:
 *
 * - `tool-approval`  — an approval gate in front of a tool call.
 * - `question`       — the agent asking the user something (`ask_question`).
 * - `session-limit`  — the session token-budget Approve/Stop prompt (see
 *   {@link EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION}). NEW in 0.31; a session
 *   that crosses the budget in conversation mode parks here instead of failing.
 */
export const EVE_INPUT_REQUEST_KINDS = [
  "tool-approval",
  "question",
  "session-limit",
] as const;
export type EveInputRequestKind = (typeof EVE_INPUT_REQUEST_KINDS)[number];

/**
 * HITL input request. Tool approvals, questions and session-limit decisions
 * all ride this shape and are told apart by {@link EveInputRequest.kind}.
 *
 * Observed (approval): kind "tool-approval", options
 * [{id:"approve",label:"Yes"},{id:"deny",label:"No"}], display "confirmation",
 * allowFreeform false, prompt "Approve tool call: <tool>".
 */
export interface EveInputRequest {
  readonly requestId: string;
  readonly prompt: string;
  /** Required on 0.31 — route presentation on this, not on `action.toolName`. */
  readonly kind: EveInputRequestKind;
  readonly action: {
    readonly callId: string;
    readonly kind: "tool-call";
    readonly toolName: string;
    readonly input: EveJsonObject;
  };
  readonly options?: readonly EveInputOption[];
  readonly display?: "confirmation" | "select" | "text";
  readonly allowFreeform?: boolean;
}

/**
 * Client -> server HITL answer.
 *
 * Sent as `POST /eve/v1/session/:id` with `{ inputResponses: [...] }` — the
 * "respond" form, MUTUALLY EXCLUSIVE with `message` (see
 * `eveSessionFollowUpRequestSchema` in ./eve-session-api). Answers are stale
 * once their turn is cancelled or the context is cleared.
 */
export interface EveInputResponse {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
}

/** Runtime identity on session.started. */
export interface EveRuntimeIdentity {
  readonly agentId: string;
  readonly agentName?: string;
  readonly eveVersion: string;
  readonly modelId: string;
  readonly build?: {
    readonly deployedAt?: string;
    readonly gitBranch?: string;
    readonly gitSha?: string;
  };
}

// ---------------------------------------------------------------------------
// Runtime limits (eve 0.31 applies these whether or not an agent configures
// them; the compiler emits them explicitly — design spec §6.2)
// ---------------------------------------------------------------------------

/** eve 0.31's default root-session input-token budget (40M). */
export const EVE_DEFAULT_MAX_INPUT_TOKENS_PER_SESSION = 40_000_000;

/** eve 0.31's default session timeout (30 days, in ms). */
export const EVE_DEFAULT_SESSION_TIMEOUT_MS = 2_592_000_000;

/**
 * Failure code eve raises when a session crosses its input-token budget with
 * no way to ask a human (task mode / no input proxying). Conversation-mode
 * sessions park on a `kind: "session-limit"` input request instead.
 */
export const EVE_SESSION_TOKEN_LIMIT_CODE = "SESSION_TOKEN_LIMIT_REACHED";

// ---------------------------------------------------------------------------
// Live-observed events
// ---------------------------------------------------------------------------

/** LIVE-OBSERVED. */
export interface EveSessionStartedEvent {
  readonly type: "session.started";
  readonly data: {
    readonly runtime?: EveRuntimeIdentity;
    readonly invocation?: {
      readonly kind: "subagent";
      readonly parentCallId: string;
      readonly parentSessionId: string;
      readonly parentTurnId: string;
      readonly name: string;
    };
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. */
export interface EveTurnStartedEvent {
  readonly type: "turn.started";
  readonly data: { readonly sequence: number; readonly turnId: string };
  readonly meta?: EveEventMeta;
}

/**
 * One structured part of a received user message (0.31). Mirrors the AI SDK
 * UI text/file part surface, narrowed to renderable metadata — raw bytes and
 * sandbox paths are never projected.
 */
export type EveMessageReceivedPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly filename?: string;
      readonly mediaType: string;
      readonly size?: number;
      readonly url?: string;
    };

/** LIVE-OBSERVED. `parts` is the 0.31 structured projection of `message`. */
export interface EveMessageReceivedEvent {
  readonly type: "message.received";
  readonly data: {
    readonly message: string;
    readonly parts?: readonly EveMessageReceivedPart[];
    readonly sequence: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. */
export interface EveStepStartedEvent {
  readonly type: "step.started";
  readonly data: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. */
export interface EveActionsRequestedEvent {
  readonly type: "actions.requested";
  readonly data: {
    readonly actions: readonly EveActionRequest[];
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED (approval park). */
export interface EveInputRequestedEvent {
  readonly type: "input.requested";
  readonly data: {
    readonly requests: readonly EveInputRequest[];
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. */
export interface EveActionResultEvent {
  readonly type: "action.result";
  readonly data: {
    readonly result: EveActionResult;
    readonly status: EveActionResultStatus;
    readonly error?: { readonly code: string; readonly message: string };
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/**
 * DOCS-DERIVED (0.31). Preliminary snapshot from a locally executed tool
 * generator — LAST-WRITE-WINS per `result.callId`; the settled value arrives
 * as `action.result`. Never treat a partial as terminal for its call.
 */
export interface EveActionPartialEvent {
  readonly type: "action.partial";
  readonly data: {
    readonly result: EveActionResult;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. Deltas carry both the delta and cumulative text. */
export interface EveMessageAppendedEvent {
  readonly type: "message.appended";
  readonly data: {
    readonly messageDelta: string;
    readonly messageSoFar: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/**
 * LIVE-OBSERVED. Can fire multiple times per turn (interim narration before
 * tool calls); a terminal reply has finishReason "stop".
 */
export interface EveMessageCompletedEvent {
  readonly type: "message.completed";
  readonly data: {
    readonly finishReason: EveAssistantStepFinishReason;
    readonly message: string | null;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. Carries token usage (0.31 adds `costUsd`). */
export interface EveStepCompletedEvent {
  readonly type: "step.completed";
  readonly data: {
    readonly finishReason: EveAssistantStepFinishReason;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly providerMetadata?: {
      readonly gateway: { readonly generationId: string };
    };
    readonly usage?: {
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED (keyless model-credential failure). */
export interface EveStepFailedEvent {
  readonly type: "step.failed";
  readonly data: {
    readonly code: string;
    readonly message: string;
    readonly details?: EveJsonObject;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED. */
export interface EveTurnCompletedEvent {
  readonly type: "turn.completed";
  readonly data: { readonly sequence: number; readonly turnId: string };
  readonly meta?: EveEventMeta;
}

/** LIVE-OBSERVED (keyless model-credential failure). */
export interface EveTurnFailedEvent {
  readonly type: "turn.failed";
  readonly data: {
    readonly code: string;
    readonly message: string;
    readonly details?: EveJsonObject;
    readonly sequence: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/**
 * LIVE-OBSERVED (0.31). One turn cancelled before a terminal outcome.
 *
 * CANCELLATION IS NOT FAILURE: the turn ends WITHOUT `turn.failed` /
 * `session.failed`, is always followed by `session.waiting`, and the session
 * accepts the next message normally. A run that sees this pair must land
 * `canceled`, never `failed` and never `succeeded`.
 *
 * It is cooperative, at durable step boundaries: a tool call already in flight
 * runs to completion and still emits its `action.result` (captured in
 * `spike/tests/fixtures/mocked-cancelled-events.ndjson`). It is also NOT a
 * turn boundary in eve's own sense — `isCurrentTurnBoundaryEvent` covers only
 * session.completed / session.failed / session.waiting.
 */
export interface EveTurnCancelledEvent {
  readonly type: "turn.cancelled";
  readonly data: { readonly sequence: number; readonly turnId: string };
  readonly meta?: EveEventMeta;
}

/**
 * LIVE-OBSERVED (0.31, via the clear control route). Durable model-message
 * history was cleared; the session itself stays active and is followed by
 * `session.waiting`. Pending input requests are stale after this.
 */
export interface EveContextClearedEvent {
  readonly type: "context.cleared";
  readonly data: {
    readonly sequence: number;
    readonly sessionId: string;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/**
 * LIVE-OBSERVED. The durable park boundary ("waiting" session status).
 *
 * `data.continuationToken` is a COMPATIBILITY ECHO — for an ID-addressed
 * session it is literally the immutable session id. eve 0.31 accepts a
 * `continuationToken` key on NO request (it 400s on its mere presence), so
 * never read this back into a request body or persist it as session state.
 */
export interface EveSessionWaitingEvent {
  readonly type: "session.waiting";
  readonly data: {
    readonly wait: "next-user-message";
    /** @deprecated Compat echo of the session id. Never send it back. */
    readonly continuationToken?: string;
  };
  readonly meta?: EveEventMeta;
}

// ---------------------------------------------------------------------------
// Docs/types-derived events (eve 0.31.3 protocol types; not yet live-observed)
// ---------------------------------------------------------------------------

/** DOCS-DERIVED. Terminal success (task-mode sessions; chat sessions park). */
export interface EveSessionCompletedEvent {
  readonly type: "session.completed";
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Terminal failure. */
export interface EveSessionFailedEvent {
  readonly type: "session.failed";
  readonly data: {
    readonly code: string;
    readonly message: string;
    readonly details?: EveJsonObject;
    readonly sessionId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Structured output (turns with an outputSchema). */
export interface EveResultCompletedEvent {
  readonly type: "result.completed";
  readonly data: {
    readonly result: EveJsonValue;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. */
export interface EveReasoningAppendedEvent {
  readonly type: "reasoning.appended";
  readonly data: {
    readonly reasoningDelta: string;
    readonly reasoningSoFar: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. */
export interface EveReasoningCompletedEvent {
  readonly type: "reasoning.completed";
  readonly data: {
    readonly reasoning: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/**
 * LIVE-OBSERVED (0.31, via the compact control route). NOTE compacting an
 * empty or already-cleared context emits NO `compaction.*` events at all —
 * the 202 ack is the only reliable acknowledgement.
 */
export interface EveCompactionRequestedEvent {
  readonly type: "compaction.requested";
  readonly data: {
    readonly modelId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly turnId: string;
    readonly usageInputTokens: number | null;
  };
  readonly meta?: EveEventMeta;
}

/**
 * DOCS-DERIVED. Absent when summarization failed — the session still returns
 * to `session.waiting` with its previous history, which is NOT an error.
 */
export interface EveCompactionCompletedEvent {
  readonly type: "compaction.completed";
  readonly data: {
    readonly modelId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Connection OAuth challenge (parks the turn). */
export interface EveAuthorizationRequiredEvent {
  readonly type: "authorization.required";
  readonly data: {
    readonly name: string;
    readonly description: string;
    readonly authorization?: EveJsonObject; // may include url, userCode, expiresAt, instructions
    readonly webhookUrl?: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. */
export interface EveAuthorizationCompletedEvent {
  readonly type: "authorization.completed";
  readonly data: {
    readonly name: string;
    readonly outcome: "authorized" | "declined" | "failed" | "timed-out";
    readonly reason?: string;
    readonly authorization?: EveJsonObject;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Delegated (workflow) subagent; attach to childSessionId. */
export interface EveSubagentCalledEvent {
  readonly type: "subagent.called";
  readonly data: {
    readonly callId: string;
    readonly childSessionId: string;
    readonly sessionId: string;
    readonly name: string;
    readonly toolName: string;
    readonly workflowId: string;
    readonly remote?: { readonly url: string };
    readonly sequence: number;
    readonly turnId: string;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Inline subagent start. */
export interface EveSubagentStartedEvent {
  readonly type: "subagent.started";
  readonly data: { readonly callId: string; readonly subagentName: string };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. Wraps one child stream event from an inline subagent. */
export interface EveSubagentChildEventEvent {
  readonly type: "subagent.event";
  readonly data: {
    readonly callId: string;
    readonly subagentName: string;
    readonly event: EveStreamEvent;
  };
  readonly meta?: EveEventMeta;
}

/** DOCS-DERIVED. */
export interface EveSubagentCompletedEvent {
  readonly type: "subagent.completed";
  readonly data: {
    readonly callId: string;
    readonly subagentName: string;
    readonly output: string;
  };
  readonly meta?: EveEventMeta;
}

/** The full NDJSON stream event union for eve@0.31.3 (stream version 21). */
export type EveStreamEvent =
  | EveSessionStartedEvent
  | EveTurnStartedEvent
  | EveMessageReceivedEvent
  | EveStepStartedEvent
  | EveActionsRequestedEvent
  | EveInputRequestedEvent
  | EveActionPartialEvent
  | EveActionResultEvent
  | EveMessageAppendedEvent
  | EveMessageCompletedEvent
  | EveStepCompletedEvent
  | EveStepFailedEvent
  | EveTurnCompletedEvent
  | EveTurnFailedEvent
  | EveTurnCancelledEvent
  | EveContextClearedEvent
  | EveSessionWaitingEvent
  | EveSessionCompletedEvent
  | EveSessionFailedEvent
  | EveResultCompletedEvent
  | EveReasoningAppendedEvent
  | EveReasoningCompletedEvent
  | EveCompactionRequestedEvent
  | EveCompactionCompletedEvent
  | EveAuthorizationRequiredEvent
  | EveAuthorizationCompletedEvent
  | EveSubagentCalledEvent
  | EveSubagentStartedEvent
  | EveSubagentChildEventEvent
  | EveSubagentCompletedEvent;

export type EveStreamEventType = EveStreamEvent["type"];

/**
 * Event types confirmed live on eve@0.31.3 (see the committed spike fixtures).
 * `context.cleared` / `compaction.requested` were also observed through the
 * control routes but are not fixture-backed, so they stay off this list.
 */
export const LIVE_OBSERVED_EVE_EVENT_TYPES = [
  "session.started",
  "turn.started",
  "message.received",
  "step.started",
  "actions.requested",
  "input.requested",
  "action.result",
  "message.appended",
  "message.completed",
  "step.completed",
  "step.failed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.waiting",
] as const satisfies readonly EveStreamEventType[];

/**
 * Events eve treats as the CURRENT-TURN BOUNDARY (`isCurrentTurnBoundaryEvent`
 * in `dist/src/protocol/message.js`). Deliberately excludes every `turn.*`
 * event — including `turn.cancelled`, which is always followed by
 * `session.waiting`. "The turn is over" must be detected on these three.
 */
export const EVE_TURN_BOUNDARY_EVENT_TYPES = [
  "session.completed",
  "session.failed",
  "session.waiting",
] as const satisfies readonly EveStreamEventType[];

/**
 * Events that represent an unrecovered turn/session FAILURE
 * (`isTurnFailureEvent`). `turn.cancelled` is intentionally absent —
 * cancellation is a user decision, never an error.
 */
export const EVE_TURN_FAILURE_EVENT_TYPES = [
  "session.failed",
  "step.failed",
  "turn.failed",
] as const satisfies readonly EveStreamEventType[];
