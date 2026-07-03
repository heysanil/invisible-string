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
import { and, asc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  createSessionRequestSchema,
  postMessageRequestSchema,
  workflowDefinitionSchema,
  type AgentSessionDto,
  type PublishWorkflowResponse,
  type RunDto,
  type TriggerEvent,
  type WorkflowDefinition,
  type MasterKey,
} from "@invisible-string/shared";

import type { Db } from "../db";
import type { ArtifactStore } from "../artifacts";
import type { BuildService, BuildStore } from "../build/service";
import {
  WorkflowCompileError,
  type CompileConnection,
  type CompileResult,
  type CompileSkill,
  type CompileWorkflowFn,
} from "../build/compiler-contract";
import { worldNameForHash, worldUrlFor } from "../build/world";
import { RunEventBus } from "../runs/bus";
import { createRunSseResponse, parseLastEventId } from "../runs/sse";
import type { RunStore } from "../runs/store";
import type { RunTailerManager } from "../runs/tailer";
import { workspacePlugin, type WorkspaceDeps } from "../workspace";
import { buildAgentEnv, decryptMcpEnv, mcpTokenEnvName } from "./agent-env";
import { assertUnderRunCap } from "./caps";
import type { RuntimeConfig } from "./config";
import { errors, isRuntimeApiError, RuntimeApiError } from "./errors";
import { mintPlatformJwt } from "./jwt";
import {
  loadModelResolutionData,
  resolveModel,
  type ModelProvider,
  type ResolvedModel,
} from "./model-resolution";
import { selectWorker } from "./scheduler";
import type { WorkerClient } from "./worker-client";

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

// ── definition parsing + compile-input resolution ───────────────────────────

function parseDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw errors.draftInvalid(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

interface CompileInputs {
  model: ResolvedModel;
  connections: CompileConnection[];
  skills: CompileSkill[];
}

/**
 * Resolve the definition's referenced resources. Model resolution +
 * allowlist validation run FIRST so their typed errors surface before any
 * compile work. Context resources must be workspace-scoped rows of this
 * workspace or user-scoped rows of the workflow's run-as user (spec §2).
 */
async function resolveCompileInputs(
  db: Db,
  organizationId: string,
  runAsUserId: string,
  definition: WorkflowDefinition,
): Promise<CompileInputs> {
  const data = await loadModelResolutionData(
    db,
    organizationId,
    definition.agent.agentPresetId,
  );
  const model = resolveModel(definition.agent, data);

  const connections: CompileConnection[] = [];
  for (const id of definition.context.mcpConnectionIds) {
    const rows = await db
      .select()
      .from(schema.mcpConnections)
      .where(eq(schema.mcpConnections.id, id))
      .limit(1);
    const row = rows[0];
    const owned =
      row &&
      row.enabled &&
      ((row.scope === "workspace" && row.organizationId === organizationId) ||
        (row.scope === "user" && row.userId === runAsUserId));
    if (!owned) throw errors.contextResourceNotFound("mcp_connection", id);
    connections.push({
      id: row.id,
      name: row.name,
      url: row.url,
      envTokenVar: row.authConfigEncrypted ? mcpTokenEnvName(row.name) : null,
      toolAllow: row.toolAllow ?? null,
      toolBlock: row.toolBlock ?? null,
      approvalPolicy: row.approvalPolicy ?? null,
    });
  }

  const skills: CompileSkill[] = [];
  for (const id of definition.context.skillIds) {
    const rows = await db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, id))
      .limit(1);
    const row = rows[0];
    const owned =
      row &&
      ((row.scope === "workspace" && row.organizationId === organizationId) ||
        (row.scope === "user" && row.userId === runAsUserId));
    if (!owned) throw errors.contextResourceNotFound("skill", id);
    skills.push({
      id: row.id,
      name: row.name,
      description: row.description,
      content: row.content,
    });
  }

  return { model, connections, skills };
}

function compileOrThrow(
  compile: CompileWorkflowFn,
  definition: WorkflowDefinition,
  inputs: CompileInputs,
): CompileResult {
  try {
    return compile({
      definition,
      model: inputs.model,
      connections: inputs.connections,
      skills: inputs.skills,
    });
  } catch (error) {
    if (error instanceof WorkflowCompileError) {
      throw errors.compileFailed(error.issues);
    }
    throw error;
  }
}

// ── DTO mapping ─────────────────────────────────────────────────────────────

