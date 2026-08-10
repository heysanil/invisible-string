/**
 * Runtime API — agent lifecycle + chat sessions + runs (agents-first
 * redesign: the AGENT is the compile unit; workflows have no builds).
 *
 * - POST /workspaces/:workspaceId/agents/:agentId/publish
 *     snapshot the agent's draft → immutable agent_versions row (idempotent
 *     by content hash) → kick the build → respond with version + build status.
 * - GET  /workspaces/:workspaceId/agents/:agentId/versions/:versionId/build
 *     build status the agent editor polls after an async publish.
 * - POST /workspaces/:workspaceId/agents/:agentId/dry-run-compile
 *     compile the draft without persisting; structured errors for the editor.
 * - POST /workspaces/:workspaceId/agents/:agentId/sessions {message}
 *     chat: requires a published agent + ready build → scheduler picks a live
 *     worker → ensure-agent (artifact URL + env) → POST eve session (platform
 *     JWT, 202) → persist agent_sessions + runs → start the NDJSON tailer.
 *     Chat sessions carry `workflowId: null`.
 * - POST /workspaces/:workspaceId/workflows/:wfId/run {message?, data?}
 *     manual "Run now": dispatch the workflow's published snapshot through
 *     the shared trigger-dispatch path (renders the task message).
 * - POST /sessions/:id/messages {message} — ID-addressed follow-up, new run.
 * - GET  /sessions/:id — session + runs.
 * - POST /runs/:id/input — HITL answer; POST /runs/:id/cancel — Stop (fronts
 *     eve's real `POST /eve/v1/session/:id/cancel`).
 * - POST /sessions/:id/clear | /compact — eve context controls (in place).
 * - POST /sessions/:id/reset — DESTRUCTIVE: retires the eve session id and
 *     mints a replacement `agent_sessions` row.
 * - GET  /runs/:id/stream — resumable SSE (Last-Event-ID) over run_events.
 *
 * OWNERSHIP (PLAN correction 8): eve does not enforce session ownership.
 * Every route resolves workspace membership via the workspace macro AND
 * checks the row's organizationId — cross-workspace ids surface as 404
 * (existence-hiding; the macro itself 403s callers addressing a workspace
 * path that is not their active workspace).
 */
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { Elysia } from "elysia";
import { decodeJwt, jwtVerify } from "jose";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  createSessionRequestSchema,
  postMessageRequestSchema,
  resetSessionRequestSchema,
  runCancelRequestSchema,
  runInputRequestSchema,
  runWorkflowRequestSchema,
  type AgentDefinition,
  type AgentSessionDto,
  type BuildStatusResponse,
  type EveInputResponse,
  type PublishAgentResponse,
  type ResetSessionResponse,
  type RunCancelResponse,
  type RunDto,
  type SessionContextControlResponse,
  type SessionContextControlStatus,
  type Logger,
  type TriggerEvent,
  type MasterKey,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import type { ArtifactStore } from "../artifacts";
import type { BuildService, BuildStore } from "../build/service";
import { type CompileAgentFn } from "../build/compiler-contract";
import { worldNameForHash, worldUrlFor } from "../build/world";
import { RunEventBus } from "../runs/bus";
import type { DeliveryService } from "../runs/delivery";
import { createRunSseResponse, parseLastEventId } from "../runs/sse";
import type { RunStore } from "../runs/store";
import type { RunTailerManager } from "../runs/tailer";
import { loadPublishedWorkflow } from "../resources/workflows";
import { workspacePlugin, type WorkspaceDeps } from "../workspace";
import { buildAgentEnv, decryptMcpEnv } from "./agent-env";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import {
  compileOrThrow,
  dryRunCompile,
  parseAgentDefinition,
  resolveCompileInputs,
  type CompileServiceDeps,
} from "./compile-service";
import type { RuntimeConfig } from "./config";
import { dispatchTriggerRun } from "./dispatch";
import { getAccessToken, type TokenLifecycleDeps } from "../oauth/tokens";
import { errors, isRuntimeApiError, RuntimeApiError } from "./errors";
import {
  agentJwtParams,
  derivePlatformJwtSecret,
  mintPlatformJwt,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "./jwt";
import {
  createDrizzleMetricsReader,
  metricsPlugin,
  type MetricsRegistry,
} from "./metrics";
import { selectWorker } from "./scheduler";
import { isEveSessionNotActiveError, type WorkerClient } from "./worker-client";
import { workerRegistryPlugin } from "./workers";

export interface RuntimeDeps {
  db: Db;
  runtime: RuntimeConfig;
  masterKey: MasterKey | undefined;
  workspaceDeps: WorkspaceDeps;
  artifacts: ArtifactStore;
  buildService: BuildService;
  buildStore: BuildStore;
  compile: CompileAgentFn;
  workerClient: WorkerClient;
  runStore: RunStore;
  bus: RunEventBus;
  tailers: RunTailerManager;
  /**
   * Outbound reply delivery (runs/delivery.ts). Optional so focused test
   * fixtures need not wire it; createRuntimeDeps always does — the tailer's
   * onFinish hook and boot recovery (reconcileInterruptedRuns) consume it.
   */
  delivery?: DeliveryService;
  /**
   * OAuth token lifecycle deps (oauth/tokens.ts) behind the agent-facing
   * POST /internal/connections/token route. Optional so focused test fixtures
   * need not wire it; createAppStack always does — the OAuth broker deps
   * satisfy it structurally, so both surfaces share ONE guarded egress fetch
   * and ONE master key. Unwired ⇒ the route answers 503.
   */
  oauthTokens?: TokenLifecycleDeps;
  /** In-process fleet metrics (GET /internal/metrics). */
  metrics: MetricsRegistry;
  /** Structured, redaction-safe logger (correlation ids threaded per call). */
  logger: Logger;
}

// ── row loading + ownership ─────────────────────────────────────────────────

type AgentRow = typeof schema.agents.$inferSelect;
type AgentVersionRow = typeof schema.agentVersions.$inferSelect;
type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

export async function loadAgentOwned(
  db: Db,
  organizationId: string,
  agentId: string,
): Promise<AgentRow> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("agent");
  return row;
}

async function loadSessionOwned(
  db: Db,
  organizationId: string,
  sessionId: string,
): Promise<SessionRow> {
  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.sessionNotFound();
  return row;
}

