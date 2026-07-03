/**
 * Runtime API (docs/PLAN.md Phase 1 tasks 3+5+6):
 *
 * - POST /workspaces/:workspaceId/workflows/:wfId/publish
 *     snapshot draft → immutable workflow_versions row (idempotent by content
 *     hash) → kick the build → respond with version + build status.
 * - POST /workspaces/:workspaceId/workflows/:wfId/versions/dry-run-compile
 *     compile the draft without persisting; structured errors for the builder.
 * - POST /workspaces/:workspaceId/workflows/:wfId/sessions {message}
 *     requires published+ready version → scheduler picks a live worker →
 *     ensure-agent (artifact URL + env) → POST eve session (platform JWT,
 *     202) → persist agent_sessions + runs → start the NDJSON tailer.
 * - POST /sessions/:id/messages {message} — continuation token, new run.
 * - GET  /sessions/:id — session + runs.
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
import { schema } from "@invisible-string/db";
import {
  createSessionRequestSchema,
  postMessageRequestSchema,
  runCancelRequestSchema,
  runInputRequestSchema,
  type AgentSessionDto,
  type BuildStatusResponse,
  type EveInputResponse,
  type PublishWorkflowResponse,
  type RunCancelResponse,
  type RunDto,
  type Logger,
  type TriggerEvent,
  type WorkflowDefinition,
  type MasterKey,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import type { ArtifactStore } from "../artifacts";
import type { BuildService, BuildStore } from "../build/service";
import { type CompileWorkflowFn } from "../build/compiler-contract";
import { worldNameForHash, worldUrlFor } from "../build/world";
import { RunEventBus } from "../runs/bus";
import { createRunSseResponse, parseLastEventId } from "../runs/sse";
import type { RunStore } from "../runs/store";
import type { RunTailerManager } from "../runs/tailer";
import { workspacePlugin, type WorkspaceDeps } from "../workspace";
import { buildAgentEnv, decryptMcpEnv } from "./agent-env";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import {
  compileOrThrow,
  dryRunCompile,
  parseDefinition,
  resolveCompileInputs,
  type CompileServiceDeps,
} from "./compile-service";
import type { RuntimeConfig } from "./config";
import { errors, isRuntimeApiError, RuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import {
  loadModelResolutionData,
  resolveModel,
  type ModelProvider,
} from "./model-resolution";
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
  compile: CompileWorkflowFn;
  workerClient: WorkerClient;
  runStore: RunStore;
  bus: RunEventBus;
  tailers: RunTailerManager;
  /** In-process fleet metrics (GET /internal/metrics). */
  metrics: MetricsRegistry;
  /** Structured, redaction-safe logger (correlation ids threaded per call). */
  logger: Logger;
}

// ── row loading + ownership ─────────────────────────────────────────────────

type WorkflowRow = typeof schema.workflows.$inferSelect;
type VersionRow = typeof schema.workflowVersions.$inferSelect;
type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

