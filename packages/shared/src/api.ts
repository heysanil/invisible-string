/**
 * Phase-1 API contracts (INITIAL-SPEC.md §10, docs/PLAN.md Phase 1 task 5):
 * publish, create session, post message, and the run/run_event shapes served
 * over SSE. Single source of truth imported by apps/control-plane and
 * (later) apps/web — neither side re-declares these.
 *
 * Conventions:
 * - Request bodies get zod schemas (both sides validate); responses are
 *   plain DTO interfaces.
 * - All timestamps are ISO-8601 strings (DB `timestamptz` serialized).
 * - Status string unions mirror packages/db pgEnums — keep in lockstep.
 * - `agent_sessions` (chat/eve sessions) are distinct from Better Auth login
 *   sessions everywhere, including these DTO names.
 */
import { z } from "zod";

import type { EveStreamEvent } from "./eve-events";
import type { TriggerEvent } from "./trigger-event";

// ── Shared status unions (mirror packages/db pgEnums) ──────────────────────

/** Mirrors pgEnum `build_status`. */
export type BuildStatus = "pending" | "building" | "succeeded" | "failed";

/** Mirrors pgEnum `run_status`. `waiting` = parked on HITL input. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled";

/** Mirrors pgEnum `agent_session_status`. */
export type AgentSessionStatus = "active" | "waiting" | "closed" | "error";

/** Mirrors pgEnum `session_origin`. */
export type SessionOrigin = "chat" | "slack" | "webhook" | "form" | "schedule";

// ── Error envelope ──────────────────────────────────────────────────────────

/** Uniform non-2xx body. `code` is a stable machine-readable slug. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One chat thread = one `agent_sessions` row = one durable eve session.
 * The eve continuation token is deliberately NOT exposed — it stays
 * server-side (the control plane owns session→workspace mapping and checks
 * it on every continue/stream/input/cancel; PLAN correction 8).
 */
export interface AgentSessionDto {
  id: string;
  workflowId: string;
  /** Pinned at creation; publishing a new version affects new sessions only. */
  workflowVersionId: string;
  origin: SessionOrigin;
  status: AgentSessionStatus;
  /**
   * eve's session id. Null until eve acks — `POST /eve/v1/session` is async
   * (202) so creation responses may carry null here.
   */
  eveSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One run = one inbound message/trigger event within a session. */
export interface RunDto {
  id: string;
  agentSessionId: string;
  status: RunStatus;
  /** The normalized envelope that started this run (spec §8). */
  triggerEvent: TriggerEvent;
  eveRunId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// ── POST /workflows/:id/publish ─────────────────────────────────────────────

/**
 * Publish: snapshot the draft into an immutable `workflow_versions` row,
 * compile, and build — idempotent by content hash (config + compiler version
 * + eve version). No request body.
 */
export interface PublishWorkflowResponse {
  workflowId: string;
  /** The `workflow_versions` row now set as `published_version_id`. */
  versionId: string;
  contentHash: string;
  buildStatus: BuildStatus;
  /** True when the hash hit the `workflow_builds` cache (no new build ran). */
  cached: boolean;
  /** Compiler/`eve build` error log when buildStatus is "failed". */
  buildError: string | null;
}

// ── POST /workflows/:id/sessions ────────────────────────────────────────────

/** Start a chat/manual session against the workflow's published version. */
export const createSessionRequestSchema = z.object({
  /** First user message; becomes TriggerEvent.message of the first run. */
  message: z.string().min(1),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export interface CreateSessionResponse {
  session: AgentSessionDto;
  /** The first run. Stream it via `GET /runs/:id/stream`. */
  run: RunDto;
}

// ── POST /sessions/:id/messages ─────────────────────────────────────────────

/** Follow-up message → continues the same eve session (new run). */
export const postMessageRequestSchema = z.object({
  message: z.string().min(1),
});

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

export interface PostMessageResponse {
  run: RunDto;
}

// ── GET /sessions/:id ───────────────────────────────────────────────────────

/** Session detail: the thread rendered as its sequence of runs. */
export interface GetSessionResponse {
  session: AgentSessionDto;
  /** Ordered by createdAt ascending. */
  runs: RunDto[];
}

// ── GET /runs/:id/stream (SSE) ──────────────────────────────────────────────
//
// Content-Type: text/event-stream. Two frame kinds, distinguished by the SSE
// `event:` field:
//
//   event: run_event          one normalized eve stream event
//   id: <seq>                 run_events.seq — monotonic per run
//   data: <RunEventFrame JSON>
//
//   event: run_status         run lifecycle transition (incl. terminal)
//   data: <RunStatusFrame JSON>
//
// Resume: reconnect with `Last-Event-ID: <seq>`; the server replays only
// run_events with seq > Last-Event-ID (mirrors eve's own `?startIndex=`
// NDJSON resume upstream).

export const RUN_STREAM_EVENT_NAMES = ["run_event", "run_status"] as const;
export type RunStreamEventName = (typeof RUN_STREAM_EVENT_NAMES)[number];

/** `data` payload of an `event: run_event` frame (one `run_events` row). */
export interface RunEventFrame {
  runId: string;
  /** Monotonic per-run sequence — also the SSE frame `id` (resume cursor). */
  seq: number;
  /** The eve NDJSON event, frozen shapes per eve-events.ts. */
  event: EveStreamEvent;
  /** ISO time the control plane persisted the event. */
  at: string;
}

/** `data` payload of an `event: run_status` frame. */
export interface RunStatusFrame {
  runId: string;
  status: RunStatus;
  /** Set when status is "failed". */
  error?: string | null;
}
