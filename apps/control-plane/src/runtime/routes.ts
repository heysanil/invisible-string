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
 * - POST /sessions/:id/messages {message} — continuation token, new run.
 * - GET  /sessions/:id — session + runs.
 * - POST /runs/:id/input — HITL answer; POST /runs/:id/cancel — abort.
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
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  createSessionRequestSchema,
  postMessageRequestSchema,
  runCancelRequestSchema,
  runInputRequestSchema,
  runWorkflowRequestSchema,
  type AgentDefinition,
  type AgentSessionDto,
  type BuildStatusResponse,
  type EveInputResponse,
  type PublishAgentResponse,
  type RunCancelResponse,
  type RunDto,
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
import { errors, isRuntimeApiError, RuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import {
  createDrizzleMetricsReader,
  metricsPlugin,
  type MetricsRegistry,
} from "./metrics";
import { selectWorker } from "./scheduler";
import type { WorkerClient } from "./worker-client";
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
    openStream: async (startIndex, signal) =>
      deps.workerClient.openEventStream(
        workerAddress,
        contentHash,
        // Minted per (re)connect — short-lived tokens must not expire a
        // resume. Secret + audience are bound to this version's hash.
        await mintPlatformJwt(secret, { audience, claims: { runId } }),
        eveSessionId,
        startIndex,
        signal,
      ),
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
              continuationToken: null,
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
          .set({
            eveSessionId: created.sessionId,
            continuationToken: created.continuationToken,
          })
          .where(eq(schema.agentSessions.id, session.id));
        session.eveSessionId = created.sessionId;
        session.continuationToken = created.continuationToken;

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
        if (
          !session.eveSessionId ||
          !session.continuationToken ||
          session.status === "closed" ||
          session.status === "error"
        ) {
          throw errors.sessionNotContinuable();
        }
        const eveSessionId = session.eveSessionId;
        const continuationToken = session.continuationToken;
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
          continuationToken,
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
        let result;
        try {
          await ensureAgentOnWorker(deps, worker, ready, workspace.organizationId);
          result = await deps.workerClient.continueEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
            eveSessionId,
            { continuationToken, message },
          );
        } catch (error) {
          deps.metrics.recordTrigger("manual", "failed");
          await failDispatch(deps, run.id, error);
          throw error; // unreachable — failDispatch always throws
        }
        if (result.continuationToken) {
          await deps.runStore.updateSessionContinuation(
            session.id,
            result.continuationToken,
          );
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
        if (
          !session.eveSessionId ||
          !session.continuationToken ||
          session.status === "closed" ||
          session.status === "error"
        ) {
          throw errors.sessionNotContinuable();
        }
        const eveSessionId = session.eveSessionId;
        const continuationToken = session.continuationToken;
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
        let result;
        try {
          await ensureAgentOnWorker(deps, worker, ready, workspace.organizationId);
          result = await deps.workerClient.continueEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
            eveSessionId,
            { continuationToken, inputResponses },
          );
        } catch (error) {
          await failDispatch(deps, run.id, error);
          throw error; // unreachable — failDispatch always throws
        }
        if (result.continuationToken) {
          await deps.runStore.updateSessionContinuation(
            session.id,
            result.continuationToken,
          );
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

    // ── run cancel ─────────────────────────────────────────────────────────
    //
    // Abort an in-flight run: stop the tailer and mark the run `canceled`
    // (freeing its concurrency slot). Idempotent — cancelling an
    // already-terminal run returns its current state. Best-effort re: eve's
    // turn: eve exposes no session-cancel HTTP route (runs/tailer.ts header),
    // so the platform stops streaming and records the cancellation while eve's
    // own turn parks/caps out server-side.
    .post(
      "/runs/:runId/cancel",
      async ({ workspace, params, body }): Promise<RunCancelResponse> => {
        const input = parseBody(runCancelRequestSchema, body ?? {}) ?? {};
        const { run } = await loadRunOwned(db, workspace.organizationId, params.runId);
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
        // tailer; a parked (`waiting`) or not-yet-tailed (`queued`) run has no
        // live tail — mark it canceled directly.
        const hadTail = await deps.tailers.cancelRun(run.id, reason);
        if (!hadTail) {
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
        }

        const updated = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, run.id))
          .limit(1);
        return { run: runDto(updated[0] ?? run) };
      },
      { requireWorkspace: true },
    );
}
