/**
 * eve NDJSON session-stream event inventory — FROZEN for eve@0.19.0.
 *
 * README / provenance
 * -------------------
 * Captured during the Phase-0 spike (2026-07-02) from a self-hosted
 * `eve build` + `eve start` agent with `@workflow/world-postgres@5.0.0-beta.20`
 * behind the spike reverse proxy. Raw captures live in
 * `spike/tests/fixtures/*.ndjson`; type shapes were cross-checked against
 * eve@0.19.0's own `dist/src/protocol/message.d.ts` (the authoritative wire
 * contract; stream version header `x-eve-stream-version: 16`).
 *
 * LIVE-OBSERVED in spike runs (see fixtures):
 *   session.started, turn.started, message.received, step.started,
 *   actions.requested, action.result, input.requested, message.appended,
 *   message.completed, step.completed, step.failed, turn.completed,
 *   turn.failed, session.waiting
 *
 * DOCS/TYPES-DERIVED (declared by eve 0.19.0 but not exercised keyless —
 * re-verify with live runs once provider keys exist):
 *   session.completed, session.failed, result.completed, reasoning.appended,
 *   reasoning.completed, compaction.requested, compaction.completed,
 *   authorization.required, authorization.completed, subagent.called,
 *   subagent.started, subagent.event, subagent.completed
 *
 * Every event line is one JSON object `{ type, data?, meta? }`; the runtime
 * stamps `meta.at` (ISO timestamp) on persisted events (observed on all).
 * Stream resume: `GET /eve/v1/session/:id/stream?startIndex=<eventsConsumed>`.
 */

/** ISO-8601 timestamp stamped by the runtime on persisted events. */
export interface EveEventMeta {
  readonly at: string;
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

/** One model-requested action (tool call). Observed: kind "tool-call". */
export interface EveActionRequest {
  readonly callId: string;
  readonly kind: "tool-call";
  readonly toolName: string;
  readonly input: EveJsonObject;
}

/** One executed action result carried on action.result. */
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
 * HITL input request (tool approvals and ask_question share this shape).
 * Observed (approval): options [{id:"approve",label:"Yes"},{id:"deny",label:"No"}],
 * display "confirmation", allowFreeform false, prompt "Approve tool call: <tool>".
 */
export interface EveInputRequest {
  readonly requestId: string;
  readonly prompt: string;
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

/** Client -> server HITL answer (POST /eve/v1/session/:id inputResponses[]). */
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

/** LIVE-OBSERVED. */
export interface EveMessageReceivedEvent {
  readonly type: "message.received";
  readonly data: {
    readonly message: string;
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

/** LIVE-OBSERVED. Carries token usage. */
export interface EveStepCompletedEvent {
  readonly type: "step.completed";
  readonly data: {
    readonly finishReason: EveAssistantStepFinishReason;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly usage?: {
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

/** LIVE-OBSERVED. The durable park boundary ("waiting" session status). */
export interface EveSessionWaitingEvent {
  readonly type: "session.waiting";
  readonly data: { readonly wait: "next-user-message" };
  readonly meta?: EveEventMeta;
}

// ---------------------------------------------------------------------------
// Docs/types-derived events (eve 0.19.0 protocol types; not yet live-observed)
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

/** DOCS-DERIVED. */
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

/** DOCS-DERIVED. */
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

/** The full NDJSON stream event union for eve@0.19.0 (stream version 16). */
export type EveStreamEvent =
  | EveSessionStartedEvent
  | EveTurnStartedEvent
  | EveMessageReceivedEvent
  | EveStepStartedEvent
  | EveActionsRequestedEvent
  | EveInputRequestedEvent
  | EveActionResultEvent
  | EveMessageAppendedEvent
  | EveMessageCompletedEvent
  | EveStepCompletedEvent
  | EveStepFailedEvent
  | EveTurnCompletedEvent
  | EveTurnFailedEvent
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

/** Event types confirmed live during the Phase-0 spike (see fixtures). */
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
  "session.waiting",
] as const satisfies readonly EveStreamEventType[];
