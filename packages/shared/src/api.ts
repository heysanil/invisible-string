/**
 * API contracts (INITIAL-SPEC.md §10, docs/PLAN.md Phases 1–2): publish,
 * sessions, messages, run SSE frames, plus the full Phase-2 resource surface
 * (workflows CRUD, sessions list, run input, MCP connections + registry,
 * skills + attachments, model presets/allowlist, agent presets, members).
 * Single source of truth imported by apps/control-plane and apps/web —
 * neither side re-declares these.
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

import type { EveStreamEvent } from "./eve-events";
import { triggerEventSchema, type TriggerEvent } from "./trigger-event";
import {
  formFieldSchema,
  modelPresetSlugSchema,
  reasoningEffortSchema,
  slackTriggerBindingSchema,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "./workflow-definition";

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

/** Mirrors pgEnum `mcp_source`. */
export const mcpSourceSchema = z.enum(["registry", "custom"]);
export type McpSource = z.infer<typeof mcpSourceSchema>;

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
 *   `deepseek/deepseek-v4-flash`, `openai/gpt-5.2:extended`
 * - anthropic (native API) ids are hyphenated, NO vendor prefix, e.g.
 *   `claude-opus-4-8` — a slash means someone pasted a gateway/OpenRouter id
 */
export function modelIdShapeProblem(
  provider: ModelProvider,
  modelId: string,
): string | null {
  if (provider === "openrouter") {
    return /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?::[\w.-]+)?$/i.test(modelId)
      ? null
      : `"${modelId}" is not an OpenRouter model id — expected "vendor/model" (e.g. "deepseek/deepseek-v4-flash")`;
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

export const agentSessionDtoSchema = z.object({
  id: productId,
  workflowId: productId,
  workflowVersionId: productId,
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
  /** The normalized envelope that started this run (spec §8). */
  triggerEvent: TriggerEvent;
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

// ── POST /workspaces/:workspaceId/workflows/:wfId/publish ───────────────────

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

export const publishWorkflowResponseSchema = z.object({
  workflowId: productId,
  versionId: productId,
  contentHash: z.string().min(1),
  buildStatus: buildStatusSchema,
  cached: z.boolean(),
  buildError: z.string().nullable(),
});

type _PublishLockstep = [
  z.infer<typeof publishWorkflowResponseSchema> extends PublishWorkflowResponse
    ? true
    : never,
  PublishWorkflowResponse extends z.infer<typeof publishWorkflowResponseSchema>
    ? true
    : never,
];
const _publishLockstep: _PublishLockstep = [true, true];
void _publishLockstep;

// ── GET /workspaces/:workspaceId/workflows/:wfId/versions/:versionId/build ──

/**
 * Build status of a workflow version. The builder polls this after an async
 * publish (a fresh build answers "building" and progresses in the background)
 * so the rail can flip from "Building…" to the ready/error chip.
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

// ── POST /workspaces/:workspaceId/workflows/:wfId/versions/dry-run-compile ──

/**
 * Dry-run compile of the CURRENT draft (no rows written). Compile problems
 * are the PAYLOAD of a dry run (`ok: false`), not a failed request — the
 * builder renders them inline next to the pillar cards.
 */
export const dryRunCompileResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), contentHash: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: apiErrorInfoSchema }),
]);
export type DryRunCompileResponse = z.infer<typeof dryRunCompileResponseSchema>;

// ── POST /workspaces/:workspaceId/workflows/:wfId/sessions ──────────────────

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

export const createSessionResponseSchema = z.object({
  session: agentSessionDtoSchema,
  run: runDtoSchema,
});

// ── POST /sessions/:id/messages ─────────────────────────────────────────────

/**
 * Follow-up message → continues the same eve session (new run). One run at a
 * time per session: while a run is queued/running the server answers 409
 * `session_busy` — the UI must surface this gracefully (disable composer /
 * offer retry), never crash.
 */
export const postMessageRequestSchema = z.object({
  message: z.string().min(1),
});

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

export interface PostMessageResponse {
  run: RunDto;
}

export const postMessageResponseSchema = z.object({ run: runDtoSchema });

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
// only run_events with seq > Last-Event-ID (mirrors eve's own `?startIndex=`
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

/**
 * No further SSE frames arrive for a run in this status — the server closes
 * the stream after sending it. NOTE `waiting` IS stream-terminal: a parked
 * run emits nothing further until `POST /runs/:id/input` resumes it, after
 * which clients re-open the stream (replay via Last-Event-ID is seamless).
 */
