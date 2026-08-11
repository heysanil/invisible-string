/**
 * API contracts (INITIAL-SPEC.md §10, docs/PLAN.md Phases 1–2): agent
 * CRUD/publish, sessions, messages, run SSE frames, plus the full resource
 * surface (workflows CRUD + publish, sessions list, run input, MCP
 * connections + registry, skills + attachments, model presets/allowlist,
 * members). Single source of truth imported by apps/control-plane and
 * apps/web — neither side re-declares these.
 *
 * Conventions:
 * - Request bodies get zod schemas (both sides validate). Responses ALSO get
 *   zod schemas so the web client can parse them — the hand-written DTO
 *   interfaces from Phase 1 are kept (doc comments + open unions) with
 *   compile-time lockstep guards against their schemas.
 * - All timestamps are ISO-8601 strings (DB `timestamptz` serialized).
 * - Status/enum schemas mirror packages/db pgEnums — keep in lockstep.
 * - `agent_sessions` (chat/eve sessions) are distinct from Better Auth login
 *   sessions everywhere, including these DTO names.
 * - SECRETS DISCIPLINE: credential WRITE shapes exist ({@link mcpAuthWriteSchema});
 *   the server encrypts and NEVER echoes secrets back — read DTOs carry a
 *   `hasCredentials` boolean only.
 */
import { z } from "zod";

import {
  agentDefinitionSchema,
  modelPresetSlugSchema,
  reasoningEffortSchema,
  type AgentDefinition,
} from "./agent-definition";
import type { EveStreamEvent } from "./eve-events";
import { triggerEventSchema, type TriggerEvent } from "./trigger-event";
import {
  formFieldSchema,
  slackTriggerBindingSchema,
  workflowConfigSchema,
  type WorkflowConfig,
} from "./workflow-config";

/** ISO-8601 timestamp (kept lenient on read; the DB serializer owns format). */
const isoTimestamp = z.string().min(1);

/** Product-row id (uuid). Requests validate strictly; DTO reads stay uuid too. */
const productId = z.uuid();

/** Better Auth ids (user/org/member) are opaque text, not uuids. */
const authId = z.string().min(1);

// ── Shared status unions (mirror packages/db pgEnums) ──────────────────────

/** Mirrors pgEnum `build_status`. */
export const buildStatusSchema = z.enum([
  "pending",
  "building",
  "succeeded",
  "failed",
]);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

/** Mirrors pgEnum `run_status`. `waiting` = parked on HITL input. */
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Mirrors pgEnum `delivery_status` — outbound reply delivery (Slack today)
 * performed by the control plane off the run's terminal event. Null on runs
 * with no outbound leg (chat, webhook, form, schedule).
 */