async function loadWorkflowOwned(
  db: Db,
  organizationId: string,
  workflowId: string,
): Promise<WorkflowRow> {
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.id, workflowId),
        eq(schema.workflows.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.workflowNotFound();
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

async function loadVersion(db: Db, versionId: string): Promise<VersionRow> {
  const rows = await db
    .select()
    .from(schema.workflowVersions)
    .where(eq(schema.workflowVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.workflowNotPublished();
  return row;
}

// ── compile-input resolution ────────────────────────────────────────────────
//
// parseDefinition / resolveCompileInputs / compileOrThrow live in
// compile-service.ts (shared with the Phase-2 builder draft validation).

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
    workflowId: row.workflowId,
    workflowVersionId: row.workflowVersionId,
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
 * Provider that was COMPILED into a version. Stored on the row at publish;
 * legacy rows re-resolve from the immutable config snapshot.
 */
export async function providerForVersion(
  db: Db,
  organizationId: string,
  version: VersionRow,
  definition: WorkflowDefinition,
): Promise<ModelProvider> {
  if (version.modelProvider) return version.modelProvider;
  const data = await loadModelResolutionData(
    db,
    organizationId,
    definition.agent.agentPresetId,
  );
  return resolveModel(definition.agent, data).provider;
}

export interface ReadyVersion {
  version: VersionRow;
  definition: WorkflowDefinition;
  artifactKey: string;
}

/** The published version must have a succeeded build with its artifact. */
export async function requireReadyVersion(
  deps: RuntimeDeps,
  versionId: string,
): Promise<ReadyVersion> {
  const version = await loadVersion(deps.db, versionId);
  const build = await deps.buildStore.get(version.contentHash);
  if (!build || build.status !== "succeeded" || !build.artifactKey) {
    throw errors.versionNotReady(build?.status ?? version.buildStatus);
  }
  const definition = parseDefinition(version.config);
  return { version, definition, artifactKey: build.artifactKey };
}

/**
 * ensure-agent on the picked worker with the version's full env. `extraEnv`
 * lets a caller inject additional non-secret-or-decrypted vars (e.g. the Slack
 * team bot token `SLACK_BOT_TOKEN` for a slack-triggered version) that ride
 * the same spawn-time-only env channel as provider keys and MCP tokens.
 */
export async function ensureAgentOnWorker(
  deps: RuntimeDeps,
  worker: { id: string; address: string },
  ready: ReadyVersion,
  organizationId: string,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const hash = ready.version.contentHash;
  const provider = await providerForVersion(
    deps.db,
    organizationId,
    ready.version,
    ready.definition,
  );
  const mcpEnv = await decryptMcpEnv(
    deps.db,
    deps.masterKey,
    ready.definition.context.mcpConnectionIds,
  );
  const env = {
    ...buildAgentEnv({
      runtime: deps.runtime,
      worldUrl: worldUrlFor(deps.runtime.worldDatabaseUrl, worldNameForHash(hash)),
      contentHash: hash,
      provider,
      mcpEnv,
    }),
    ...(extraEnv ?? {}),
  };
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

    // Workflows CRUD (list/get/create/update/delete) live in the Phase-2
    // resources plugin (resources/workflows.ts); the runtime plugin owns the
    // compile/build/dispatch verbs below.

    // ── publish ────────────────────────────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/publish",
      async ({ workspace, params }): Promise<PublishWorkflowResponse> => {
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        const definition = parseDefinition(workflow.draft);
        const inputs = await resolveCompileInputs(
          compileServiceDeps(deps),
          workspace.organizationId,
          workflow.runAsUserId,
          definition,
        );
        const compiled = compileOrThrow(deps.compile, definition, inputs, workflow.name);

        // Idempotent by content hash: an existing version of this workflow
        // with the same hash is re-published, not duplicated.
        const existing = await db
          .select()
          .from(schema.workflowVersions)
          .where(
            and(
              eq(schema.workflowVersions.workflowId, workflow.id),
              eq(schema.workflowVersions.contentHash, compiled.hash),
            ),
          )
          .limit(1);

        let version = existing[0];
        if (!version) {
          const inserted = await db
            .insert(schema.workflowVersions)
            .values({
              workflowId: workflow.id,
              config: definition as unknown as Record<string, unknown>,
              contentHash: compiled.hash,
              compilerVersion: compiled.compilerVersion,
              eveVersion: compiled.eveVersion,
              modelProvider: inputs.model.provider,
              modelId: inputs.model.modelId,
              buildStatus: "pending",
            })
            .returning();
          version = inserted[0]!;
        }

        await db
          .update(schema.workflows)
          .set({ publishedVersionId: version.id })
          .where(eq(schema.workflows.id, workflow.id));

        // Keep live Slack routing rules in sync with what was just published:
        // the binding's rules (mentionOnly / channelId / DMs) are part of the
        // workflow definition, so a republish must update the persisted
        // trigger row — otherwise ingress keeps routing on stale rules. The
        // integration (team) pointer is user-managed and preserved; nothing
        // happens until the user has bound a team.
        if (definition.trigger.type === "slack") {
          const triggerRows = await db
            .select({
              id: schema.triggers.id,
              type: schema.triggers.type,
              integrationId: schema.triggers.integrationId,
            })
            .from(schema.triggers)
            .where(eq(schema.triggers.workflowId, workflow.id))
            .limit(1);
          const triggerRow = triggerRows[0];
          if (triggerRow?.type === "slack" && triggerRow.integrationId) {
            await db
              .update(schema.triggers)
              .set({
                binding: definition.trigger
                  .binding as unknown as Record<string, unknown>,
              })
              .where(eq(schema.triggers.id, triggerRow.id));
          }
        }

        // Kick the build (single-flight per hash; cache hit = no-op). A
        // cached-succeeded outcome resolves fast enough to await; a fresh
        // build answers "building" immediately and progresses in background.
        const pre = await deps.buildStore.get(compiled.hash);
        const buildPromise = deps.buildService.ensureBuild(
          compiled.hash,
          compiled.files,
        );
        // Outcome is persisted; never leave the promise unhandled. Feed the
        // build-cache hit-rate gauge from the resolved outcome (hit vs fresh).
        buildPromise
          .then((outcome) => deps.metrics.recordBuildCache(outcome.cached))
          .catch(() => {});

        let buildStatus: PublishWorkflowResponse["buildStatus"] = "building";
        let cached = false;
        let buildError: string | null = null;
        if (pre?.status === "succeeded" && pre.artifactKey) {
          const outcome = await buildPromise;
          buildStatus = outcome.status;
          cached = outcome.cached;
          buildError = outcome.errorLog;
        }

        return {
          workflowId: workflow.id,
          versionId: version.id,
          contentHash: compiled.hash,
          buildStatus,
          cached,
          buildError,
        };
      },
      { requireWorkspace: true },
    )

    // ── build status (builder polls this after an async publish) ───────────
    .get(
      "/workspaces/:workspaceId/workflows/:wfId/versions/:versionId/build",
      async ({ workspace, params }): Promise<BuildStatusResponse> => {
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        const rows = await db
          .select()
          .from(schema.workflowVersions)
          .where(
            and(
              eq(schema.workflowVersions.id, params.versionId),
              eq(schema.workflowVersions.workflowId, workflow.id),
            ),
          )
          .limit(1);
        const version = rows[0];
        if (!version) throw errors.notFound("workflow version");
        const build = await deps.buildStore.get(version.contentHash);
        return {
          status: build?.status ?? version.buildStatus,
          error: build?.errorLog ?? null,
        };
      },
      { requireWorkspace: true },
    )

    // ── dry-run compile (builder UI) ───────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/versions/dry-run-compile",
      async ({ workspace, params }) => {
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        // Shape errors, model/allowlist errors, and compile problems are all
        // the PAYLOAD of a dry run (`ok:false`), not a failed request — the
        // builder renders them inline. dryRunCompile centralizes that.
        const definition = parseDefinition(workflow.draft);
        return dryRunCompile(
          compileServiceDeps(deps),
          workspace.organizationId,
          workflow.runAsUserId,
          workflow.name,
          definition,
        );
      },
      { requireWorkspace: true },
    )

    // ── create session ─────────────────────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/sessions",
      async ({ workspace, params, body, set }) => {
        const { message } = parseBody(createSessionRequestSchema, body);
        deps.metrics.recordTrigger("manual", "received");
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        if (!workflow.publishedVersionId) throw errors.workflowNotPublished();
        const ready = await requireReadyVersion(deps, workflow.publishedVersionId);
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
        const triggerEvent: TriggerEvent = {
          workflowId: workflow.id,
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
              workflowId: workflow.id,
              workflowVersionId: ready.version.id,
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
        const ready = await requireReadyVersion(deps, session.workflowVersionId);
        const { worker } = await selectWorker(db, {
          heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
          defaultMaxAgents: runtime.maxAgentsPerWorker,
          versionHash: ready.version.contentHash,
          affinityWorkerId: session.affinityWorkerId,
        });

        const triggerEvent: TriggerEvent = {
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
        const ready = await requireReadyVersion(deps, session.workflowVersionId);
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