export function isRunStreamTerminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — resource CRUD surface
// ═════════════════════════════════════════════════════════════════════════════

// ── Workflows CRUD ──────────────────────────────────────────────────────────
//
//   GET    /workspaces/:workspaceId/workflows                → ListWorkflowsResponse
//   POST   /workspaces/:workspaceId/workflows                → CreateWorkflowResponse (201)
//   GET    /workspaces/:workspaceId/workflows/:wfId          → GetWorkflowResponse
//   PATCH  /workspaces/:workspaceId/workflows/:wfId          → UpdateWorkflowResponse
//   DELETE /workspaces/:workspaceId/workflows/:wfId          → DeleteResourceResponse
//
// Deleting a workflow cascades to versions/sessions/runs (DB FKs) — the UI
// confirms destructive intent before calling.

const workflowNameSchema = z.string().trim().min(1).max(200);

/** List-item projection (no draft payload). */
export const workflowSummaryDtoSchema = z.object({
  id: productId,
  name: workflowNameSchema,
  /** Credentials owner (spec §2) — must remain a workspace member. */
  runAsUserId: authId,
  publishedVersionId: productId.nullable(),
  /**
   * `draft.trigger.type` surfaced for list chips; null while the draft has
   * no shape-valid trigger yet.
   */
  triggerType: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WorkflowSummaryDto = z.infer<typeof workflowSummaryDtoSchema>;

/**
 * Full workflow row. `draft` is served AS STORED (jsonb, draft-lenient —
 * legacy rows may predate the WorkflowDefinition schema); use
 * {@link parseWorkflowDraft} to get a shape-guarded definition.
 */
export const workflowDtoSchema = workflowSummaryDtoSchema.extend({
  draft: z.record(z.string(), z.unknown()),
});
export type WorkflowDto = z.infer<typeof workflowDtoSchema>;

/** Shape-guarded view of a stored draft; null when empty or shape-invalid. */
export function parseWorkflowDraft(draft: unknown): WorkflowDefinition | null {
  const parsed = workflowDefinitionSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

export const createWorkflowRequestSchema = z.object({
  name: workflowNameSchema,
  /** Full four-pillar draft; omitted = empty draft the builder fills in. */
  draft: workflowDefinitionSchema.optional(),
  /** Defaults to the creator. */
  runAsUserId: authId.optional(),
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;

export const updateWorkflowRequestSchema = z
  .object({
    name: workflowNameSchema.optional(),
    runAsUserId: authId.optional(),
    /** Full replacement draft (the builder always writes whole definitions). */
    draft: workflowDefinitionSchema.optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.runAsUserId !== undefined ||
      patch.draft !== undefined,
    { message: "update at least one of name, runAsUserId, draft" },
  );
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>;

export const listWorkflowsResponseSchema = z.object({
  workflows: z.array(workflowSummaryDtoSchema),
});
export type ListWorkflowsResponse = z.infer<typeof listWorkflowsResponseSchema>;

export const getWorkflowResponseSchema = z.object({
  workflow: workflowDtoSchema,
});
export type GetWorkflowResponse = z.infer<typeof getWorkflowResponseSchema>;

export const createWorkflowResponseSchema = getWorkflowResponseSchema;
export type CreateWorkflowResponse = GetWorkflowResponse;

/**
 * A draft PATCH additionally carries dry-run-compile diagnostics (same payload
 * as the dry-run endpoint) so the builder gets validation for free without a
 * second round-trip. Omitted when the draft was not touched or the dry run
 * could not run (e.g. the object store was briefly down).
 */
export const updateWorkflowResponseSchema = getWorkflowResponseSchema.extend({
  diagnostics: dryRunCompileResponseSchema.optional(),
});
export type UpdateWorkflowResponse = z.infer<typeof updateWorkflowResponseSchema>;

// ── Sessions list ───────────────────────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/sessions?workflowId=&status= → ListSessionsResponse
//
// Ordered by lastActivityAt descending (the chat list).

export const listSessionsQuerySchema = z.object({
  /** Restrict to one workflow (the workflow's session history panel). */
  workflowId: productId.optional(),
  status: agentSessionStatusSchema.optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

/** Session list item: DTO + the fields the chat list renders. */
export const agentSessionSummaryDtoSchema = agentSessionDtoSchema.extend({
  workflowName: z.string(),
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
// Answers an `input.requested` frame (approval card / question). Forwarded to
// eve as `inputResponses: [{requestId, optionId? , text?}]`; the parked run
// resumes and the client re-opens the SSE stream.

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

// ── MCP connections (CONTEXT pillar) ────────────────────────────────────────
//
// BOTH scopes (spec §9 — "Both workspace- and user-level required"):
//   workspace: /workspaces/:workspaceId/mcp-connections[...]
//   user:      /me/mcp-connections[...]
//
//   GET    <base>                 → ListMcpConnectionsResponse
//   POST   <base>                 → GetMcpConnectionResponse (201; custom URL)
//   POST   <base>/install         → GetMcpConnectionResponse (201; from registry)
//   GET    <base>/:id             → GetMcpConnectionResponse
//   PATCH  <base>/:id             → GetMcpConnectionResponse
//   DELETE <base>/:id             → DeleteResourceResponse

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
 * {@link McpConnectionDto.hasCredentials} only.
 *
 * - none    → clears any stored credentials
 * - bearer  → `values.token` becomes the connection's bearer token
 * - headers → `values` = header name → header VALUE (each stored encrypted)
 */
export const mcpAuthWriteSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
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

export const mcpConnectionDtoSchema = z.object({
  id: productId,
  scope: resourceScopeSchema,
  name: z.string().min(1),
  /** Model-facing summary — eve's connection_search routes on it. */
  description: z.string().nullable(),
  source: mcpSourceSchema,
  /** registry.modelcontextprotocol.io server name (source = registry). */
  registryId: z.string().nullable(),
  url: z.string().nullable(),
  toolAllow: z.array(z.string()).nullable(),
  toolBlock: z.array(z.string()).nullable(),
  approvalPolicy: mcpApprovalPolicySchema.nullable(),
  enabled: z.boolean(),
  /** True when encrypted credentials are stored. Secrets are never echoed. */
  hasCredentials: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type McpConnectionDto = z.infer<typeof mcpConnectionDtoSchema>;

/** Create a CUSTOM-URL connection (registry installs use .../install). */
export const createMcpConnectionRequestSchema = z
  .object({
    name: mcpConnectionNameSchema,
    description: z.string().max(2000).optional(),
    url: httpUrlSchema,
    auth: mcpAuthWriteSchema.optional(),
    toolAllow: toolNameListSchema.optional(),
    toolBlock: toolNameListSchema.optional(),
    approvalPolicy: mcpApprovalPolicySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(refineToolFilter, { message: TOOL_FILTER_MESSAGE });
export type CreateMcpConnectionRequest = z.infer<
  typeof createMcpConnectionRequestSchema
>;

/**
 * Partial update. `auth` semantics: omitted = keep stored credentials;
 * `{type:"none"}` = clear; bearer/headers = replace. Explicit nulls clear
 * the nullable fields.
 */
export const updateMcpConnectionRequestSchema = z
  .object({
    name: mcpConnectionNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    url: httpUrlSchema.optional(),
    auth: mcpAuthWriteSchema.optional(),
    toolAllow: toolNameListSchema.nullable().optional(),
    toolBlock: toolNameListSchema.nullable().optional(),
    approvalPolicy: mcpApprovalPolicySchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "update at least one field",
  })
  .refine(refineToolFilter, { message: TOOL_FILTER_MESSAGE });
export type UpdateMcpConnectionRequest = z.infer<
  typeof updateMcpConnectionRequestSchema
>;

export const listMcpConnectionsResponseSchema = z.object({
  connections: z.array(mcpConnectionDtoSchema),
});
export type ListMcpConnectionsResponse = z.infer<
  typeof listMcpConnectionsResponseSchema
>;

export const getMcpConnectionResponseSchema = z.object({
  connection: mcpConnectionDtoSchema,
});
export type GetMcpConnectionResponse = z.infer<
  typeof getMcpConnectionResponseSchema
>;

// ── MCP registry proxy ──────────────────────────────────────────────────────
//
//   GET /mcp-registry/search?q= → RegistrySearchResponse
//
// The control plane proxies registry.modelcontextprotocol.io
// (`GET /v0.1/servers?search=&version=latest`, active/latest filtered) and
// TRIMS each server to this DTO — the UI never talks to the registry
// directly and never sees fields we don't render.

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

export const registrySearchResponseSchema = z.object({
  servers: z.array(registryServerSummarySchema),
});
export type RegistrySearchResponse = z.infer<
  typeof registrySearchResponseSchema
>;

/**
 * Install a registry server as an MCP connection
 * (`POST <mcp-connections base>/install`, both scopes). The UI picks one of
 * the server's `remotes[].url`; secret values collected from the
 * declarations travel in `auth` and are encrypted server-side.
 */
export const installMcpConnectionRequestSchema = z
  .object({
    /** RegistryServerSummary.name. */
    registryName: z.string().min(1),
    /** Registry version installed; server resolves "latest" when omitted. */
    version: z.string().min(1).optional(),
    /** The chosen remotes[].url. */
    remoteUrl: httpUrlSchema,
    /** Display name override; defaults to the server's title/name. */
    name: mcpConnectionNameSchema.optional(),
    description: z.string().max(2000).optional(),
    auth: mcpAuthWriteSchema.optional(),
    toolAllow: toolNameListSchema.optional(),
    toolBlock: toolNameListSchema.optional(),
    approvalPolicy: mcpApprovalPolicySchema.optional(),
  })
  .refine(refineToolFilter, { message: TOOL_FILTER_MESSAGE });
export type InstallMcpConnectionRequest = z.infer<
  typeof installMcpConnectionRequestSchema
>;

// ── Skills (CONTEXT pillar) ─────────────────────────────────────────────────
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

export const modelPresetDtoSchema = z.object({
  id: productId,
  slug: modelPresetSlugSchema,
  provider: modelProviderSchema,
  modelId: z.string().min(1),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ModelPresetDto = z.infer<typeof modelPresetDtoSchema>;

export const updateModelPresetRequestSchema = z.object({
  provider: modelProviderSchema,
  /** Must be on the workspace allowlist (422 `model_not_allowlisted`). */
  modelId: z.string().min(1),
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

// ── Agent presets (AGENT pillar) ────────────────────────────────────────────
//
//   GET    /workspaces/:workspaceId/agents      → ListAgentPresetsResponse
//   POST   /workspaces/:workspaceId/agents      → GetAgentPresetResponse (201)
//   GET    /workspaces/:workspaceId/agents/:id  → GetAgentPresetResponse
//   PATCH  /workspaces/:workspaceId/agents/:id  → GetAgentPresetResponse
//   DELETE /workspaces/:workspaceId/agents/:id  → DeleteResourceResponse
//
// Deleting a preset referenced by workflow drafts makes those drafts fail
// publish with `agent_preset_not_found` — the UI warns before deleting.

export const agentPresetDtoSchema = z.object({
  id: productId,
  name: z.string().min(1),
  description: z.string().nullable(),
  /** Persona block prepended to compiled instructions.md. */
  basePrompt: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
  /** Workspace model preset this agent resolves through. */
  modelPreset: modelPresetSlugSchema,
  /** Specific-model override (wins over modelPreset; allowlist-checked). */
  modelId: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type AgentPresetDto = z.infer<typeof agentPresetDtoSchema>;

const agentPresetNameSchema = z.string().trim().min(1).max(120);

export const createAgentPresetRequestSchema = z.object({
  name: agentPresetNameSchema,
  description: z.string().max(2000).optional(),
  basePrompt: z.string().min(1).max(50_000),
  reasoningEffort: reasoningEffortSchema.default("medium"),
  modelPreset: modelPresetSlugSchema.default("balanced"),
  modelId: z.string().min(1).optional(),
});
export type CreateAgentPresetRequest = z.infer<
  typeof createAgentPresetRequestSchema
>;

export const updateAgentPresetRequestSchema = z
  .object({
    name: agentPresetNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    basePrompt: z.string().min(1).max(50_000).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    modelPreset: modelPresetSlugSchema.optional(),
    /** null clears the specific-model override. */
    modelId: z.string().min(1).nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "update at least one field",
  });
export type UpdateAgentPresetRequest = z.infer<
  typeof updateAgentPresetRequestSchema
>;

export const listAgentPresetsResponseSchema = z.object({
  agents: z.array(agentPresetDtoSchema),
});
export type ListAgentPresetsResponse = z.infer<
  typeof listAgentPresetsResponseSchema
>;

export const getAgentPresetResponseSchema = z.object({
  agent: agentPresetDtoSchema,
});
export type GetAgentPresetResponse = z.infer<typeof getAgentPresetResponseSchema>;

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

// ── POST /runs/:id/cancel — abort a run ─────────────────────────────────────
//
// Aborts a queued/running/waiting run (dispatcher issues eve cancel + flips
// status to `canceled`). Idempotent: cancelling an already-terminal run
// returns its current state without error. Body is optional.

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
// A trigger row is created at publish from the workflow's TRIGGER pillar. The
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