export const deliveryStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/** Mirrors pgEnum `agent_session_status`. */
export const agentSessionStatusSchema = z.enum([
  "active",
  "waiting",
  "closed",
  "error",
]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

/** Mirrors pgEnum `session_origin`. */
export const sessionOriginSchema = z.enum([
  "chat",
  "slack",
  "webhook",
  "form",
  "schedule",
]);
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;

/** Mirrors pgEnum `resource_scope` (MCP connections + skills). */
export const resourceScopeSchema = z.enum(["workspace", "user"]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

/** Mirrors pgEnum `model_provider`. */
export const modelProviderSchema = z.enum(["anthropic", "openrouter"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

/**
 * Provider-aware model-id SHAPE check (keyed-acceptance papercut: a
 * malformed id sails through allowlisting/publish and only fails at run time
 * with a provider error). This can't prove an id exists — the control plane
 * additionally consults OpenRouter's public catalog when reachable — but it
 * catches the whole wrong-provider-grammar class up front:
 * - openrouter ids are `vendor/slug` (optionally `:variant`), e.g.
 *   `deepseek/deepseek-v4-flash`, `openai/gpt-5.2:extended`, optionally with
 *   a LEADING TILDE — `~` is OpenRouter's convention for its `-latest`
 *   floating aliases (`~deepseek/deepseek-v4-flash-latest`) and is part of
 *   the id, so the shape check must allow it or a seeded preset's model
 *   cannot even be allowlisted
 * - anthropic (native API) ids are hyphenated, NO vendor prefix, e.g.
 *   `claude-opus-4-8` — a slash means someone pasted a gateway/OpenRouter id
 */
export function modelIdShapeProblem(
  provider: ModelProvider,
  modelId: string,
): string | null {
  if (provider === "openrouter") {
    return /^~?[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?::[\w.-]+)?$/i.test(modelId)
      ? null
      : `"${modelId}" is not an OpenRouter model id — expected "vendor/model" (e.g. "deepseek/deepseek-v4-flash", "~deepseek/deepseek-v4-flash-latest")`;
  }
  return modelId.includes("/")
    ? `"${modelId}" is not an Anthropic model id — native ids have no "/" (e.g. "claude-opus-4-8"); for OpenRouter-routed models pick the openrouter provider`
    : null;
}

/**
 * Better Auth organization roles. `member.role` is open text upstream, so
 * DTOs read `string` — these are the roles the UI understands.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type KnownWorkspaceRole = (typeof WORKSPACE_ROLES)[number];

// ── Error envelope ──────────────────────────────────────────────────────────

export const apiErrorInfoSchema = z.object({
  /** Stable machine-readable slug (e.g. "session_busy", "draft_invalid"). */
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorInfo = z.infer<typeof apiErrorInfoSchema>;

/**
 * TRANSIENT 409 on session writes: the PLATFORM's own serialization guard —
 * one run (one NDJSON tail) per session at a time, and `waiting` counts as
 * busy. Recovery is "wait for the in-flight run, then retry"; the message is
 * safe to keep in the composer.
 */
export const SESSION_BUSY_ERROR_CODE = "session_busy";

/**
 * PERMANENT 409 on session writes: EVE reports the session id is no longer
 * usable. eve 0.31 widened this beyond "a turn is running" — it also covers
 * terminal, timed-out and RESET sessions, and eve's truth can diverge from
 * `agent_sessions.status` indefinitely (a 30-day session timeout emits
 * `session.completed` into a stream nobody is tailing).
 *
 * Recovery is the OPPOSITE of {@link SESSION_BUSY_ERROR_CODE}: never retry —
 * release the session claim (a Slack thread key must be freed) and start a new
 * session. Collapsing the two codes turns a recoverable race into a
 * permanently bricked thread and a composer that lies to the user.
 */
export const SESSION_NOT_ACTIVE_ERROR_CODE = "session_not_active";

export const apiErrorBodySchema = z.object({ error: apiErrorInfoSchema });

/** Uniform non-2xx body. `code` is a stable machine-readable slug. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type _ErrorBodyLockstep = [
  z.infer<typeof apiErrorBodySchema> extends ApiErrorBody ? true : never,
  ApiErrorBody extends z.infer<typeof apiErrorBodySchema> ? true : never,
];
const _errorBodyLockstep: _ErrorBodyLockstep = [true, true];
void _errorBodyLockstep;

/** Uniform delete/archive acknowledgement. */
export const deleteResourceResponseSchema = z.object({
  id: z.string().min(1),
  deleted: z.literal(true),
});
export type DeleteResourceResponse = z.infer<
  typeof deleteResourceResponseSchema
>;

// ── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One chat thread = one `agent_sessions` row = one durable eve session.
 *
 * eve 0.31 sessions are ID-ADDRESSED: `eveSessionId` is the whole handle, and
 * follow-ups/controls address it in the route path. (0.19's continuation token
 * is gone — the `agent_sessions.continuation_token` column survives unwritten
 * as a documented residual, and eve 400s on the key's mere presence.) The id
 * still stays server-side: the control plane owns session→workspace mapping
 * and checks it on every continue/stream/input/cancel (PLAN correction 8).
 */
export interface AgentSessionDto {
  id: string;
  agentId: string;
  /** Pinned at creation; publishing a new agent version affects new sessions only. */
  agentVersionId: string;
  /** Workflow that delegated the session (provenance); null for direct chat. */
  workflowId: string | null;
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

export const agentSessionDtoSchema = z.object({
  id: productId,
  agentId: productId,
  agentVersionId: productId,
  workflowId: productId.nullable(),
  origin: sessionOriginSchema,
  status: agentSessionStatusSchema,
  eveSessionId: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

type _SessionDtoLockstep = [
  z.infer<typeof agentSessionDtoSchema> extends AgentSessionDto ? true : never,
  AgentSessionDto extends z.infer<typeof agentSessionDtoSchema> ? true : never,
];
const _sessionDtoLockstep: _SessionDtoLockstep = [true, true];
void _sessionDtoLockstep;

/** One run = one inbound message/trigger event within a session. */
export interface RunDto {
  id: string;
  agentSessionId: string;
  status: RunStatus;
  /** The provenance envelope that started this run (never sent to agents). */
  triggerEvent: TriggerEvent;
  /**
   * The rendered task message the agent actually received (`renderTaskMessage`
   * over the workflow's instructions); null for chat runs (the chat message
   * goes through verbatim).
   */
  taskMessage: string | null;
  /** Outbound reply delivery state; null when the run has no outbound leg. */
  deliveryStatus: DeliveryStatus | null;
  eveRunId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const runDtoSchema = z.object({
  id: productId,
  agentSessionId: productId,
  status: runStatusSchema,
  triggerEvent: triggerEventSchema,
  taskMessage: z.string().nullable(),
  deliveryStatus: deliveryStatusSchema.nullable(),
  eveRunId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: isoTimestamp.nullable(),
  completedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
});

type _RunDtoLockstep = [
  z.infer<typeof runDtoSchema> extends RunDto ? true : never,
  RunDto extends z.infer<typeof runDtoSchema> ? true : never,
];
const _runDtoLockstep: _RunDtoLockstep = [true, true];
void _runDtoLockstep;

// ── POST /workspaces/:workspaceId/agents/:agentId/publish ───────────────────

/**
 * Publish an agent: snapshot the draft into an immutable `agent_versions`
 * row, compile, and build — idempotent by content hash (definition +
 * resolved deps + compiler version + eve version + build-env epoch +
 * workspace slug). No request body.
 */
export interface PublishAgentResponse {
  agentId: string;
  /** The `agent_versions` row now set as `published_version_id`. */
  versionId: string;
  contentHash: string;
  buildStatus: BuildStatus;
  /** True when the hash hit the `builds` cache (no new build ran). */
  cached: boolean;
  /** Compiler/`eve build` error log when buildStatus is "failed". */
  buildError: string | null;
}

export const publishAgentResponseSchema = z.object({
  agentId: productId,
  versionId: productId,
  contentHash: z.string().min(1),
  buildStatus: buildStatusSchema,
  cached: z.boolean(),
  buildError: z.string().nullable(),
});

type _PublishLockstep = [
  z.infer<typeof publishAgentResponseSchema> extends PublishAgentResponse
    ? true
    : never,
  PublishAgentResponse extends z.infer<typeof publishAgentResponseSchema>
    ? true
    : never,
];
const _publishLockstep: _PublishLockstep = [true, true];
void _publishLockstep;

// ── GET /workspaces/:workspaceId/agents/:agentId/versions/:versionId/build ──

/**
 * Build status of an agent version. The agent editor polls this after an
 * async publish (a fresh build answers "building" and progresses in the
 * background) so the rail can flip from "Building…" to the ready/error chip.
 */
export interface BuildStatusResponse {
  status: BuildStatus;
  /** `eve build`/compiler error log when status is "failed". */
  error: string | null;
}

export const buildStatusResponseSchema = z.object({
  status: buildStatusSchema,
  error: z.string().nullable(),
});

// ── POST /workspaces/:workspaceId/agents/:agentId/dry-run-compile ───────────

/**
 * Dry-run compile of the agent's CURRENT draft (no rows written). Compile
 * problems are the PAYLOAD of a dry run (`ok: false`), not a failed request —
 * the agent editor renders them inline next to the section cards.
 */
export const dryRunCompileResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), contentHash: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: apiErrorInfoSchema }),
]);
export type DryRunCompileResponse = z.infer<typeof dryRunCompileResponseSchema>;

// ── POST /workspaces/:workspaceId/agents/:agentId/sessions ──────────────────

/**
 * Start a chat session against the agent's published version (requires a
 * ready build). Chat sessions have no workflow — `session.workflowId` is
 * null.
 */
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

export const createSessionResponseSchema = z.object({
  session: agentSessionDtoSchema,
  run: runDtoSchema,
});

// ── POST /workspaces/:workspaceId/workflows/:wfId/run ───────────────────────

/**
 * Manual "Run now" body: optional message + optional structured data so the
 * workflow editor's test-run popover can exercise webhook/form-shaped
 * ingress. The server answers the same `{session, run}` envelope as chat
 * session creation ({@link createSessionResponseSchema}) — a test run IS a
 * dispatched run riding the shared trigger path.
 */
export const runWorkflowRequestSchema = z.object({
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RunWorkflowRequest = z.infer<typeof runWorkflowRequestSchema>;

// ── POST /sessions/:id/messages ─────────────────────────────────────────────

/**
 * Follow-up message → continues the same eve session by ID (new run).
 *
 * TWO distinct 409s, with OPPOSITE recoveries — the UI must branch on `code`,
 * never on the status alone:
 * - {@link SESSION_BUSY_ERROR_CODE} — transient. A run is already queued/
 *   running/waiting on this session. Keep the draft, offer "try again once it
 *   finishes".
 * - {@link SESSION_NOT_ACTIVE_ERROR_CODE} — permanent for this session (eve
 *   says the id is terminal/reset/unknown). Never offer a retry; offer
 *   starting a new chat.
 */
export const postMessageRequestSchema = z.object({
  message: z.string().min(1),
});

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

export interface PostMessageResponse {
  run: RunDto;
}

export const postMessageResponseSchema = z.object({ run: runDtoSchema });

// ── Session context controls (eve 0.31) ─────────────────────────────────────
//
//   POST /sessions/:id/clear    → SessionContextControlResponse
//   POST /sessions/:id/compact  → SessionContextControlResponse
//   POST /sessions/:id/reset    → ResetSessionResponse
//
// Each fronts the matching eve control route
// (`POST /eve/v1/session/:eveSessionId/{clear,compact,reset}`; contracts in
// ./eve-session-api). All three take an optional body.
//
// STOPPING A TURN IS NOT HERE: the Stop button keeps using the existing
// `POST /runs/:id/cancel` ({@link runCancelRequestSchema}), which now fronts
// `POST /eve/v1/session/:id/cancel` instead of only stopping our tail. There
// is deliberately no second session-scoped cancel route.

/**
 * Outcome of a clear/compact. `accepted` = eve queued the command (the stream
 * emits `context.cleared` / `compaction.requested`, then `session.waiting`);
 * `no_active_session` = eve has no live session behind this id — the same
 * terminal condition a send would answer as `session_not_active`.
 *
 * Keyed on `status`, NOT on the HTTP code: eve answers 202 for accepted and
 * 200 for no_active_session, and a missing `compaction.completed` means
 * summarization was skipped/failed and history was PRESERVED — not an error.
 */
export const sessionContextControlStatusSchema = z.enum([
  "accepted",
  "no_active_session",
]);
export type SessionContextControlStatus = z.infer<
  typeof sessionContextControlStatusSchema
>;

/** No body today; declared so the route has a schema to validate against. */
export const sessionContextControlRequestSchema = z.object({}).optional();
export type SessionContextControlRequest = z.infer<
  typeof sessionContextControlRequestSchema
>;

export const sessionContextControlResponseSchema = z.object({
  session: agentSessionDtoSchema,
  status: sessionContextControlStatusSchema,
});
export type SessionContextControlResponse = z.infer<
  typeof sessionContextControlResponseSchema
>;

/**
 * Reset body. DESTRUCTIVE: the eve session id is retired permanently and can
 * never accept another message, so the UI gates this behind a confirm step.
 */
export const resetSessionRequestSchema = z
  .object({
    /** Optional audit note (never shown to the model). */
    reason: z.string().min(1).max(500).optional(),
  })
  .optional();
export type ResetSessionRequest = z.infer<typeof resetSessionRequestSchema>;

/**
 * Reset outcome. On `reset`, the old row is closed and a NEW `agent_sessions`
 * row is minted against the same agent — clients must re-key their thread
 * cache and switch the active session to `session.id`. On
 * `no_active_session` there was nothing live to retire, so no replacement is
 * minted and the caller keeps using the existing row.
 */
export const resetSessionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reset"),
    /** The retired row (status "closed"). */
    previousSession: agentSessionDtoSchema,
    /** The fresh row that replaces it — the thread continues here. */
    session: agentSessionDtoSchema,
  }),
  z.object({
    status: z.literal("no_active_session"),
    previousSession: agentSessionDtoSchema,
  }),
]);
export type ResetSessionResponse = z.infer<typeof resetSessionResponseSchema>;

// ── GET /sessions/:id ───────────────────────────────────────────────────────

/** Session detail: the thread rendered as its sequence of runs. */
export interface GetSessionResponse {
  session: AgentSessionDto;
  /** Ordered by createdAt ascending. */
  runs: RunDto[];
}

export const getSessionResponseSchema = z.object({
  session: agentSessionDtoSchema,
  runs: z.array(runDtoSchema),
});

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
// Resume: reconnect with `Last-Event-ID: <seq>` (or `?lastEventId=<seq>` for
// native EventSource clients that cannot set headers); the server replays
// only run_events with seq > Last-Event-ID.
//
// `seq` STAYS the resume cursor at both hops. Upstream, eve resumes on an
// absolute `?startIndex=` (optionally bounded with `&includeTailIndex=1` →
// `x-eve-stream-tail-index`); eve's `meta.id` is a stable dedupe KEY, not a
// cursor — its ULIDs are time-ordered but not totally ordered across steps in
// different processes, so `id > cursor` would silently drop events. That id
// rides along as {@link RunEventFrame.eventId} for identity/dedupe only.

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
  /**
   * eve's stable `meta.id` (`evt_` + ULID) when the event carried one — the
   * dedupe key, NOT a cursor. Absent for events persisted by pre-0.28 (0.19-era)
   * agents, which is permanent for historical rows, so clients must fall back
   * to `seq`. Two frames can legitimately share an `eventId` under DIFFERENT
   * `seq`s when a prior turn's leftovers are re-attributed to a later run.
   */
  eventId?: string;
}

/** `data` payload of an `event: run_status` frame. */
export interface RunStatusFrame {
  runId: string;
  status: RunStatus;
  /** Set when status is "failed". */
  error?: string | null;
}

/**
 * No further SSE frames arrive for a run in this status — the server closes
 * the stream after sending it. NOTE `waiting` IS stream-terminal: a parked
 * run emits nothing further until `POST /runs/:id/input` resumes it, after
 * which clients re-open the stream (replay via Last-Event-ID is seamless).
 */
export function isRunStreamTerminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

/**
 * The run is OVER — no later status can supersede this one.
 *
 * Deliberately NARROWER than {@link isRunStreamTerminalStatus}: `waiting` is
 * stream-terminal (the server closes the tail) but NOT settled — a parked run
 * still moves to `canceled`/`succeeded`/`failed` later, and it does so with no
 * open stream to carry the news. That gap is why a stream-derived status must
 * never outrank a settled row: the live cache for a parked run is frozen at
 * `waiting` forever, so treating it as fresher strands the UI (a stopped run
 * that never looks stopped). Callers resolving "row vs live" want THIS check.
 */
export function isRunSettledStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — resource CRUD surface
// ═════════════════════════════════════════════════════════════════════════════

// ── Workflows CRUD + publish ────────────────────────────────────────────────
//
//   GET    /workspaces/:workspaceId/workflows                → ListWorkflowsResponse
//   POST   /workspaces/:workspaceId/workflows                → CreateWorkflowResponse (201)
//   GET    /workspaces/:workspaceId/workflows/:wfId          → GetWorkflowResponse
//   PATCH  /workspaces/:workspaceId/workflows/:wfId          → UpdateWorkflowResponse
//   DELETE /workspaces/:workspaceId/workflows/:wfId          → DeleteResourceResponse
//   POST   /workspaces/:workspaceId/workflows/:wfId/publish  → PublishWorkflowResponse
//
// Workflows have no builds: publish validates the draft (published agent,
// non-empty instructions, legal @references), snapshots `draft` →
// `published`, and syncs the trigger row — instant, no compile. Deleting a
// workflow cascades to its trigger rows; its sessions survive with
// `workflowId` nulled (provenance).

const workflowNameSchema = z.string().trim().min(1).max(200);

/**
 * One validation finding for a workflow draft (shared validator; returned on
 * PATCH/GET and enforced at publish). `path` is a dot path into the config
 * (e.g. "agentId", "instructions.markdown"); `severity: "error"` blocks
 * publish, `"warning"` does not (e.g. an agent republish stranding a
 * `@connection` ref — dispatch degrades gracefully).
 */
export const workflowDiagnosticSchema = z.object({
  path: z.string(),
  message: z.string().min(1),
  severity: z.enum(["error", "warning"]),
});
export type WorkflowDiagnostic = z.infer<typeof workflowDiagnosticSchema>;

export const workflowDiagnosticsSchema = z.array(workflowDiagnosticSchema);
export type WorkflowDiagnostics = z.infer<typeof workflowDiagnosticsSchema>;

/** List-item projection (no draft/published payloads). */
export const workflowSummaryDtoSchema = z.object({
  id: productId,
  name: workflowNameSchema,
  /**
   * `draft.trigger.type` surfaced for list chips; null while the draft has
   * no shape-valid trigger yet.
   */
  triggerType: z.string().nullable(),
  /** Name of the draft's agent; null while the draft names none. */
  agentName: z.string().nullable(),
  /** Master switch for trigger dispatch (publish state is `publishedAt`). */
  enabled: z.boolean(),
  publishedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WorkflowSummaryDto = z.infer<typeof workflowSummaryDtoSchema>;

/**
 * Full workflow row. `draft` and `published` are served AS STORED (jsonb;
 * the draft is draft-lenient); use {@link parseWorkflowConfig} to get a
 * shape-guarded config from either.
 */
export const workflowDtoSchema = z.object({
  id: productId,
  name: workflowNameSchema,
  draft: z.record(z.string(), z.unknown()),
  /** Publish-time snapshot dispatch reads; null while never published. */
  published: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  publishedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WorkflowDto = z.infer<typeof workflowDtoSchema>;

/**
 * Shape-guarded view of a stored draft/published snapshot; null when empty
 * or shape-invalid.
 */
export function parseWorkflowConfig(config: unknown): WorkflowConfig | null {
  const parsed = workflowConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

export const createWorkflowRequestSchema = z.object({
  name: workflowNameSchema,
  /** Full config draft; omitted = empty draft the editor fills in. */
  draft: workflowConfigSchema.optional(),
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;

export const updateWorkflowRequestSchema = z
  .object({
    name: workflowNameSchema.optional(),
    /** Full replacement draft (the editor always writes whole configs). */
    draft: workflowConfigSchema.optional(),
    /** Pause/resume trigger dispatch without unpublishing. */
    enabled: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.draft !== undefined ||
      patch.enabled !== undefined,
    { message: "update at least one of name, draft, enabled" },
  );
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>;

export const listWorkflowsResponseSchema = z.object({
  workflows: z.array(workflowSummaryDtoSchema),
});
export type ListWorkflowsResponse = z.infer<typeof listWorkflowsResponseSchema>;

/**
 * GET/PATCH/publish all answer the row plus current validator diagnostics
 * (omitted when validation could not run) — the editor gets validation for
 * free without a second round-trip, and a stale agent reference surfaces as
 * a warning on plain GETs.
 */
export const getWorkflowResponseSchema = z.object({
  workflow: workflowDtoSchema,
  diagnostics: workflowDiagnosticsSchema.optional(),
});
export type GetWorkflowResponse = z.infer<typeof getWorkflowResponseSchema>;

export const createWorkflowResponseSchema = getWorkflowResponseSchema;
export type CreateWorkflowResponse = GetWorkflowResponse;

export const updateWorkflowResponseSchema = getWorkflowResponseSchema;
export type UpdateWorkflowResponse = GetWorkflowResponse;

/** Publish response: the updated row (`published` freshly snapshotted). */
export const publishWorkflowResponseSchema = z.object({
  workflow: workflowDtoSchema,
});
export type PublishWorkflowResponse = z.infer<
  typeof publishWorkflowResponseSchema
>;

// ── Sessions list ───────────────────────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/sessions?agentId=&workflowId=&status= → ListSessionsResponse
//
// Ordered by lastActivityAt descending (the chat list).

export const listSessionsQuerySchema = z.object({
  /** Restrict to one agent (the agent's chat history). */
  agentId: productId.optional(),
  /** Restrict to one workflow (the workflow's session history panel). */
  workflowId: productId.optional(),
  status: agentSessionStatusSchema.optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

/** Session list item: DTO + the fields the chat list renders. */
export const agentSessionSummaryDtoSchema = agentSessionDtoSchema.extend({
  agentName: z.string(),
  /** Workflow provenance for the origin chip; null for direct chat. */
  workflowName: z.string().nullable(),
  /** Status of the most recent run; null before the first run lands. */
  lastRunStatus: runStatusSchema.nullable(),
  /** Max of session/run updatedAt — the list's sort key. */
  lastActivityAt: isoTimestamp,
});
export type AgentSessionSummaryDto = z.infer<
  typeof agentSessionSummaryDtoSchema
>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(agentSessionSummaryDtoSchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

// ── POST /runs/:id/input — HITL response ────────────────────────────────────
//
// Answers an `input.requested` frame. Which card renders it is decided by the
// request's own `EveInputRequest.kind` discriminator — `tool-approval` |
// `question` | `session-limit` (see eve-events.ts); clients read it straight
// off the frame, so it needs no mirror in this request DTO.
//
// Forwarded to eve as the RESPOND form of the follow-up route:
// `POST /eve/v1/session/:id` with `{ inputResponses: [{requestId, optionId?,
// text?}] }` alone — mutually exclusive with `message`. The parked run resumes
// and the client re-opens the SSE stream.
//
// NOTE the exactly-one-of refinement below is a deliberate CONTROL-PLANE
// tightening: eve's own `inputResponseSchema` permits neither and both.
// Answers are stale once their turn is cancelled or the context is cleared.

export const runInputRequestSchema = z
  .object({
    /** EveInputRequest.requestId from the input.requested frame. */
    requestId: z.string().min(1),
    /** Chosen option id (e.g. "approve" / "deny"). */
    optionId: z.string().min(1).optional(),
    /** Freeform answer (input requests with allowFreeform). */
    text: z.string().min(1).optional(),
  })
  .refine((input) => (input.optionId === undefined) !== (input.text === undefined), {
    message: "provide exactly one of optionId or text",
  });
export type RunInputRequest = z.infer<typeof runInputRequestSchema>;

export const runInputResponseSchema = z.object({ run: runDtoSchema });
export type RunInputResponse = z.infer<typeof runInputResponseSchema>;

// ── MCP connection auth + approval shapes ───────────────────────────────────
//
// Shared by the connections domain below (and the compiler adapter): the
// approval-policy shape stored on the row, and the write-only credential
// envelope.

/**
 * Per-tool approval decision, exactly as stored on
 * `mcp_connections.approval_policy` and consumed by the compiler adapter:
 * "never" = auto-allow, "once" = ask once per session, "always" = always ask.
 */
export const mcpApprovalDecisionSchema = z.enum(["never", "once", "always"]);
export type McpApprovalDecision = z.infer<typeof mcpApprovalDecisionSchema>;

/**
 * Approval policy compiled into eve's tool-approval config. Stored shape:
 * `{ default, tools?: { <bare tool name>: decision } }`.
 */
export const mcpApprovalPolicySchema = z.object({
  default: mcpApprovalDecisionSchema.default("never"),
  tools: z
    .record(z.string().min(1), mcpApprovalDecisionSchema)
    .optional(),
});
export type McpApprovalPolicy = z.infer<typeof mcpApprovalPolicySchema>;

/**
 * Credential WRITE shape. The server encrypts values (AES-256-GCM envelope,
 * AAD-bound to the row) and NEVER echoes them back — read DTOs carry
 * {@link ConnectionDto.hasCredentials} only.
 *
 * - none    → clears any stored credentials
 * - bearer  → `values.token` becomes the connection's bearer token
 * - headers → `values` = header name → header VALUE (each stored encrypted)
 * - oauth   → no values here EVER: the consent broker owns the credentials
 *             (connectors spec §6) — the connection pairs with a
 *             `connection_oauth` row and tokens arrive via the popup flow
 */
export const mcpAuthWriteSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("oauth") }),
  z.object({
    type: z.literal("bearer"),
    values: z.object({ token: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("headers"),
    values: z
      .record(z.string().min(1), z.string().min(1))
      .refine((headers) => Object.keys(headers).length > 0, {
        message: "provide at least one header",
      }),
  }),
]);
export type McpAuthWrite = z.infer<typeof mcpAuthWriteSchema>;

const mcpConnectionNameSchema = z.string().trim().min(1).max(120);
const httpUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "must be an http(s) URL",
  });
const toolNameListSchema = z.array(z.string().min(1)).min(1);

/** Exactly one of allow/block may be set (compiler contract). */
function refineToolFilter<
  T extends { toolAllow?: string[] | null; toolBlock?: string[] | null },
>(value: T): boolean {
  return !(
    value.toolAllow != null &&
    value.toolAllow.length > 0 &&
    value.toolBlock != null &&
    value.toolBlock.length > 0
  );
}
const TOOL_FILTER_MESSAGE = "set toolAllow or toolBlock, not both";

// ── Connections (connectors redesign) ───────────────────────────────────────
//
// The rebuilt connection domain (connectors redesign spec §3), replacing the
// retired mcp-connections surface (its DTO family is deleted; the dead
// `mcp_connections` table stays per the additive-migrations rule). BOTH
// scopes:
//   workspace: /workspaces/:workspaceId/connections[...]
//   user:      /me/connections[...]
//
//   GET    <base>       → ListConnectionsResponse
//   POST   <base>       → GetConnectionResponse (201; catalog|registry|custom)
//   GET    <base>/:id   → GetConnectionResponse
//   PATCH  <base>/:id   → GetConnectionResponse
//   DELETE <base>/:id   → DeleteResourceResponse

/**
 * Connection row id: historical uuid rows (immutable published
 * `agent_versions.definition` snapshots reference them) OR
 * connectors-redesign `cn_<nanoid16>` rows (`newId("cn")`).
 */
export const connectionIdSchema = z.union([
  z.uuid(),
  z.string().regex(/^cn_[0-9a-z]{16}$/),
]);

/** Mirrors pgEnum `connection_source` (spec §2). */
export const connectionSourceSchema = z.enum(["catalog", "registry", "custom"]);
export type ConnectionSource = z.infer<typeof connectionSourceSchema>;

/** Mirrors pgEnum `mcp_transport`, persisted at install (spec §3). */
export const mcpTransportSchema = z.enum(["streamable-http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** Mirrors pgEnum `connection_auth_type`. `oauth` rows pair with `connection_oauth`. */
export const connectionAuthTypeSchema = z.enum([
  "none",
  "bearer",
  "headers",
  "oauth",
]);
export type ConnectionAuthType = z.infer<typeof connectionAuthTypeSchema>;

/** Mirrors pgEnum `connection_health` (spec §7). `unknown` until first probe. */
export const connectionHealthSchema = z.enum([
  "unknown",
  "ok",
  "unreachable",
  "auth_required",
  "auth_error",
]);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

/** Mirrors pgEnum `connection_oauth_status` (spec §3). */
export const connectionOauthStatusSchema = z.enum([
  "pending",
  "connected",
  "expired",
  "revoked",
  "error",
]);
export type ConnectionOauthStatus = z.infer<typeof connectionOauthStatusSchema>;

/** One cached tool, exactly as persisted on `connections.tools_cache`. */
export const connectionToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  params: z.array(z.string()),
});
export type ConnectionTool = z.infer<typeof connectionToolSchema>;

export const connectionDtoSchema = z.object({
  id: connectionIdSchema,
  scope: resourceScopeSchema,
  name: z.string().min(1),
  /** Model-facing summary — eve's connection_search routes on it. */
  description: z.string().nullable(),
  source: connectionSourceSchema,
  /** Curated catalog entry slug (source = catalog). */
  catalogSlug: z.string().nullable(),
  /** registry.modelcontextprotocol.io server name (source = registry). */
  registryName: z.string().nullable(),
  url: z.string().min(1),
  transport: mcpTransportSchema,
  authType: connectionAuthTypeSchema,
  /** True when encrypted credentials (or an OAuth grant) are stored. Secrets are never echoed. */
  hasCredentials: z.boolean(),
  /** Grant lifecycle when authType = "oauth"; null otherwise. */
  oauthStatus: connectionOauthStatusSchema.nullable(),
  toolAllow: z.array(z.string()).nullable(),
  toolBlock: z.array(z.string()).nullable(),
  approvalPolicy: mcpApprovalPolicySchema.nullable(),
  enabled: z.boolean(),
  health: connectionHealthSchema,
  lastCheckedAt: isoTimestamp.nullable(),
  lastError: z.string().nullable(),
  tools: z.array(connectionToolSchema).nullable(),
  toolsCachedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ConnectionDto = z.infer<typeof connectionDtoSchema>;

/**
 * Create a connection — one route, discriminated on `source`:
 * - catalog:  install a curated entry (the recipe supplies name/url/transport;
 *             `auth` must satisfy the entry's recipe — 422 server-side otherwise)
 * - registry: install a community server (`remoteUrl` must be one the registry
 *             advertises — the live provenance check stays server-side)
 * - custom:   bring-your-own URL
 */
export const createConnectionRequestSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("catalog"),
    slug: z.string().min(1),
    auth: mcpAuthWriteSchema.optional(),
  }),
  z.object({
    source: z.literal("registry"),
    registryName: z.string().min(1),
    remoteUrl: httpUrlSchema,
    version: z.string().min(1).optional(),
    name: mcpConnectionNameSchema.optional(),
    description: z.string().max(2000).optional(),
    auth: mcpAuthWriteSchema.optional(),
  }),
  z.object({
    source: z.literal("custom"),
    name: mcpConnectionNameSchema,
    url: httpUrlSchema,
    transport: mcpTransportSchema.optional(),
    description: z.string().max(2000).optional(),
    auth: mcpAuthWriteSchema.optional(),
  }),
]);
export type CreateConnectionRequest = z.infer<
  typeof createConnectionRequestSchema
>;

/**
 * Partial update. `auth` semantics: omitted = keep stored credentials;
 * `{type:"none"}` = clear; bearer/headers = replace. Explicit nulls clear the
 * nullable fields. `url`/`transport` parse here but are rejected server-side
 * (422) when `source !== "custom"`.
 */
export const updateConnectionRequestSchema = z
  .object({
    name: mcpConnectionNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    url: httpUrlSchema.optional(),
    transport: mcpTransportSchema.optional(),
    toolAllow: toolNameListSchema.nullable().optional(),
    toolBlock: toolNameListSchema.nullable().optional(),
    approvalPolicy: mcpApprovalPolicySchema.nullable().optional(),
    enabled: z.boolean().optional(),
    auth: mcpAuthWriteSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "update at least one field",
  })
  .refine(refineToolFilter, { message: TOOL_FILTER_MESSAGE });
export type UpdateConnectionRequest = z.infer<
  typeof updateConnectionRequestSchema
>;

export const listConnectionsResponseSchema = z.object({
  connections: z.array(connectionDtoSchema),
});
export type ListConnectionsResponse = z.infer<
  typeof listConnectionsResponseSchema
>;

export const getConnectionResponseSchema = z.object({
  connection: connectionDtoSchema,
});
export type GetConnectionResponse = z.infer<typeof getConnectionResponseSchema>;

/**
 * Create response: the DTO plus, when the new connection uses OAuth, the
 * scope-correct path of the consent start route so the UI can chain straight
 * into the popup flow (connectors spec §4/§6).
 */
export const createConnectionResponseSchema = getConnectionResponseSchema.extend({
  oauthStartPath: z.string().optional(),
});
export type CreateConnectionResponse = z.infer<
  typeof createConnectionResponseSchema
>;

/**
 * `POST /workspaces/:id/connections/:id/oauth/start` (+ `/me/...` mirror) →
 * the authorization-server consent URL the SPA opens in a popup. The PKCE
 * verifier and single-use `state` stay server-side on the `connection_oauth`
 * row (connectors spec §6).
 */
export const startOauthResponseSchema = z.object({ authorizeUrl: z.url() });
export type StartOauthResponse = z.infer<typeof startOauthResponseSchema>;

// ── MCP registry search + install provenance ────────────────────────────────
//
//   GET /mcp-registry/search?q=&limit=&offset= → RegistrySearchResponse
//
// Community search is served from the control plane's Meilisearch mirror of
// registry.modelcontextprotocol.io (sync ETL, connectors spec §5) — the
// browser never talks to the registry or Meilisearch directly. Only
// installable servers (active + latest + ≥1 valid remote) enter the index,
// so every result can be installed as-is; when Meilisearch is unconfigured
// or unreachable the route answers a typed 503 `search_unavailable` and the
// UI degrades to catalog-only. Install provenance still live-fetches the
// registry detail endpoint — {@link registryServerSummarySchema} remains
// that path's trimmed DTO.

/**
 * One env-var/header the server declares it needs. Secret-flagged
 * declarations render as password prompts in the install flow; values are
 * sent via {@link mcpAuthWriteSchema} and encrypted server-side.
 */
export const registryEnvVarDeclarationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  /** Registry format hint, e.g. "string" | "number" | "boolean" | "filepath". */
  format: z.string().optional(),
  default: z.string().optional(),
});
export type RegistryEnvVarDeclaration = z.infer<
  typeof registryEnvVarDeclarationSchema
>;

/** One hosted transport of a registry server. */
export const registryRemoteSchema = z.object({
  /** e.g. "streamable-http" | "sse" — open (registry adds transports). */
  type: z.string().min(1),
  url: httpUrlSchema,
  /** Headers the remote requires (install flow prompts for secret ones). */
  headers: z.array(registryEnvVarDeclarationSchema).optional(),
});
export type RegistryRemote = z.infer<typeof registryRemoteSchema>;

export const registryIconSchema = z.object({
  src: httpUrlSchema,
  mimeType: z.string().optional(),
  sizes: z.string().optional(),
  theme: z.enum(["light", "dark"]).optional(),
});
export type RegistryIcon = z.infer<typeof registryIconSchema>;

/** Trimmed registry server DTO (proxy output). */
export const registryServerSummarySchema = z.object({
  /** Registry id, reverse-DNS style (e.g. "io.github.owner/server"). */
  name: z.string().min(1),
  /** Human display name when the registry provides one. */
  title: z.string().optional(),
  description: z.string().default(""),
  version: z.string().min(1),
  /** Only remote-capable servers are installable — may be empty. */
  remotes: z.array(registryRemoteSchema).default([]),
  /** Package-level env-var declarations (secret prompts at install). */
  envVarDeclarations: z.array(registryEnvVarDeclarationSchema).default([]),
  icons: z.array(registryIconSchema).optional(),
});
export type RegistryServerSummary = z.infer<typeof registryServerSummarySchema>;

export const registrySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});
export type RegistrySearchQuery = z.infer<typeof registrySearchQuerySchema>;

/**
 * One community-search hit (the Meilisearch mirror's trimmed document).
 * `verified` = domain-verified publisher namespace (NOT io.github.*); the
 * install flow prompts from the chosen remote's header declarations.
 */
export const registrySearchResultSchema = z.object({
  /** Registry id, reverse-DNS style (e.g. "app.linear/linear"). */
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().default(""),
  verified: z.boolean(),
  /** Never empty on the wire: only installable servers enter the index. */
  remotes: z.array(registryRemoteSchema).default([]),
});
export type RegistrySearchResult = z.infer<typeof registrySearchResultSchema>;

export const registrySearchResponseSchema = z.object({
  results: z.array(registrySearchResultSchema),
  /** Estimated total matches (Meilisearch estimate), for pagination. */
  total: z.number().int().nonnegative(),
});
export type RegistrySearchResponse = z.infer<
  typeof registrySearchResponseSchema
>;

// ── Skills (agent context) ──────────────────────────────────────────────────
//
// Scoped like MCP connections:
//   workspace: /workspaces/:workspaceId/skills[...]
//   user:      /me/skills[...]
//
//   GET    <base>                    → ListSkillsResponse
//   POST   <base>                    → GetSkillResponse (201)
//   GET    <base>/:id                → GetSkillResponse
//   PATCH  <base>/:id                → GetSkillResponse
//   DELETE <base>/:id                → DeleteResourceResponse
//   POST   <base>/:id/files          → GetSkillResponse (multipart, below)
//   DELETE <base>/:id/files/:name    → GetSkillResponse
//
// ATTACHMENT UPLOAD (decision: direct multipart, not presigned — files are
// small, capped, and flow through the control plane's authz):
// `POST <base>/:id/files` with `multipart/form-data`; the file part is named
// {@link SKILL_FILE_FORM_FIELD}. Decoded size ≤ {@link SKILL_FILE_MAX_BYTES}
// (413 `skill_file_too_large` otherwise). Re-uploading an existing file name
// replaces it. Responses return the updated skill.

export const SKILL_FILE_FORM_FIELD = "file";
export const SKILL_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const SKILL_CONTENT_MAX_CHARS = 262_144; // 256 KiB of markdown

export const skillFileDtoSchema = z.object({
  /** Original filename (unique per skill; re-upload replaces). */
  name: z.string().min(1),
  /** Object-store key (server-managed; opaque to clients). */
  key: z.string().min(1),
  mediaType: z.string().min(1),
});
export type SkillFileDto = z.infer<typeof skillFileDtoSchema>;

export const skillDtoSchema = z.object({
  id: productId,
  scope: resourceScopeSchema,
  name: z.string().min(1),
  /** Routing hint eve advertises to the model. */
  description: z.string().nullable(),
  /** SKILL.md markdown body. */
  content: z.string(),
  /** Normalized to [] (DB stores null for "no files"). */
  files: z.array(skillFileDtoSchema),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SkillDto = z.infer<typeof skillDtoSchema>;

const skillNameSchema = z.string().trim().min(1).max(120);

export const createSkillRequestSchema = z.object({
  name: skillNameSchema,
  description: z.string().max(2000).optional(),
  /** May be empty while drafting; publish requires non-empty content. */
  content: z.string().max(SKILL_CONTENT_MAX_CHARS),
});
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

export const updateSkillRequestSchema = z
  .object({
    name: skillNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    content: z.string().max(SKILL_CONTENT_MAX_CHARS).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "update at least one field",
  });
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

export const listSkillsResponseSchema = z.object({
  skills: z.array(skillDtoSchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

export const getSkillResponseSchema = z.object({ skill: skillDtoSchema });
export type GetSkillResponse = z.infer<typeof getSkillResponseSchema>;

// ── Model presets ───────────────────────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/model-presets        → ListModelPresetsResponse
//   PUT /workspaces/:workspaceId/model-presets/:slug  → GetModelPresetResponse
//
// The three slugs are seeded per workspace and fixed — presets are re-pointed
// (PUT), never created or deleted.
//
// A preset is `(provider, modelId, reasoning)`: the EFFORT is part of the
// preset, not just of the agent. Two tiers may point at the same model and
// differ only in effort (the seeded `balanced`/`quick` pair does exactly
// that), which is impossible if effort lives only on the agent.

export const modelPresetDtoSchema = z.object({
  id: productId,
  slug: modelPresetSlugSchema,
  provider: modelProviderSchema,
  modelId: z.string().min(1),
  /** The preset's effort — agents inherit it unless they override. */
  reasoning: reasoningEffortSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ModelPresetDto = z.infer<typeof modelPresetDtoSchema>;

export const updateModelPresetRequestSchema = z.object({
  provider: modelProviderSchema,
  /** Must be on the workspace allowlist (422 `model_not_allowlisted`). */
  modelId: z.string().min(1),
  /**
   * OPTIONAL on purpose — absent means "keep the stored effort". A web bundle
   * from before efforts existed must not start 400ing mid-deploy.
   */
  reasoning: reasoningEffortSchema.optional(),
});
export type UpdateModelPresetRequest = z.infer<
  typeof updateModelPresetRequestSchema
>;

export const listModelPresetsResponseSchema = z.object({
  presets: z.array(modelPresetDtoSchema),
});
export type ListModelPresetsResponse = z.infer<
  typeof listModelPresetsResponseSchema
>;

export const getModelPresetResponseSchema = z.object({
  preset: modelPresetDtoSchema,
});
export type GetModelPresetResponse = z.infer<
  typeof getModelPresetResponseSchema
>;

// ── Model allowlist ─────────────────────────────────────────────────────────
//
//   GET    /workspaces/:workspaceId/model-allowlist      → ListModelAllowlistResponse
//   POST   /workspaces/:workspaceId/model-allowlist      → GetModelAllowlistEntryResponse (201)
//   PATCH  /workspaces/:workspaceId/model-allowlist/:id  → GetModelAllowlistEntryResponse (toggle)
//   DELETE /workspaces/:workspaceId/model-allowlist/:id  → DeleteResourceResponse

export const modelAllowlistEntryDtoSchema = z.object({
  id: productId,
  provider: modelProviderSchema,
  modelId: z.string().min(1),
  enabled: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ModelAllowlistEntryDto = z.infer<
  typeof modelAllowlistEntryDtoSchema
>;

export const addModelAllowlistEntryRequestSchema = z
  .object({
    provider: modelProviderSchema,
    modelId: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(true),
  })
  .superRefine((entry, ctx) => {
    const problem = modelIdShapeProblem(entry.provider, entry.modelId);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", path: ["modelId"], message: problem });
    }
  });
export type AddModelAllowlistEntryRequest = z.infer<
  typeof addModelAllowlistEntryRequestSchema
>;

export const updateModelAllowlistEntryRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateModelAllowlistEntryRequest = z.infer<
  typeof updateModelAllowlistEntryRequestSchema
>;

export const listModelAllowlistResponseSchema = z.object({
  entries: z.array(modelAllowlistEntryDtoSchema),
});
export type ListModelAllowlistResponse = z.infer<
  typeof listModelAllowlistResponseSchema
>;

export const getModelAllowlistEntryResponseSchema = z.object({
  entry: modelAllowlistEntryDtoSchema,
});
export type GetModelAllowlistEntryResponse = z.infer<
  typeof getModelAllowlistEntryResponseSchema
>;

// ── Model capabilities ──────────────────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/model-capabilities → ListModelCapabilitiesResponse
//
// Every ENABLED allowlist entry, joined with what the OpenRouter catalog says
// about it — the source for the reasoning-effort selectors in the agent editor
// and the Models settings panel. FAIL-OPEN, like the catalog check on
// allowlist adds: an unreachable catalog answers every entry with unknown
// capabilities rather than an error, and the UI falls back to offering the
// whole effort vocabulary.

export const modelCapabilityDtoSchema = z.object({
  provider: modelProviderSchema,
  modelId: z.string().min(1),
  /**
   * null = UNKNOWN, which is NOT the same as "supports nothing": no catalog
   * entry, an unreachable catalog, or a non-OpenRouter provider (Anthropic
   * publishes no such list). Clients must offer the full vocabulary on null,
   * never an empty selector.
   */
  supportedEfforts: z.array(reasoningEffortSchema).nullable(),
  /** The catalog's own default, when it names one inside supportedEfforts. */
  defaultEffort: reasoningEffortSchema.optional(),
  contextWindowTokens: z.number().int().positive().optional(),
});
export type ModelCapabilityDto = z.infer<typeof modelCapabilityDtoSchema>;

export const listModelCapabilitiesResponseSchema = z.object({
  models: z.array(modelCapabilityDtoSchema),
  /** False when the catalog could not be consulted — all efforts are null. */
  catalogAvailable: z.boolean(),
});
export type ListModelCapabilitiesResponse = z.infer<
  typeof listModelCapabilitiesResponseSchema
>;

// ── Agents CRUD ─────────────────────────────────────────────────────────────
//
//   GET    /workspaces/:workspaceId/agents           → ListAgentsResponse
//   POST   /workspaces/:workspaceId/agents           → CreateAgentResponse (201)
//   GET    /workspaces/:workspaceId/agents/:agentId  → GetAgentResponse
//   PATCH  /workspaces/:workspaceId/agents/:agentId  → UpdateAgentResponse
//   DELETE /workspaces/:workspaceId/agents/:agentId  → DeleteResourceResponse
//
// (Lifecycle routes — publish, build status, dry-run-compile, sessions — are
// documented at their schemas above.) Deleting an agent referenced by
// workflows or sessions answers 409 `agent_in_use` — the UI warns before
// deleting. NOTE the agent NAME feeds the content hash via its slug:
// renaming re-keys the world DB + JWT audience on the next publish, exactly
// like renaming a workflow used to.

const agentNameSchema = z.string().trim().min(1).max(120);

/**
 * Full agent row. `draft` is served AS STORED (jsonb, draft-lenient); use
 * {@link parseAgentDefinition} to get a shape-guarded definition.
 */
export const agentDtoSchema = z.object({
  id: productId,
  name: agentNameSchema,
  description: z.string().nullable(),
  /** Credentials owner (spec §2) — must remain a workspace member. */
  runAsUserId: authId,
  draft: z.record(z.string(), z.unknown()),
  publishedVersionId: productId.nullable(),
  /**
   * The CURRENT published version's definition (served as stored, like
   * `draft`); null while unpublished. This is what the server-side workflow
   * validator and dispatch resolve `@connection`/`@skill` references against
   * — clients mirroring dispatch behavior (the workflow builder's reference
   * sources, chat's resolved-model chips) MUST read this, not `draft`.
   */
  publishedDefinition: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type AgentDto = z.infer<typeof agentDtoSchema>;

/** List-item projection (no draft payload) + the fields the card grid renders. */
export const agentSummaryDtoSchema = z.object({
  id: productId,
  name: agentNameSchema,
  description: z.string().nullable(),
  runAsUserId: authId,
  publishedVersionId: productId.nullable(),
  /** When the current published version was created; null while unpublished. */
  publishedAt: isoTimestamp.nullable(),
  /** Build status of the published version; null while unpublished. */
  buildStatus: buildStatusSchema.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type AgentSummaryDto = z.infer<typeof agentSummaryDtoSchema>;

/** One immutable publish snapshot (`agent_versions` row). */
export const agentVersionDtoSchema = z.object({
  id: productId,
  agentId: productId,
  /** The AgentDefinition compiled into this version (served as stored). */
  definition: z.record(z.string(), z.unknown()),
  contentHash: z.string().min(1),
  compilerVersion: z.string().min(1),
  eveVersion: z.string().min(1),
  /** Resolved model routing baked into the artifact. */
  modelProvider: modelProviderSchema,
  modelId: z.string().min(1),
  buildStatus: buildStatusSchema,
  createdAt: isoTimestamp,
});
export type AgentVersionDto = z.infer<typeof agentVersionDtoSchema>;

/** Shape-guarded view of a stored draft/version definition; null when shape-invalid. */
export function parseAgentDefinition(
  definition: unknown,
): AgentDefinition | null {
  const parsed = agentDefinitionSchema.safeParse(definition);
  return parsed.success ? parsed.data : null;
}

export const createAgentRequestSchema = z.object({
  name: agentNameSchema,
  description: z.string().max(2000).optional(),
  /** Full definition draft; omitted = empty draft the editor fills in. */
  draft: agentDefinitionSchema.optional(),
  /** Defaults to the creator. */
  runAsUserId: authId.optional(),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const updateAgentRequestSchema = z
  .object({
    name: agentNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    runAsUserId: authId.optional(),
    /** Full replacement draft (the editor always writes whole definitions). */
    draft: agentDefinitionSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "update at least one field",
  });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

export const listAgentsResponseSchema = z.object({
  agents: z.array(agentSummaryDtoSchema),
});
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;

export const getAgentResponseSchema = z.object({ agent: agentDtoSchema });
export type GetAgentResponse = z.infer<typeof getAgentResponseSchema>;

export const createAgentResponseSchema = getAgentResponseSchema;
export type CreateAgentResponse = GetAgentResponse;

/**
 * A draft PATCH additionally carries dry-run-compile diagnostics (same
 * payload as the dry-run endpoint) so the editor gets validation for free
 * without a second round-trip. Omitted when the draft was not touched or the
 * dry run could not run (e.g. the object store was briefly down).
 */
export const updateAgentResponseSchema = getAgentResponseSchema.extend({
  diagnostics: dryRunCompileResponseSchema.optional(),
});
export type UpdateAgentResponse = z.infer<typeof updateAgentResponseSchema>;

// ── Workspace members ───────────────────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/members → ListWorkspaceMembersResponse
//
// Read-only list (settings → members; run-as pickers). Invitation/role
// mutations go through Better Auth's organization endpoints, not this API.

export const workspaceMemberDtoSchema = z.object({
  /** Better Auth member row id. */
  id: authId,
  userId: authId,
  name: z.string().nullable(),
  email: z.string().min(1),
  /** Better Auth role — see {@link WORKSPACE_ROLES} for the known set. */
  role: z.string().min(1),
  createdAt: isoTimestamp,
});
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberDtoSchema>;

export const listWorkspaceMembersResponseSchema = z.object({
  members: z.array(workspaceMemberDtoSchema),
});
export type ListWorkspaceMembersResponse = z.infer<
  typeof listWorkspaceMembersResponseSchema
>;

// ════════════════════════════════════════════════════════════════════════════
// PHASE 3 — TRIGGER INGRESS, INTEGRATIONS, TRIGGER BINDINGS, RUN CANCEL
// (docs/PLAN.md Phase 3; INITIAL-SPEC.md §8 dispatch path + §10 API surface)
// ════════════════════════════════════════════════════════════════════════════

// ── POST /runs/:id/cancel — stop a run ──────────────────────────────────────
//
// The Stop button. Cancels a queued/running/waiting run and lands it
// `canceled` — never `failed`: eve is explicit that cancellation is a USER
// DECISION, not an error. Idempotent: cancelling an already-terminal run
// returns its current state without error. Body is optional.
//
// eve 0.31 gives this a real remote leg (`POST /eve/v1/session/:id/cancel`;
// 202 accepted / 200 no_active_turn, both success). Cancellation is
// COOPERATIVE at durable step boundaries — a tool call already in flight runs
// to completion — and the turn then ends with `turn.cancelled` →
// `session.waiting`, which is what settles the run. UI copy must not promise
// that in-flight side effects are undone.

export const runCancelRequestSchema = z
  .object({
    /** Optional audit note recorded on the run (never shown to the model). */
    reason: z.string().min(1).max(500).optional(),
  })
  .optional();
export type RunCancelRequest = z.infer<typeof runCancelRequestSchema>;

export const runCancelResponseSchema = z.object({ run: runDtoSchema });
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;

// ── POST /t/:token — public webhook + form ingress ──────────────────────────
//
// The `:token` (plaintext, shown ONCE at creation) hashes to `triggers.token_hash`
// (SHA-256). The trigger's stored `type` decides how the body is read:
//   - webhook: the ENTIRE JSON body becomes TriggerEvent.data (arbitrary shape).
//   - form:    { values } matched against the bound form schema →
//              formSubmissionToTriggerData (see trigger-adapters.ts).
// Ingress enforces rate limits + payload caps BEFORE parsing (spec §8/§11).
// Response is 202 (async dispatch) — the run streams over GET /runs/:id/stream.

/** Public payload cap for `/t/:token` bodies (bytes). Enforced at ingress. */
export const TRIGGER_INGRESS_MAX_BODY_BYTES = 256 * 1024; // 256 KiB

/**
 * Webhook ingress body: any JSON OBJECT. Non-object bodies (arrays, scalars)
 * are rejected so `TriggerEvent.data` (a `Record`) is always well-formed.
 */
export const webhookIngressRequestSchema = z.record(z.string(), z.unknown());
export type WebhookIngressRequest = z.infer<typeof webhookIngressRequestSchema>;

/** Form ingress body: submitted field values keyed by the form field `key`. */
export const formIngressRequestSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});
export type FormIngressRequest = z.infer<typeof formIngressRequestSchema>;

/**
 * 202 ack for `/t/:token`. `runId`/`sessionId` let a caller poll or open the
 * SSE stream; a form UI shows a success state. Dispatch is async — presence of
 * ids does NOT imply the run has started.
 */
export const triggerIngressResponseSchema = z.object({
  accepted: z.literal(true),
  runId: productId,
  sessionId: productId,
});
export type TriggerIngressResponse = z.infer<
  typeof triggerIngressResponseSchema
>;

// ── POST /integrations/slack/events — Slack Events API ingress ───────────────
//
// One platform-level Slack app (spec §2 locked). Inbound events are
// signature-verified (v0 HMAC) with a 5-min replay window, then routed to the
// workspace/workflow by team_id + trigger binding. Retries carry x-slack-retry-*
// headers and MUST be de-duplicated (idempotency by event_id).

export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_RETRY_NUM_HEADER = "x-slack-retry-num";
export const SLACK_RETRY_REASON_HEADER = "x-slack-retry-reason";
/** Slack signing scheme version prefix (`v0=<hmac>`). */
export const SLACK_SIGNATURE_VERSION = "v0";
/** Reject events whose signed timestamp is older than this (spec §11). */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

/**
 * Slack channel types we distinguish. `im` = direct message to the app;
 * `channel`/`group`/`mpim` = a (possibly threaded) channel message.
 */
export const slackChannelTypeSchema = z.enum(["im", "channel", "group", "mpim"]);
export type SlackChannelType = z.infer<typeof slackChannelTypeSchema>;

/**
 * `app_mention` inner event — someone @-mentioned the app. `text` still
 * contains the leading `<@Uxxxx>` mention token; the adapter strips it.
 */
export const slackAppMentionEventSchema = z.object({
  type: z.literal("app_mention"),
  user: z.string().min(1).optional(),
  text: z.string().default(""),
  ts: z.string().min(1),
  channel: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  event_ts: z.string().min(1).optional(),
  /** Set when a bot authored the event — the adapter ignores these (loop guard). */
  bot_id: z.string().min(1).optional(),
});
export type SlackAppMentionEvent = z.infer<typeof slackAppMentionEventSchema>;

/**
 * `message` inner event — a DM (`channel_type: "im"`) or a channel/thread
 * message. `subtype`/`bot_id` mark edits/bot echoes the adapter ignores.
 */
export const slackMessageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  channel_type: slackChannelTypeSchema.optional(),
  user: z.string().min(1).optional(),
  text: z.string().optional(),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  event_ts: z.string().min(1).optional(),
  /** e.g. "message_changed", "message_deleted", "bot_message" — ignored. */
  subtype: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
  app_id: z.string().min(1).optional(),
});
export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>;

/** The inner events we consume off an event_callback. */
export const slackInnerEventSchema = z.discriminatedUnion("type", [
  slackAppMentionEventSchema,
  slackMessageEventSchema,
]);
export type SlackInnerEvent = z.infer<typeof slackInnerEventSchema>;

/** One entry of `event_callback.authorizations` — who the event is authed for. */
export const slackAuthorizationSchema = z.object({
  enterprise_id: z.string().nullable().optional(),
  team_id: z.string().nullable().optional(),
  user_id: z.string().min(1),
  is_bot: z.boolean().optional(),
  is_enterprise_install: z.boolean().optional(),
});
export type SlackAuthorization = z.infer<typeof slackAuthorizationSchema>;

/** Slack `event_callback` envelope — routes by `team_id`. */
export const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  /** Legacy verification token (do NOT authenticate on this — use signatures). */
  token: z.string().optional(),
  team_id: z.string().min(1),
  api_app_id: z.string().min(1).optional(),
  event: slackInnerEventSchema,
  event_id: z.string().min(1).optional(),
  event_time: z.number().int().optional(),
  authorizations: z.array(slackAuthorizationSchema).optional(),
});
export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;

/** Slack URL-verification handshake (sent once when the events URL is set). */
export const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  token: z.string().optional(),
  challenge: z.string().min(1),
});
export type SlackUrlVerification = z.infer<typeof slackUrlVerificationSchema>;

/** Full request body of `POST /integrations/slack/events`. */
export const slackWebhookBodySchema = z.discriminatedUnion("type", [
  slackUrlVerificationSchema,
  slackEventCallbackSchema,
]);
export type SlackWebhookBody = z.infer<typeof slackWebhookBodySchema>;

/** Response to the URL-verification handshake — echo the challenge verbatim. */
export const slackUrlVerificationResponseSchema = z.object({
  challenge: z.string().min(1),
});
export type SlackUrlVerificationResponse = z.infer<
  typeof slackUrlVerificationResponseSchema
>;

/** Ack for a consumed/ignored event_callback (Slack needs a fast 200). */
export const slackEventAckResponseSchema = z.object({ ok: z.literal(true) });
export type SlackEventAckResponse = z.infer<typeof slackEventAckResponseSchema>;

// ── Integrations (Slack install/list) ───────────────────────────────────────
//
//   GET  /workspaces/:workspaceId/integrations              → ListIntegrationsResponse
//   GET  /integrations/slack/install?workspaceId=…          → 302 to Slack OAuth
//   GET  /integrations/slack/callback?code=&state=          → upsert integration
//   DELETE /workspaces/:workspaceId/integrations/:id        → DeleteResourceResponse
//
// The bot token is envelope-encrypted onto `integrations.credentials_encrypted`
// and NEVER echoed (read DTO carries `hasCredentials` only). team_name /
// bot_user_id / scopes are non-secret metadata on `integrations.metadata`.

/** Non-secret Slack metadata stored on `integrations.metadata`. */
export const slackIntegrationMetadataSchema = z.object({
  teamName: z.string().min(1).optional(),
  botUserId: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).default([]),
});
export type SlackIntegrationMetadata = z.infer<
  typeof slackIntegrationMetadataSchema
>;

/**
 * Trimmed shape of Slack's `oauth.v2.access` response we consume at install
 * (raw-source DTO, like the registry DTOs). The install adapter splits this
 * into the encrypted `access_token` and the non-secret metadata above.
 */
export const slackOAuthAccessResultSchema = z.object({
  ok: z.literal(true),
  app_id: z.string().min(1).optional(),
  team: z.object({ id: z.string().min(1), name: z.string().min(1).optional() }),
  /** Bot user id (the app's identity in the workspace). */
  bot_user_id: z.string().min(1).optional(),
  /** SECRET: the bot access token (xoxb-…) — encrypt, never echo. */
  access_token: z.string().min(1),
  /** Space- or comma-separated granted scopes. */
  scope: z.string().default(""),
  token_type: z.string().optional(),
});
export type SlackOAuthAccessResult = z.infer<
  typeof slackOAuthAccessResultSchema
>;

/** OAuth redirect-back query on `/integrations/slack/callback`. */
export const slackOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  /** CSRF/state nonce carrying the workspace id (server-signed). */
  state: z.string().min(1),
  error: z.string().min(1).optional(),
});
export type SlackOAuthCallbackQuery = z.infer<
  typeof slackOAuthCallbackQuerySchema
>;

/** Installed integration (read). Secrets reduced to `hasCredentials`. */
export const integrationDtoSchema = z.object({
  id: productId,
  /** e.g. "slack". */
  type: z.string().min(1),
  /** Inbound routing key (Slack team_id). */
  externalId: z.string().min(1),
  /** Slack team name (from metadata; null when unknown). */
  teamName: z.string().nullable(),
  /** Slack bot user id (from metadata; null when unknown). */
  botUserId: z.string().nullable(),
  scopes: z.array(z.string().min(1)),
  hasCredentials: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type IntegrationDto = z.infer<typeof integrationDtoSchema>;

export const listIntegrationsResponseSchema = z.object({
  integrations: z.array(integrationDtoSchema),
});
export type ListIntegrationsResponse = z.infer<
  typeof listIntegrationsResponseSchema
>;

// ── Trigger bindings ────────────────────────────────────────────────────────
//
//   GET  /workflows/:workflowId/triggers                        → ListTriggerBindingsResponse
//   POST /workflows/:workflowId/triggers/webhook-token          → CreateWebhookTokenResponse (plaintext ONCE)
//   POST /workflows/:workflowId/triggers/:id/rotate-token       → CreateWebhookTokenResponse (plaintext ONCE)
//   PUT  /workflows/:workflowId/triggers/slack                  → GetTriggerBindingResponse
//
// A trigger row is created at publish from the workflow's trigger config. The
// webhook/form ingress token is GENERATED here, shown ONCE, and stored only as
// a SHA-256 hash on `triggers.token_hash` (secrets discipline). `tokenSuffix`
// (last 4 chars, non-secret) may be persisted in `triggers.binding` for display
// — no schema change needed.

/** Mirrors pgEnum `trigger_type`. */
export const triggerTypeSchema = z.enum([
  "manual",
  "form",
  "webhook",
  "slack",
  "schedule",
]);
export type TriggerTypeEnum = z.infer<typeof triggerTypeSchema>;

/** Trigger binding (read). No plaintext token — `tokenSuffix` for display only. */
export const triggerBindingDtoSchema = z.object({
  id: productId,
  workflowId: productId,
  type: triggerTypeSchema,
  enabled: z.boolean(),
  /** True when a webhook/form ingress token exists (webhook/form triggers). */
  hasToken: z.boolean(),
  /** Last 4 chars of the ingress token (display hint); null when none/unknown. */
  tokenSuffix: z.string().length(4).nullable(),
  /** Bound form field schema (form triggers); null otherwise. */
  formSchema: z.array(formFieldSchema).nullable(),
  /** Slack routing binding (slack triggers); null otherwise. */
  slackBinding: slackTriggerBindingSchema.nullable(),
  /** Integration this trigger routes through (slack); null otherwise. */
  integrationId: productId.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type TriggerBindingDto = z.infer<typeof triggerBindingDtoSchema>;

export const listTriggerBindingsResponseSchema = z.object({
  triggers: z.array(triggerBindingDtoSchema),
});
export type ListTriggerBindingsResponse = z.infer<
  typeof listTriggerBindingsResponseSchema
>;

export const getTriggerBindingResponseSchema = z.object({
  trigger: triggerBindingDtoSchema,
});
export type GetTriggerBindingResponse = z.infer<
  typeof getTriggerBindingResponseSchema
>;

/**
 * Response to minting/rotating a webhook/form ingress token. `token` is the
 * PLAINTEXT value — returned ONCE, never retrievable again (only its hash is
 * stored). Clients must surface it immediately (copy-to-clipboard) and warn it
 * won't be shown again. `ingressUrl` is the ready-to-use `POST /t/:token` URL.
 */
export const createWebhookTokenResponseSchema = z.object({
  triggerId: productId,
  /** Plaintext ingress token — shown ONCE. */
  token: z.string().min(1),
  /** Last 4 chars, for later display (also persisted, non-secret). */
  tokenSuffix: z.string().length(4),
  /** Fully-qualified `POST /t/:token` URL. */
  ingressUrl: z.string().min(1),
  createdAt: isoTimestamp,
});
export type CreateWebhookTokenResponse = z.infer<
  typeof createWebhookTokenResponseSchema
>;

/** Bind/point a Slack trigger at an installed integration + routing rules. */
export const updateSlackTriggerBindingRequestSchema = z.object({
  /** The installed Slack `integrations` row this workflow listens through. */
  integrationId: productId,
  binding: slackTriggerBindingSchema,
});
export type UpdateSlackTriggerBindingRequest = z.infer<
  typeof updateSlackTriggerBindingRequestSchema
>;