async function loadRunOwned(
  db: Db,
  organizationId: string,
  runId: string,
): Promise<{ run: RunRow; session: SessionRow }> {
  const rows = await db
    .select({ run: schema.runs, session: schema.agentSessions })
    .from(schema.runs)
    .innerJoin(
      schema.agentSessions,
      eq(schema.runs.agentSessionId, schema.agentSessions.id),
    )
    .where(
      and(
        eq(schema.runs.id, runId),
        eq(schema.agentSessions.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.runNotFound();
  return row;
}

// ── compile-input resolution ────────────────────────────────────────────────
//
// parseAgentDefinition / resolveCompileInputs / compileOrThrow live in
// compile-service.ts (shared with the agent editor's draft validation).

/** The compile-service deps view of a RuntimeDeps (db + secrets + store). */
function compileServiceDeps(deps: RuntimeDeps): CompileServiceDeps {
  return {
    db: deps.db,
    masterKey: deps.masterKey,
    artifacts: deps.artifacts,
    compile: deps.compile,
  };
}

// ── DTO mapping ─────────────────────────────────────────────────────────────

export function sessionDto(row: SessionRow): AgentSessionDto {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersionId: row.agentVersionId,
    workflowId: row.workflowId,
    origin: row.origin,
    status: row.status,
    eveSessionId: row.eveSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function runDto(row: RunRow): RunDto {
  return {
    id: row.id,
    agentSessionId: row.agentSessionId,
    status: row.status,
    triggerEvent: row.triggerEvent as unknown as TriggerEvent,
    taskMessage: row.taskMessage,
    deliveryStatus: row.deliveryStatus,
    eveRunId: row.eveRunId,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseBody<T>(schemaLike: { safeParse(v: unknown): { success: boolean; data?: T; error?: { issues: unknown } } }, body: unknown): T {
  const result = schemaLike.safeParse(body);
  if (!result.success || result.data === undefined) {
    throw new RuntimeApiError(422, "invalid_body", "request body failed validation", result.error?.issues);
  }
  return result.data;
}

// ── dispatch helpers ────────────────────────────────────────────────────────

/**
 * A published agent version whose build succeeded — everything a dispatch
 * path needs: the immutable version row (content hash + compiled-in
 * provider/model), its parsed AgentDefinition (context ids drive env
 * assembly), and the artifact to ensure on a worker.
 */
export interface ReadyAgentVersion {
  version: AgentVersionRow;
  definition: AgentDefinition;
  artifactKey: string;
}

/** The agent version must exist and have a succeeded build + artifact. */
export async function requireReadyAgentVersion(
  deps: RuntimeDeps,
  versionId: string,
): Promise<ReadyAgentVersion> {
  const rows = await deps.db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.id, versionId))
    .limit(1);
  const version = rows[0];
  if (!version) throw errors.agentNotPublished();
  const build = await deps.buildStore.get(version.contentHash);
  if (!build || build.status !== "succeeded" || !build.artifactKey) {
    throw errors.versionNotReady(build?.status ?? version.buildStatus);
  }
  const definition = parseAgentDefinition(version.definition);
  return { version, definition, artifactKey: build.artifactKey };
}

/**
 * ensure-agent on the picked worker with the version's full env. The provider
 * key matches the version's COMPILED-IN provider (`agent_versions.model_provider`
 * — resolved at publish; dispatch never re-resolves), and MCP secrets are
 * decrypted from the definition's own context. Agent env is identical across
 * every dispatch path — chat, workflow triggers, failover.
 */
export async function ensureAgentOnWorker(
  deps: RuntimeDeps,
  worker: { id: string; address: string },
  ready: ReadyAgentVersion,
  organizationId: string,
): Promise<void> {
  void organizationId; // ownership was checked when the caller resolved the version
  const hash = ready.version.contentHash;
  const mcpEnv = await decryptMcpEnv(
    deps.db,
    deps.masterKey,
    ready.definition.context.mcpConnectionIds,
  );
  const env = buildAgentEnv({
    runtime: deps.runtime,
    worldUrl: worldUrlFor(deps.runtime.worldDatabaseUrl, worldNameForHash(hash)),
    contentHash: hash,
    provider: ready.version.modelProvider,
    mcpEnv,
  });
  try {
    await deps.workerClient.ensureAgent(worker.address, hash, {
      artifactUrl: deps.artifacts.presignGetUrl(ready.artifactKey),
      env,
      workerId: worker.id,
    });
  } catch (error) {
    throw errors.workerDispatchFailed(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function startTail(
  deps: RuntimeDeps,
  workerAddress: string,
  contentHash: string,
  eveSessionId: string,
  runId: string,
  agentSessionId: string,
): void {
  const { secret, audience } = agentJwtParams(
    deps.runtime.platformJwtSecret,
    contentHash,
  );
  deps.tailers.start({
    runId,
    agentSessionId,
    // `options` carries the tailer's per-connect stream flags (today:
    // includeTailIndex for the bounded catch-up read). The DECISION is the
    // tailer's — call sites stay ignorant of it.
    openStream: async (startIndex, signal, streamOptions) =>
      deps.workerClient.openEventStream(
        workerAddress,
        contentHash,
        // Minted per (re)connect — short-lived tokens must not expire a
        // resume. Secret + audience are bound to this version's hash.
        await mintPlatformJwt(secret, { audience, claims: { runId } }),
        eveSessionId,
        startIndex,
        signal,
        streamOptions,
      ),
    // Real remote cancellation (eve 0.31): the tailer calls this before it
    // stops reading so the agent's turn actually ends instead of burning
    // tokens against a stream nobody is consuming.
    cancelRemoteTurn: async (options) => {
      await deps.workerClient.cancelEveTurn(
        workerAddress,
        contentHash,
        await mintPlatformJwt(secret, { audience, claims: { runId } }),
        eveSessionId,
        // Forward the tail's observed turn id as eve's stale-request guard.
        // Without it a late cancel can stop a follow-up turn instead of the
        // one the user stopped — the run is finalized without awaiting this
        // request, which frees the session's run slot immediately.
        options?.turnId === undefined ? undefined : { turnId: options.turnId },
      );
    },
  });
}

/**
 * Mark a pre-inserted run (and optionally its brand-new session) failed when
 * the worker dispatch after it could not complete. The rows stay visible —
 * a control-plane failure mid-dispatch leaves an auditable, cap-counted
 * record instead of an invisible orphaned eve session (202-async window).
 */
export async function failDispatch(
  deps: RuntimeDeps,
  runId: string,
  error: unknown,
  options: { failSessionId?: string } = {},
): Promise<never> {
  const detail = error instanceof Error ? error.message : String(error);
  await deps.runStore.markRun(runId, {
    status: "failed",
    error: `dispatch failed: ${detail}`,
    completedAt: new Date(),
  });
  if (options.failSessionId) {
    await deps.runStore.markSession(options.failSessionId, "error");
  }
  // Settle a pending outbound-reply marker NOW (slack-origin runs are born
  // owing one): the tailer hook never fires for a run that failed before its
  // tail started, and only the boot sweep would otherwise clear it. deliver()
  // no-ops for runs owing nothing and never throws.
  await deps.delivery?.deliver({
    runId,
    status: "failed",
    lastAssistantMessage: null,
  });
  if (isRuntimeApiError(error)) throw error;
  throw errors.workerDispatchFailed(detail);
}

/**
 * `failDispatch` for the eve session plane: the same failure bookkeeping, plus
 * the EVE-DRIVEN EVICTION that eve 0.31 makes necessary.
 *
 * eve answers 409 `session_not_active` for unknown, terminal, timed-out AND
 * reset sessions — permanently, and its truth can diverge from
 * `agent_sessions.status` indefinitely (a 30-day session timeout emits
 * `session.completed` into a stream nobody is tailing; a `reset` retires the
 * id). Left alone, that 409 would collapse into a generic 502
 * `worker_dispatch_failed` and the platform row would stay `active` forever:
 * a chat thread that can never send again, or a Slack thread whose key is
 * never released.
 *
 * So: mark the session `closed` (which also frees `slack_thread_key`) and fail
 * the run with the typed, permanent {@link errors.sessionNotActive}. Never
 * `session_busy` — that code's drop-and-retry recovery is exactly wrong here.
 */
export async function failEveDispatch(
  deps: RuntimeDeps,
  runId: string,
  agentSessionId: string,
  error: unknown,
  options: { failSessionId?: string } = {},
): Promise<never> {
  if (isEveSessionNotActiveError(error)) {
    await deps.runStore.markSession(agentSessionId, "closed");
    deps.logger.warn("dispatch.session_not_active", {
      fields: { runId, sessionId: agentSessionId, evicted: true },
    });
    return failDispatch(deps, runId, errors.sessionNotActive());
  }
  return failDispatch(deps, runId, error, options);
}

/**
 * Everything an eve CONTROL call needs: the session's pinned version ensured
 * on a live worker, plus a freshly minted platform JWT for that hash.
 *
 * Control routes ensure-agent exactly like a dispatch does — a session whose
 * agent has been reaped (idle stop) must boot again before it can be told to
 * clear/compact/reset, otherwise the call 404s at the worker proxy.
 *
 * `ensure: false` is the CANCEL exception. Cancelling asks a RUNNING turn to
 * stop; if the agent is not up, there is by definition no turn to cancel, so
 * booting one (artifact pull + extract + node boot, up to 60 s x 2 attempts)
 * only to have eve answer `no_active_turn` makes the user's Stop hang for a
 * minute to accomplish nothing. Without the ensure, an absent agent simply
 * 404s at the proxy and the best-effort caller swallows it — the correct
 * outcome, reached immediately.
 */
async function sessionControlTarget(
  deps: RuntimeDeps,
  organizationId: string,
  session: SessionRow,
  options: { ensure?: boolean } = {},
): Promise<{ workerId: string; workerAddress: string; hash: string; token: string }> {
  const ready = await requireReadyAgentVersion(deps, session.agentVersionId);
  const hash = ready.version.contentHash;
  const { worker } = await selectWorker(deps.db, {
    heartbeatTtlMs: deps.runtime.workerHeartbeatTtlMs,
    defaultMaxAgents: deps.runtime.maxAgentsPerWorker,
    versionHash: hash,
    affinityWorkerId: session.affinityWorkerId,
  });
  if (options.ensure !== false) {
    await ensureAgentOnWorker(deps, worker, ready, organizationId);
  }
  const jwt = agentJwtParams(deps.runtime.platformJwtSecret, hash);
  return {
    workerId: worker.id,
    workerAddress: worker.address,
    hash,
    token: await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
  };
}

/**
 * Fire eve's turn cancel for a session, swallowing every failure.
 *
 * Used on the no-live-tail cancel path. Deliberately best-effort: the
 * platform-side cancellation is authoritative for the run row, and a
 * dead/unreachable worker must not turn a user's Stop into a 502. A session
 * that never reached eve (`eve_session_id` null) has nothing to cancel.
 */
async function cancelEveTurnBestEffort(
  deps: RuntimeDeps,
  session: SessionRow,
): Promise<void> {
  if (!session.eveSessionId) return;
  try {
    const target = await sessionControlTarget(
      deps,
      session.organizationId,
      session,
      { ensure: false },
    );
    await deps.workerClient.cancelEveTurn(
      target.workerAddress,
      target.hash,
      target.token,
      session.eveSessionId,
    );
  } catch (error) {
    deps.logger.warn("run.cancel_remote_failed", {
      fields: {
        sessionId: session.id,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Guard shared by the three context-control routes: the session must be live
 * (non-terminal, with an eve session id) and QUIET.
 *
 * Quiet matters — clearing or compacting mid-turn would race the running turn
 * and land `context.cleared`/`compaction.*` inside another run's event log,
 * and resetting mid-turn would retire the very session id the live tail is
 * reading. `session_busy` is the right code here: it is the platform's own
 * transient serialization guard, and the recovery genuinely is "Stop the run
 * (or wait), then try again".
 */
async function requireQuietControllableSession(
  deps: RuntimeDeps,
  session: SessionRow,
): Promise<string> {
  if (
    !session.eveSessionId ||
    session.status === "closed" ||
    session.status === "error"
  ) {
    throw errors.sessionNotContinuable();
  }
  if ((await countDispatchingRuns(deps.db, session.id)) > 0) {
    throw errors.sessionBusy();
  }
  return session.eveSessionId;
}

/**
 * Count the session's active runs (session-serialization guard). `waiting`
 * counts as busy: a parked HITL run still owns the eve session's turn — a new
 * message dispatched into a parked session would create a SECOND tail on the
 * same NDJSON stream once the approval resumes it (double-persisted events,
 * corrupted startIndex resume points). One writer per eve session at a time;
 * answer the pending approval (or cancel the run) first.
 */
export async function countDispatchingRuns(
  db: DbClient,
  agentSessionId: string,
  options: { excludeRunId?: string } = {},
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.agentSessionId, agentSessionId),
        inArray(schema.runs.status, ["queued", "running", "waiting"]),
        ...(options.excludeRunId ? [ne(schema.runs.id, options.excludeRunId)] : []),
      ),
    );
  return rows[0]?.value ?? 0;
}

// ── agent publish (route + seeded-workspace kick share this core) ──────────

/**
 * Snapshot the agent's draft into an immutable `agent_versions` row
 * (idempotent by content hash), point `agents.published_version_id` at it,
 * and kick the build (single-flight per hash; cache hit = no-op).
 */
export async function publishAgent(
  deps: RuntimeDeps,
  organizationId: string,
  agentId: string,
): Promise<PublishAgentResponse> {
  const agent = await loadAgentOwned(deps.db, organizationId, agentId);
  const definition = parseAgentDefinition(agent.draft);
  const inputs = await resolveCompileInputs(
    compileServiceDeps(deps),
    organizationId,
    agent.runAsUserId,
    definition,
  );
  const compiled = compileOrThrow(deps.compile, definition, inputs, agent.name);

  // Idempotent by content hash: an existing version of this agent with
  // the same hash is re-published, not duplicated. The unique index on
  // (agent_id, content_hash) makes this race-proof — two concurrent
  // publishes of the same draft (the seeded-workspace kick vs a user click,
  // two browser tabs) resolve to ONE row: the loser's insert no-ops on
  // conflict and re-selects the winner's row.
  const existing = await deps.db
    .select()
    .from(schema.agentVersions)
    .where(
      and(
        eq(schema.agentVersions.agentId, agent.id),
        eq(schema.agentVersions.contentHash, compiled.hash),
      ),
    )
    .limit(1);

  let version = existing[0];
  if (version && version.connectionSlugs === null) {
    // Republish-to-migrate: a row published before `connection_slugs` existed
    // adopts the map on the next publish of the same hash. Safe to derive from
    // THIS publish's inputs — slugs are baked into the hashed files, so an
    // identical content hash implies identical slugs.
    const backfilled = await deps.db
      .update(schema.agentVersions)
      .set({ connectionSlugs: inputs.connectionSlugs })
      .where(eq(schema.agentVersions.id, version.id))
      .returning();
    version = backfilled[0] ?? version;
  }
  if (!version) {
    const inserted = await deps.db
      .insert(schema.agentVersions)
      .values({
        agentId: agent.id,
        definition: definition as unknown as Record<string, unknown>,
        contentHash: compiled.hash,
        compilerVersion: compiled.compilerVersion,
        eveVersion: compiled.eveVersion,
        modelProvider: inputs.model.provider,
        modelId: inputs.model.modelId,
        connectionSlugs: inputs.connectionSlugs,
        buildStatus: "pending",
      })
      .onConflictDoNothing({
        target: [schema.agentVersions.agentId, schema.agentVersions.contentHash],
      })
      .returning();
    version = inserted[0];
    if (!version) {
      // Lost the race — adopt the concurrent publisher's row.
      const winner = await deps.db
        .select()
        .from(schema.agentVersions)
        .where(
          and(
            eq(schema.agentVersions.agentId, agent.id),
            eq(schema.agentVersions.contentHash, compiled.hash),
          ),
        )
        .limit(1);
      version = winner[0]!;
    }
  }

  await deps.db
    .update(schema.agents)
    .set({ publishedVersionId: version.id })
    .where(eq(schema.agents.id, agent.id));

  // Kick the build (single-flight per hash; cache hit = no-op). A
  // cached-succeeded outcome resolves fast enough to await; a fresh
  // build answers "building" immediately and progresses in background.
  const pre = await deps.buildStore.get(compiled.hash);
  const buildPromise = deps.buildService.ensureBuild(compiled.hash, compiled.files);
  // Outcome is persisted; never leave the promise unhandled. Feed the
  // build-cache hit-rate gauge from the resolved outcome (hit vs fresh).
  buildPromise
    .then((outcome) => deps.metrics.recordBuildCache(outcome.cached))
    .catch(() => {});

  let buildStatus: PublishAgentResponse["buildStatus"] = "building";
  let cached = false;
  let buildError: string | null = null;
  if (pre?.status === "succeeded" && pre.artifactKey) {
    const outcome = await buildPromise;
    buildStatus = outcome.status;
    cached = outcome.cached;
    buildError = outcome.errorLog;
  }

  return {
    agentId: agent.id,
    versionId: version.id,
    contentHash: compiled.hash,
    buildStatus,
    cached,
    buildError,
  };
}

/**
 * Publish a workspace's agent by NAME — the onboarding kick: a freshly
 * seeded workspace fire-and-forget-publishes its "General Purpose" agent so
 * first chat needs no manual publish step (index.ts wires this behind the
 * auth module's onWorkspaceSeeded hook). Null when no such agent exists —
 * callers log-and-continue; they never fail the signup.
 */
export async function publishAgentByName(
  deps: RuntimeDeps,
  organizationId: string,
  name: string,
): Promise<PublishAgentResponse | null> {
  const rows = await deps.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.organizationId, organizationId),
        eq(schema.agents.name, name),
      ),
    )
    .limit(1);
  const agent = rows[0];
  if (!agent) return null;
  return publishAgent(deps, organizationId, agent.id);
}

// ── agent-facing token broker (POST /internal/connections/token) ────────────

/**
 * Version-bound audience shape (`agent-version:<64-hex content hash>`). The
 * strict match is load-bearing: it rejects the bare `agent-version` audience
 * channel dispatch uses (runtime/jwt.ts), so a channel-scoped token can never
 * reach the token broker.
 */
const AGENT_VERSION_AUDIENCE = /^agent-version:([0-9a-f]{64})$/;

/** Body carries the connection id ONLY — any other field (e.g. a versionHash)
 * is ignored: the version comes from the verified JWT audience. */
const connectionTokenRequestSchema = z.object({
  connectionId: z.string().min(1),
});

/**
 * Serve a short-lived OAuth access token to a COMPILED AGENT (connectors
 * redesign spec §6). Verification order is exact and security-relevant:
 *
 *   1. decode the UNVERIFIED `aud` claim — no signature trust yet, it only
 *      names WHICH per-version derived secret to verify under;
 *   2. verify signature + `exp` + issuer against that derived secret — a JWT
 *      minted in a different version's env fails here (its secret differs);
 *   3. resolve the agent version by the VERIFIED audience hash — never from
 *      the request body;
 *   4. authorize by membership: the connection id must be in that version's
 *      compiled definition;
 *   5. hand off to the central token lifecycle (oauth/tokens.ts) — refresh
 *      material NEVER leaves the control plane, the response is
 *      `{token, expiresAt}` only.
 */
async function serveConnectionToken(
  deps: RuntimeDeps,
  request: Request,
  rawBody: unknown,
): Promise<{ token: string; expiresAt: string }> {
  // One opaque 401 for every credential failure — the response must not
  // reveal whether the JWT was absent, malformed, expired, or cross-version.
  const unauthorized = () =>
    new RuntimeApiError(401, "unauthorized", "missing or invalid platform JWT");

  const bearer = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer) throw unauthorized();
  const jwt = bearer[1]!;

  let aud: string | undefined;
  try {
    const unverified = decodeJwt(jwt);
    aud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
  } catch {
    throw unauthorized();
  }
  const matched = AGENT_VERSION_AUDIENCE.exec(aud ?? "");
  if (!matched) throw unauthorized();
  const hash = matched[1]!;

  try {
    await jwtVerify(
      jwt,
      new TextEncoder().encode(
        derivePlatformJwtSecret(deps.runtime.platformJwtSecret, hash),
      ),
      {
        issuer: PLATFORM_JWT_ISSUER,
        audience: platformJwtAudienceForHash(hash),
      },
    );
  } catch {
    throw unauthorized();
  }

  // Version rows sharing a content hash carry identical definitions (the
  // hash covers the definition), so the first row decides membership.
  const versions = await deps.db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.contentHash, hash))
    .limit(1);
  const version = versions[0];
  if (!version) throw unauthorized();

  const parsed = connectionTokenRequestSchema.safeParse(rawBody);
  if (!parsed.success) throw errors.invalidBody(parsed.error.issues);
  const { connectionId } = parsed.data;

  const definition = parseAgentDefinition(version.definition);
  if (!definition.context.mcpConnectionIds.includes(connectionId)) {
    throw new RuntimeApiError(
      403,
      "connection_not_in_version",
      "connection is not part of this agent version's definition",
    );
  }

  if (!deps.oauthTokens) {
    throw new RuntimeApiError(
      503,
      "oauth_broker_unavailable",
      "the OAuth token broker is not configured on this control plane",
    );
  }
  const { token, expiresAt } = await getAccessToken(
    deps.oauthTokens,
    connectionId,
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

function connectionTokenPlugin(deps: RuntimeDeps) {
  return new Elysia({ name: "connection-token" }).post(
    "/internal/connections/token",
    async ({ request, body, set }) => {
      try {
        return await serveConnectionToken(deps, request, body);
      } catch (error) {
        // Self-contained error translation (like metricsPlugin): this plugin
        // mounts before the runtime plugin's onError registration.
        if (isRuntimeApiError(error)) {
          set.status = error.status;
          return error.toBody();
        }
        throw error;
      }
    },
  );
}

// ── the plugin ──────────────────────────────────────────────────────────────

export function runtimePlugin(deps: RuntimeDeps) {
  const { db, runtime } = deps;

  return new Elysia({ name: "runtime" })
    .use(
      workerRegistryPlugin({
        db,
        workerSharedSecret: runtime.workerSharedSecret,
        allowInsecureWorkerTransport: runtime.allowInsecureWorkerTransport,
        heartbeatIntervalMs: Math.max(
          1_000,
          Math.floor(runtime.workerHeartbeatTtlMs / 3),
        ),
        allowedWorkerIds: runtime.workerAllowedIds,
        logger: deps.logger,
      }),
    )
    // GET /internal/metrics — worker-plane-guarded fleet snapshot.
    .use(
      metricsPlugin({
        registry: deps.metrics,
        reader: createDrizzleMetricsReader(db),
        workerSharedSecret: runtime.workerSharedSecret,
      }),
    )
    // POST /internal/connections/token — agent-facing OAuth token broker.
    // Shares the /internal/* prefix with the worker plane above but NOT its
    // auth model: callers are COMPILED AGENTS presenting a version-bound
    // platform JWT (audience `agent-version:<hash>`, signed with their
    // per-version derived PLATFORM_JWT_SECRET) — never x-worker-secret. Like
    // every /internal/* route it must not be internet-reachable
    // (docs/runtime-worker-contract.md deployment constraints).
    .use(connectionTokenPlugin(deps))
    .use(workspacePlugin(deps.workspaceDeps))
    .onError(({ error, set }) => {
      if (isRuntimeApiError(error)) {
        set.status = error.status;
        return error.toBody();
      }
      return undefined;
    })

    // Agent CRUD (list/get/create/update/delete) lives in the resources
    // plugin (resources/agents.ts); the runtime plugin owns the
    // compile/build/dispatch verbs below.

    // ── agent publish ──────────────────────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/agents/:agentId/publish",
      ({ workspace, params }): Promise<PublishAgentResponse> =>
        publishAgent(deps, workspace.organizationId, params.agentId),
      { requireWorkspace: true },
    )

    // ── build status (agent editor polls this after an async publish) ──────
    .get(
      "/workspaces/:workspaceId/agents/:agentId/versions/:versionId/build",
      async ({ workspace, params }): Promise<BuildStatusResponse> => {
        const agent = await loadAgentOwned(
          db,
          workspace.organizationId,
          params.agentId,
        );
        const rows = await db
          .select()
          .from(schema.agentVersions)
          .where(
            and(
              eq(schema.agentVersions.id, params.versionId),
              eq(schema.agentVersions.agentId, agent.id),
            ),
          )
          .limit(1);
        const version = rows[0];
        if (!version) throw errors.notFound("agent_version");
        const build = await deps.buildStore.get(version.contentHash);
        return {
          status: build?.status ?? version.buildStatus,
          error: build?.errorLog ?? null,
        };
      },
      { requireWorkspace: true },
    )

    // ── dry-run compile (agent editor) ─────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/agents/:agentId/dry-run-compile",
      async ({ workspace, params }) => {
        const agent = await loadAgentOwned(
          db,
          workspace.organizationId,
          params.agentId,
        );
        // Shape errors, model/allowlist errors, and compile problems are all
        // the PAYLOAD of a dry run (`ok:false`), not a failed request — the
        // editor renders them inline. dryRunCompile centralizes that.
        return dryRunCompile(
          compileServiceDeps(deps),
          workspace.organizationId,
          agent.runAsUserId,
          agent.name,
          agent.draft,
        );
      },
      { requireWorkspace: true },
    )

    // ── create chat session ────────────────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/agents/:agentId/sessions",
      async ({ workspace, params, body, set }) => {
        const { message } = parseBody(createSessionRequestSchema, body);
        deps.metrics.recordTrigger("manual", "received");
        const agent = await loadAgentOwned(
          db,
          workspace.organizationId,
          params.agentId,
        );
        if (!agent.publishedVersionId) throw errors.agentNotPublished();
        const ready = await requireReadyAgentVersion(deps, agent.publishedVersionId);
        const { worker } = await selectWorker(db, {
          heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
          defaultMaxAgents: runtime.maxAgentsPerWorker,
          versionHash: ready.version.contentHash,
        });

        const principal = {
          workspaceId: workspace.organizationId,
          userId: workspace.userId,
          source: "chat",
        };
        // Storage-only provenance (never sent to the agent — the chat message
        // itself goes through verbatim as the eve session message).
        const triggerEvent: TriggerEvent = {
          agentId: agent.id,
          workflowId: null,
          triggerType: "manual",
          message,
          data: {},
          principal,
        };

        // Session + run rows land BEFORE the eve dispatch (202-async window:
        // a crash mid-dispatch leaves a visible failed run, never an
        // untracked, uncapped eve session), inside one advisory-locked
        // transaction so the per-workspace cap is atomic under concurrency.
        const { session, run } = await db.transaction(async (tx) => {
          await lockWorkspaceRunCap(tx, workspace.organizationId);
          await assertUnderRunCap(
            tx,
            workspace.organizationId,
            runtime.maxConcurrentRunsPerWorkspace,
          );
          const sessionRows = await tx
            .insert(schema.agentSessions)
            .values({
              organizationId: workspace.organizationId,
              agentId: agent.id,
              agentVersionId: ready.version.id,
              workflowId: null,
              eveSessionId: null,
              // `continuation_token` is a LEGACY column (eve 0.31 sessions are
              // ID-addressed); it is never written again and is left to its
              // NULL default so it does not read as live state.
              origin: "chat",
              principal,
              affinityWorkerId: worker.id,
              status: "active",
            })
            .returning();
          const runRows = await tx
            .insert(schema.runs)
            .values({
              agentSessionId: sessionRows[0]!.id,
              triggerEvent: triggerEvent as unknown as Record<string, unknown>,
              status: "queued",
            })
            .returning();
          return { session: sessionRows[0]!, run: runRows[0]! };
        });

        const hash = ready.version.contentHash;
        const jwt = agentJwtParams(runtime.platformJwtSecret, hash);
        let created;
        try {
          await ensureAgentOnWorker(deps, worker, ready, workspace.organizationId);
          created = await deps.workerClient.createEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
            message,
          );
        } catch (error) {
          deps.metrics.recordTrigger("manual", "failed");
          await failDispatch(deps, run.id, error, { failSessionId: session.id });
          throw error; // unreachable — failDispatch always throws
        }

        await db
          .update(schema.agentSessions)
          .set({ eveSessionId: created.sessionId })
          .where(eq(schema.agentSessions.id, session.id));
        session.eveSessionId = created.sessionId;

        startTail(deps, worker.address, hash, created.sessionId, run.id, session.id);
        deps.metrics.recordTrigger("manual", "dispatched");

        set.status = 201;
        return { session: sessionDto(session), run: runDto(run) };
      },
      { requireWorkspace: true },
    )

    // ── manual "Run now" (workflow test run) ───────────────────────────────
    //
    // Dispatches the workflow's PUBLISHED snapshot through the shared
    // trigger-dispatch path — the instructions render into the task message
    // exactly as a real trigger event would (`data` lets the test-run popover
    // exercise webhook/form-shaped `@trigger.*` refs). Deliberately ignores
    // `enabled` (that switch gates unattended trigger ingress; this is an
    // explicit member action, like chat).
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/run",
      async ({ workspace, params, body, set }) => {
        const input = parseBody(runWorkflowRequestSchema, body ?? {});
        const { workflow, config, agentId } = await loadPublishedWorkflow(
          db,
          workspace.organizationId,
          params.wfId,
        );

        // FLOATING binding: resolve the agent's CURRENT published version;
        // the session/run rows pin the exact version used. A snapshot whose
        // agent vanished (deleted despite RESTRICT / cross-workspace drift)
        // surfaces as the typed workflow_agent_missing, not a bare 404.
        const agent = await loadAgentOwned(
          db,
          workspace.organizationId,
          agentId,
        ).catch((error) => {
          if (isRuntimeApiError(error) && error.status === 404) {
            throw errors.workflowAgentMissing();
          }
          throw error;
        });
        if (!agent.publishedVersionId) throw errors.agentNotPublished();
        const ready = await requireReadyAgentVersion(deps, agent.publishedVersionId);

        const result = await dispatchTriggerRun(deps, {
          organizationId: workspace.organizationId,
          workflow: { id: workflow.id, snapshot: config },
          agent: ready,
          origin: "chat",
          triggerType: "manual",
          principal: {
            workspaceId: workspace.organizationId,
            userId: workspace.userId,
            source: "manual",
          },
          ingress: { message: input.message ?? "", data: input.data ?? {} },
        });

        set.status = 201;
        return { session: sessionDto(result.session), run: runDto(result.run) };
      },
      { requireWorkspace: true },
    )

    // ── follow-up message ──────────────────────────────────────────────────
    .post(
      "/sessions/:sessionId/messages",
      async ({ workspace, params, body, set }) => {
        const { message } = parseBody(postMessageRequestSchema, body);
        deps.metrics.recordTrigger("manual", "received");
        const session = await loadSessionOwned(
          db,
          workspace.organizationId,
          params.sessionId,
        );
        // 0.31: continuable iff the row is not terminal. A `continuationToken`
        // term here would reject EVERY follow-up (the column is never written
        // anymore) — chat would be dead after the first message.
        //
        // A row with NO eve session id is continuable too: it is the state a
        // `reset` leaves behind (the retired eve id can never take another
        // message, so the replacement row starts empty). This message OPENS
        // its eve session, exactly as dispatch.ts's create branch does.
        if (session.status === "closed" || session.status === "error") {
          throw errors.sessionNotContinuable();
        }
        // Sessions pin their agent version at creation — a follow-up always
        // rides the SAME compiled artifact, even after a republish.
        const ready = await requireReadyAgentVersion(deps, session.agentVersionId);
        const { worker } = await selectWorker(db, {
          heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
          defaultMaxAgents: runtime.maxAgentsPerWorker,
          versionHash: ready.version.contentHash,
          affinityWorkerId: session.affinityWorkerId,
        });

        const triggerEvent: TriggerEvent = {
          agentId: session.agentId,
          workflowId: session.workflowId,
          triggerType: "manual",
          message,
          data: {},
          principal: {
            workspaceId: workspace.organizationId,
            userId: workspace.userId,
            source: "chat",
          },
        };

        // One advisory-locked transaction: session-serialization guard (two
        // tails on ONE eve NDJSON stream corrupt run_events and resume
        // points — refuse with 409 while a run is queued/running), atomic
        // per-workspace cap, and the run row BEFORE the eve dispatch.
        const run = await db.transaction(async (tx) => {
          await lockWorkspaceRunCap(tx, workspace.organizationId);
          if ((await countDispatchingRuns(tx, session.id)) > 0) {
            throw errors.sessionBusy();
          }
          await assertUnderRunCap(
            tx,
            workspace.organizationId,
            runtime.maxConcurrentRunsPerWorkspace,
          );
          const runRows = await tx
            .insert(schema.runs)
            .values({
              agentSessionId: session.id,
              triggerEvent: triggerEvent as unknown as Record<string, unknown>,
              status: "queued",
            })
            .returning();
          return runRows[0]!;
        });

        const hash = ready.version.contentHash;
        const jwt = agentJwtParams(runtime.platformJwtSecret, hash);
        let eveSessionId: string;
        try {
          await ensureAgentOnWorker(deps, worker, ready, workspace.organizationId);
          if (session.eveSessionId) {
            // "send" form — `{message}` alone. eve rejects a body carrying
            // BOTH message and inputResponses, and 400s on a
            // `continuationToken` key.
            eveSessionId = session.eveSessionId;
            await deps.workerClient.continueEveSession(
              worker.address,
              hash,
              await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
              eveSessionId,
              { message },
            );
          } else {
            // Post-reset (or never-acked) row: open a fresh eve session.
            const created = await deps.workerClient.createEveSession(
              worker.address,
              hash,
              await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
              message,
            );
            eveSessionId = created.sessionId;
            await db
              .update(schema.agentSessions)
              .set({ eveSessionId })
              .where(eq(schema.agentSessions.id, session.id));
            session.eveSessionId = eveSessionId;
          }
        } catch (error) {
          deps.metrics.recordTrigger("manual", "failed");
          // A terminal/reset eve session surfaces as the typed, PERMANENT
          // `session_not_active` (and closes the row) rather than a 502 the
          // client would retry forever.
          await failEveDispatch(deps, run.id, session.id, error);
          throw error; // unreachable — failEveDispatch always throws
        }
        await db
          .update(schema.agentSessions)
          .set({ status: "active", affinityWorkerId: worker.id })
          .where(eq(schema.agentSessions.id, session.id));

        startTail(deps, worker.address, hash, eveSessionId, run.id, session.id);
        deps.metrics.recordTrigger("manual", "dispatched");

        set.status = 201;
        return { run: runDto(run) };
      },
      { requireWorkspace: true },
    )

    // ── session detail ─────────────────────────────────────────────────────
    .get(
      "/sessions/:sessionId",
      async ({ workspace, params }) => {
        const session = await loadSessionOwned(
          db,
          workspace.organizationId,
          params.sessionId,
        );
        const runRows = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.agentSessionId, session.id))
          .orderBy(asc(schema.runs.createdAt));
        return { session: sessionDto(session), runs: runRows.map(runDto) };
      },
      { requireWorkspace: true },
    )

    // ── HITL: answer a parked input.requested ────────────────────────────────
    .post(
      "/runs/:runId/input",
      async ({ workspace, params, body }) => {
        const input = parseBody(runInputRequestSchema, body);
        const { run, session } = await loadRunOwned(
          db,
          workspace.organizationId,
          params.runId,
        );
        // Same 0.31 predicate as the follow-up route: an eve session id and a
        // non-terminal row. Gating on a continuation token would 409 every
        // HITL answer and park every gated run permanently.
        if (
          !session.eveSessionId ||
          session.status === "closed" ||
          session.status === "error"
        ) {
          throw errors.sessionNotContinuable();
        }
        const eveSessionId = session.eveSessionId;
        const ready = await requireReadyAgentVersion(deps, session.agentVersionId);
        const { worker } = await selectWorker(db, {
          heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
          defaultMaxAgents: runtime.maxAgentsPerWorker,
          versionHash: ready.version.contentHash,
          affinityWorkerId: session.affinityWorkerId,
        });

        // Only a run parked on input (status `waiting`) is resolvable. Flip it
        // to queued inside the advisory lock so a double POST cannot
        // double-dispatch the same answer; the run row is REUSED (no cap
        // change — a waiting run already holds its slot). One-writer guard:
        // no OTHER run of this session may be dispatching — resuming this run
        // while another tails the same eve stream would double-read it.
        const resumed = await db.transaction(async (tx) => {
          await lockWorkspaceRunCap(tx, workspace.organizationId);
          const rows = await tx
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(eq(schema.runs.id, run.id))
            .limit(1);
          if (rows[0]?.status !== "waiting") return false;
          if (
            (await countDispatchingRuns(tx, session.id, {
              excludeRunId: run.id,
            })) > 0
          ) {
            throw errors.sessionBusy();
          }
          await tx
            .update(schema.runs)
            .set({ status: "queued", error: null })
            .where(eq(schema.runs.id, run.id));
          return true;
        });
        if (!resumed) throw errors.noPendingInput();

        const hash = ready.version.contentHash;
        const jwt = agentJwtParams(runtime.platformJwtSecret, hash);
        const inputResponses: EveInputResponse[] = [
          {
            requestId: input.requestId,
            ...(input.optionId !== undefined ? { optionId: input.optionId } : {}),
            ...(input.text !== undefined ? { text: input.text } : {}),
          },
        ];
        try {
          await ensureAgentOnWorker(deps, worker, ready, workspace.organizationId);
          // "respond" form — `{inputResponses}` alone. 0.31 made send and
          // respond mutually exclusive: a body carrying `message` too is a
          // 400, as is any `continuationToken` key.
          await deps.workerClient.continueEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
            eveSessionId,
            { inputResponses },
          );
        } catch (error) {
          await failEveDispatch(deps, run.id, session.id, error);
          throw error; // unreachable — failEveDispatch always throws
        }
        await db
          .update(schema.agentSessions)
          .set({ status: "active", affinityWorkerId: worker.id })
          .where(eq(schema.agentSessions.id, session.id));

        // Resume tailing the SAME run — its pre-park events stay; new events
        // append at the next seq (SSE Last-Event-ID resume is seamless).
        startTail(deps, worker.address, hash, eveSessionId, run.id, session.id);

        const updated = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, run.id))
          .limit(1);
        return { run: runDto(updated[0] ?? run) };
      },
      { requireWorkspace: true },
    )

    // ── run SSE stream ─────────────────────────────────────────────────────
    .get(
      "/runs/:runId/stream",
      async ({ workspace, params, request, query }) => {
        const { run } = await loadRunOwned(db, workspace.organizationId, params.runId);
        const lastEventId = parseLastEventId(
          request.headers.get("last-event-id") ??
            (typeof query.lastEventId === "string" ? query.lastEventId : null),
        );
        return createRunSseResponse({
          runId: run.id,
          store: deps.runStore,
          bus: deps.bus,
          lastEventId,
          heartbeatMs: runtime.sseHeartbeatMs,
        });
      },
      { requireWorkspace: true },
    )

    // ── run cancel (the Stop button) ───────────────────────────────────────
    //
    // Abort an in-flight run and mark it `canceled` (freeing its concurrency
    // slot). Idempotent — cancelling an already-terminal run returns its
    // current state.
    //
    // eve 0.31 ships a REAL remote cancel (`POST /eve/v1/session/:id/cancel`),
    // so this is no longer platform-side bookkeeping over a turn that keeps
    // burning tokens: the tailer issues the remote cancel before it stops
    // reading (see startTail's `cancelRemoteTurn` and the tailer's cancel
    // path), and eve ends the turn with `turn.cancelled` → `session.waiting`.
    // Two properties of eve's cancel that shape this route:
    //   * it is COOPERATIVE, at durable step boundaries — a tool call already
    //     in flight runs to completion, so "stopped" never means "undone";
    //   * `202 accepted` does not prove a turn was stopped and `200
    //     no_active_turn` does not mean "nothing was running" (eve renders a
    //     DEAD session under that name too). So a cancel response is never
    //     used to infer liveness, and a failure to reach eve never blocks the
    //     platform-side cancellation.
    // Cancellation is a user decision, never an error: the run lands
    // `canceled`, and the session stays usable for the next message.
    .post(
      "/runs/:runId/cancel",
      async ({ workspace, params, body }): Promise<RunCancelResponse> => {
        const input = parseBody(runCancelRequestSchema, body ?? {}) ?? {};
        const { run, session } = await loadRunOwned(
          db,
          workspace.organizationId,
          params.runId,
        );
        const reason = input.reason ?? "canceled by user";

        // Idempotent: a run that already reached a terminal status is returned
        // as-is (no error) so a double-tap / retry is harmless.
        if (
          run.status === "succeeded" ||
          run.status === "failed" ||
          run.status === "canceled"
        ) {
          return { run: runDto(run) };
        }

        // A live tail (running run) is aborted and marked canceled by the
        // tailer (which owns the remote cancel); a parked (`waiting`) or
        // not-yet-tailed (`queued`) run has no live tail — mark it canceled
        // directly and make a best-effort remote cancel ourselves so a turn
        // eve is still running for this session does not outlive the run row.
        const hadTail = await deps.tailers.cancelRun(run.id, reason);
        if (!hadTail) {
          // Settle the ROW FIRST, then chase eve. The platform side is
          // authoritative for the run row, so the user's Stop must not be
          // held behind a remote leg that can be slow or unreachable — and
          // the remote cancel is best-effort anyway. (Ordering matters here:
          // when this ran first, a Stop on a reaped agent paid a full boot
          // before the run was marked canceled.)
          await deps.runStore.markRun(run.id, {
            status: "canceled",
            error: reason,
            completedAt: new Date(),
          });
          // No tail ⇒ no tailer hook ⇒ settle a pending outbound-reply
          // marker here (canceled runs owe no reply; deliver() no-ops for
          // runs owing nothing).
          await deps.delivery?.deliver({
            runId: run.id,
            status: "canceled",
            lastAssistantMessage: null,
          });
          deps.bus.publish(run.id, {
            kind: "status",
            frame: { runId: run.id, status: "canceled", error: reason },
          });
          // Best-effort: stop a turn eve may still be running for this
          // session so it cannot outlive the run row. Never boots the agent
          // (see sessionControlTarget's `ensure: false`).
          await cancelEveTurnBestEffort(deps, session);
        }

        const updated = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, run.id))
          .limit(1);
        return { run: runDto(updated[0] ?? run) };
      },
      { requireWorkspace: true },
    )

    // ── eve context controls: clear / compact ──────────────────────────────
    //
    // Both mutate the session IN PLACE and keep its id, so the platform row is
    // untouched — only eve's durable model history changes.
    //
    // AUTHZ: `requireWorkspace: true` (member) plus loadSessionOwned's
    // organizationId check. Deliberately the same level as sending a message
    // into the session: a member who can drive a session can manage its
    // context. A caller outside the workspace never gets here — the macro 403s
    // a foreign workspace path, and a foreign session id 404s
    // (existence-hiding), so no one can clear another workspace's context.
    //
    // Success is keyed on eve's `status` field, NEVER on the HTTP code (202
    // accepted vs 200 no_active_session), and `no_active_session` is NOT
    // "nothing to do": it is the same dead-session condition a send reports as
    // 409, so it closes the platform row too.
    .post(
      "/sessions/:sessionId/clear",
      async ({ workspace, params }) => {
        const session = await loadSessionOwned(
          db,
          workspace.organizationId,
          params.sessionId,
        );
        const eveSessionId = await requireQuietControllableSession(deps, session);
        const target = await sessionControlTarget(
          deps,
          workspace.organizationId,
          session,
        );
        const result = await deps.workerClient.clearEveSession(
          target.workerAddress,
          target.hash,
          target.token,
          eveSessionId,
        );
        return finishContextControl(deps, session, result.status, target.workerId);
      },
      { requireWorkspace: true },
    )
    .post(
      "/sessions/:sessionId/compact",
      async ({ workspace, params }) => {
        const session = await loadSessionOwned(
          db,
          workspace.organizationId,
          params.sessionId,
        );
        const eveSessionId = await requireQuietControllableSession(deps, session);
        const target = await sessionControlTarget(
          deps,
          workspace.organizationId,
          session,
        );
        // A compact over an EMPTY/already-cleared context emits no
        // `compaction.*` events at all — the 202 is the only acknowledgement.
        // Never wait on `compaction.requested` here.
        const result = await deps.workerClient.compactEveSession(
          target.workerAddress,
          target.hash,
          target.token,
          eveSessionId,
        );
        return finishContextControl(deps, session, result.status, target.workerId);
      },
      { requireWorkspace: true },
    )

    // ── eve context control: reset (DESTRUCTIVE) ───────────────────────────
    //
    // Retires the eve session id permanently — it can never accept another
    // message — so the platform closes the old row and mints a REPLACEMENT
    // `agent_sessions` row against the same agent + pinned version. The
    // replacement starts with no eve session; its first message opens one (see
    // the follow-up route). Clients must re-key their thread cache onto
    // `session.id`.
    //
    // AUTHZ: same member-level rule as clear/compact. Reset destroys only the
    // caller's own workspace's conversation context — never another
    // workspace's data and never workspace configuration — so raising it to
    // admin would block a member from resetting their own chat while leaving
    // them free to delete it. The destructive gate is the UI confirm step.
    .post(
      "/sessions/:sessionId/reset",
      async ({ workspace, params, body }): Promise<ResetSessionResponse> => {
        const input = parseBody(resetSessionRequestSchema, body ?? {}) ?? {};
        const session = await loadSessionOwned(
          db,
          workspace.organizationId,
          params.sessionId,
        );
        const eveSessionId = await requireQuietControllableSession(deps, session);
        const target = await sessionControlTarget(
          deps,
          workspace.organizationId,
          session,
        );
        // Reset is the ONE control route that never answers 202: BOTH outcomes
        // are HTTP 200, and the id field is `previousSessionId`.
        const result = await deps.workerClient.resetEveSession(
          target.workerAddress,
          target.hash,
          target.token,
          eveSessionId,
          input?.reason !== undefined ? { reason: input.reason } : {},
        );

        // Either way the old eve id is unusable: `reset` retired it, and
        // `no_active_session` means it was already dead. Close the row (which
        // also releases any slack_thread_key) — but only `reset` mints a
        // replacement, so `no_active_session` leaves the caller on a closed
        // row it must replace with a fresh chat.
        await deps.runStore.markSession(session.id, "closed");
        const previousSession = sessionDto({ ...session, status: "closed" });
        if (result.status !== "reset") {
          return { status: "no_active_session", previousSession };
        }

        const inserted = await db
          .insert(schema.agentSessions)
          .values({
            organizationId: session.organizationId,
            agentId: session.agentId,
            // Pinned version is inherited: a reset continues the SAME compiled
            // artifact, it does not silently migrate the thread to a newer
            // publish.
            agentVersionId: session.agentVersionId,
            workflowId: session.workflowId,
            eveSessionId: null,
            origin: session.origin,
            principal: session.principal,
            // The Slack thread key is deliberately NOT carried over: the old
            // row just released it, and a fresh thread claim is made by the
            // next inbound message under the advisory lock.
            slackThreadKey: null,
            affinityWorkerId: target.workerId,
            status: "active",
          })
          .returning();
        return {
          status: "reset",
          previousSession,
          session: sessionDto(inserted[0]!),
        };
      },
      { requireWorkspace: true },
    );
}

/**
 * Shared tail of clear/compact: reflect eve's outcome onto the platform row
 * and answer with the (possibly updated) session DTO.
 *
 * `no_active_session` is eve telling us the id is dead — the same terminal
 * condition a send answers with 409 `session_not_active` — so the row is
 * closed rather than left looking live.
 */
async function finishContextControl(
  deps: RuntimeDeps,
  session: SessionRow,
  status: SessionContextControlStatus,
  workerId: string,
): Promise<SessionContextControlResponse> {
  if (status === "no_active_session") {
    await deps.runStore.markSession(session.id, "closed");
    return { session: sessionDto({ ...session, status: "closed" }), status };
  }
  await deps.db
    .update(schema.agentSessions)
    .set({ status: "active", affinityWorkerId: workerId })
    .where(eq(schema.agentSessions.id, session.id));
  return {
    session: sessionDto({ ...session, status: "active" }),
    status,
  };
}