function sessionDto(row: SessionRow): AgentSessionDto {
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

function runDto(row: RunRow): RunDto {
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
async function providerForVersion(
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

interface ReadyVersion {
  version: VersionRow;
  definition: WorkflowDefinition;
  artifactKey: string;
}

/** The published version must have a succeeded build with its artifact. */
async function requireReadyVersion(
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

/** ensure-agent on the picked worker with the version's full env. */
async function ensureAgentOnWorker(
  deps: RuntimeDeps,
  workerAddress: string,
  ready: ReadyVersion,
  organizationId: string,
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
  const env = buildAgentEnv({
    runtime: deps.runtime,
    worldUrl: worldUrlFor(deps.runtime.worldDatabaseUrl, worldNameForHash(hash)),
    contentHash: hash,
    provider,
    mcpEnv,
  });
  try {
    await deps.workerClient.ensureAgent(workerAddress, hash, {
      artifactUrl: deps.artifacts.presignGetUrl(ready.artifactKey),
      env,
    });
  } catch (error) {
    throw errors.workerDispatchFailed(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function startTail(
  deps: RuntimeDeps,
  workerAddress: string,
  contentHash: string,
  eveSessionId: string,
  runId: string,
  agentSessionId: string,
): void {
  deps.tailers.start({
    runId,
    agentSessionId,
    openStream: async (startIndex, signal) =>
      deps.workerClient.openEventStream(
        workerAddress,
        contentHash,
        // Minted per (re)connect — short-lived tokens must not expire a resume.
        await mintPlatformJwt(deps.runtime.platformJwtSecret, { claims: { runId } }),
        eveSessionId,
        startIndex,
        signal,
      ),
  });
}

// ── the plugin ──────────────────────────────────────────────────────────────

export function runtimePlugin(deps: RuntimeDeps) {
  const { db, runtime } = deps;

  return new Elysia({ name: "runtime" })
    .use(workspacePlugin(deps.workspaceDeps))
    .onError(({ error, set }) => {
      if (isRuntimeApiError(error)) {
        set.status = error.status;
        return error.toBody();
      }
      return undefined;
    })

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
          db,
          workspace.organizationId,
          workflow.runAsUserId,
          definition,
        );
        const compiled = compileOrThrow(deps.compile, definition, inputs);

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

        // Kick the build (single-flight per hash; cache hit = no-op). A
        // cached-succeeded outcome resolves fast enough to await; a fresh
        // build answers "building" immediately and progresses in background.
        const pre = await deps.buildStore.get(compiled.hash);
        const buildPromise = deps.buildService.ensureBuild(
          compiled.hash,
          compiled.files,
        );
        buildPromise.catch(() => {}); // outcome is persisted; never unhandled

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

    // ── dry-run compile (builder UI) ───────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/versions/dry-run-compile",
      async ({ workspace, params }) => {
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        try {
          const definition = parseDefinition(workflow.draft);
          const inputs = await resolveCompileInputs(
            db,
            workspace.organizationId,
            workflow.runAsUserId,
            definition,
          );
          const compiled = compileOrThrow(deps.compile, definition, inputs);
          return { ok: true as const, contentHash: compiled.hash };
        } catch (error) {
          // Compile/validation problems are the PAYLOAD of a dry run, not a
          // failed request — the builder renders them inline.
          if (isRuntimeApiError(error) && error.status === 422) {
            return { ok: false as const, error: error.toBody().error };
          }
          throw error;
        }
      },
      { requireWorkspace: true },
    )

    // ── create session ─────────────────────────────────────────────────────
    .post(
      "/workspaces/:workspaceId/workflows/:wfId/sessions",
      async ({ workspace, params, body, set }) => {
        const { message } = parseBody(createSessionRequestSchema, body);
        const workflow = await loadWorkflowOwned(
          db,
          workspace.organizationId,
          params.wfId,
        );
        if (!workflow.publishedVersionId) throw errors.workflowNotPublished();
        const ready = await requireReadyVersion(deps, workflow.publishedVersionId);

        await assertUnderRunCap(
          db,
          workspace.organizationId,
          runtime.maxConcurrentRunsPerWorkspace,
        );
        const worker = await selectWorker(db, runtime.workerHeartbeatTtlMs);
        await ensureAgentOnWorker(deps, worker.address, ready, workspace.organizationId);

        const hash = ready.version.contentHash;
        let created;
        try {
          created = await deps.workerClient.createEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(runtime.platformJwtSecret),
            message,
          );
        } catch (error) {
          throw errors.workerDispatchFailed(
            error instanceof Error ? error.message : String(error),
          );
        }

        const principal = {
          workspaceId: workspace.organizationId,
          userId: workspace.userId,
          source: "chat",
        };
        const sessionRows = await db
          .insert(schema.agentSessions)
          .values({
            organizationId: workspace.organizationId,
            workflowId: workflow.id,
            workflowVersionId: ready.version.id,
            eveSessionId: created.sessionId,
            continuationToken: created.continuationToken,
            origin: "chat",
            principal,
            affinityWorkerId: worker.id,
            status: "active",
          })
          .returning();
        const session = sessionRows[0]!;

        const triggerEvent: TriggerEvent = {
          workflowId: workflow.id,
          triggerType: "manual",
          message,
          data: {},
          principal,
        };
        const runRows = await db
          .insert(schema.runs)
          .values({
            agentSessionId: session.id,
            triggerEvent: triggerEvent as unknown as Record<string, unknown>,
            status: "queued",
          })
          .returning();
        const run = runRows[0]!;

        startTail(deps, worker.address, hash, created.sessionId, run.id, session.id);

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
        const ready = await requireReadyVersion(deps, session.workflowVersionId);

        await assertUnderRunCap(
          db,
          workspace.organizationId,
          runtime.maxConcurrentRunsPerWorkspace,
        );
        const worker = await selectWorker(
          db,
          runtime.workerHeartbeatTtlMs,
          session.affinityWorkerId,
        );
        await ensureAgentOnWorker(deps, worker.address, ready, workspace.organizationId);

        const hash = ready.version.contentHash;
        let result;
        try {
          result = await deps.workerClient.continueEveSession(
            worker.address,
            hash,
            await mintPlatformJwt(runtime.platformJwtSecret),
            session.eveSessionId,
            { continuationToken: session.continuationToken, message },
          );
        } catch (error) {
          throw errors.workerDispatchFailed(
            error instanceof Error ? error.message : String(error),
          );
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
          continuationToken: session.continuationToken,
        };
        const runRows = await db
          .insert(schema.runs)
          .values({
            agentSessionId: session.id,
            triggerEvent: triggerEvent as unknown as Record<string, unknown>,
            status: "queued",
          })
          .returning();
        const run = runRows[0]!;

        startTail(deps, worker.address, hash, session.eveSessionId, run.id, session.id);

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
    );
}
