/**
 * Rendered-run dispatch — the shared path from an ALREADY-RENDERED task
 * message to a running eve session (workflow-pipelines redesign):
 *
 *   scheduler pick → session + run rows (cap-locked, provenance attached) →
 *   DISPATCH-TIME ALLOWLIST RE-VALIDATION → ensure-agent →
 *   createEveSession(request) | continueEveSession → persist eve ids →
 *   start the NDJSON tailer.
 *
 * WHO DISPATCHES WHAT. Workflow dispatch no longer flows through here as a
 * unit: a trigger event on a workflow ALWAYS starts a PIPELINE run
 * (`startPipelineRun`, pipeline/runner.ts) that the control plane interprets
 * itself. The one thing that still opens eve sessions on behalf of a workflow
 * is the pipeline's `agent` STEP (pipeline/steps/agent.ts), which renders its
 * instructions against the run scope and calls {@link dispatchRenderedRun} to
 * spawn a CHILD run — its own `runs` + `agent_sessions` rows, mode `agent`,
 * linked back via `run_steps.child_run_id`. Chat dispatch stays in
 * runtime/routes.ts (sessions target agents directly) and shares this file's
 * exported primitives (ensureAgentOnWorker/startTail/failDispatch/…) so both
 * paths keep one env contract, cap discipline, and tailer wiring.
 *
 * AGENTS-FIRST CONTRACT (2026-07-10 redesign, unchanged): compiled agents
 * expose ONLY eve's default channel — the TriggerEvent envelope is never sent
 * to the agent; the rendered message IS what it receives, and the envelope is
 * persisted on the run purely as provenance. Slack replies are delivered by
 * the control-plane DeliveryService off the PARENT pipeline run's explicit
 * `onComplete.slackReply` (runs/delivery.ts) — child runs never deliver.
 *
 * FLOATING BINDING: an agent step names an agent, not a version. A NEW
 * session runs the agent's CURRENT published version; a CONTINUATION (Slack
 * thread reply through a `session: "thread"` step) always runs the session's
 * PINNED version — republishing never migrates a live thread.
 *
 * DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7 / design correction):
 * a version's model was allowlisted at publish, but the workspace allowlist is
 * mutable — an admin may have removed or disabled the model since. Before
 * running we re-check the version's COMPILED (stored) provider+model against
 * the CURRENT allowlist; if it is now disallowed we FAIL the run with a clear
 * error and never dispatch it. {@link assertModelAllowlistedAtDispatch}.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  workflowConfigSchema,
  type EveSessionMode,
  type ModelProvider,
  type SessionOrigin,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import { errors, isRuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import {
  countDispatchingRuns,
  ensureAgentOnWorker,
  failEveDispatch,
  startTail,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "./routes";
import { selectWorker } from "./scheduler";

type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

// ── Dispatch-time model-allowlist re-validation ──────────────────────────────

export interface AllowlistEntry {
  provider: ModelProvider;
  modelId: string;
  enabled: boolean;
}

/** Pure: is `provider/modelId` present AND enabled on the allowlist? */
export function isModelAllowlisted(
  allowlist: readonly AllowlistEntry[],
  provider: ModelProvider,
  modelId: string,
): boolean {
  return allowlist.some(
    (row) => row.enabled && row.provider === provider && row.modelId === modelId,
  );
}

/**
 * Re-check a version's compiled model against the CURRENT workspace allowlist.
 * Throws {@link errors.modelDisallowedAtDispatch} when the model is no longer
 * allowed (removed or disabled). `agent_versions.model_provider`/`model_id`
 * are NOT NULL — every version can be re-checked.
 */
export async function assertModelAllowlistedAtDispatch(
  db: Db,
  organizationId: string,
  version: { modelProvider: ModelProvider; modelId: string },
): Promise<void> {
  const rows = await db
    .select({
      provider: schema.modelAllowlist.provider,
      modelId: schema.modelAllowlist.modelId,
      enabled: schema.modelAllowlist.enabled,
    })
    .from(schema.modelAllowlist)
    .where(eq(schema.modelAllowlist.organizationId, organizationId));
  if (!isModelAllowlisted(rows, version.modelProvider, version.modelId)) {
    throw errors.modelDisallowedAtDispatch(version.modelId);
  }
}

// ── Published pipeline resolution ────────────────────────────────────────────

/**
 * `TriggerEvent.agentId` placeholder for PIPELINE PARENT runs. The envelope's
 * schema requires an agent uuid, but a pipeline run binds no single agent —
 * agents bind per STEP, and each `agent` step's CHILD run carries the real
 * id. The nil uuid keeps the shared schema satisfied while reading
 * unambiguously as "no agent" (it can never collide with a generated v4 id).
 */
export const PIPELINE_TRIGGER_AGENT_ID =
  "00000000-0000-0000-0000-000000000000";

/**
 * Parse a workflow row's PUBLISHED pipeline snapshot. Throws the typed
 * `workflow_not_published` both for a never-published row and for a published
 * jsonb that no longer parses (a pre-pipelines draft shape on a dev stack —
 * the PR notes those stacks reset via `docker compose down -v`).
 */
export function publishedPipelineConfigOf(workflow: WorkflowRow): WorkflowConfig {
  if (!workflow.published) throw errors.workflowNotPublished();
  const parsed = workflowConfigSchema.safeParse(workflow.published);
  if (!parsed.success) throw errors.workflowNotPublished();
  return parsed.data;
}

/**
 * The UNATTENDED-ingress variant: kill switch first, then the published
 * snapshot. The manual "Run now" route deliberately skips the `enabled`
 * check (an explicit member action) and calls
 * {@link publishedPipelineConfigOf} directly.
 */
export function resolveEnabledPipeline(workflow: WorkflowRow): WorkflowConfig {
  if (!workflow.enabled) throw errors.triggerDisabled();
  return publishedPipelineConfigOf(workflow);
}

// ── Rendered-run dispatch (the agent step's child-run path) ─────────────────

export interface DispatchRenderedRunInput {
  organizationId: string;
  /**
   * Workflow provenance for the child run — set on BOTH the session row and
   * the run row (`runs.workflow_id`), so a workflow's Runs surface can find
   * its children without walking run_steps. Null only for callers outside
   * any workflow (none today — chat has its own path).
   */
  workflowId: string | null;
  /**
   * The agent version to run. For a NEW session this is the agent's CURRENT
   * published version; for a CONTINUATION it MUST be the existing session's
   * pinned version (immutable — republishing never migrates a live session).
   */
  agent: ReadyAgentVersion;
  origin: SessionOrigin;
  /** Metrics bucket + TriggerEvent provenance type (e.g. "pipeline", "slack"). */
  triggerType: string;
  /**
   * The rendered message the agent receives VERBATIM as the eve session
   * message (an agent step's instructions rendered against the run scope).
   * Persisted on the run as `task_message`.
   */
  taskMessage: string;
  /** Provenance envelope persisted on `runs.trigger_event` (never sent). */
  triggerEvent: TriggerEvent;
  /** Continuation (a Slack thread reply via `session: "thread"`): reuse this session. */
  existingSession?: SessionRow;
  /**
   * Extra fields folded into a NEW session's stored `principal` jsonb (e.g.
   * `slackThreadKey` so future thread replies map back to this session).
   * Ignored for continuations.
   */
  sessionPrincipalExtra?: Record<string, unknown>;
  /**
   * Slack thread ↔ session key for a NEW slack session (see
   * {@link slackThreadKey}). Persisted on the indexed `slack_thread_key`
   * column; a per-key advisory lock + in-transaction re-check make two racing
   * first-messages of one thread resolve to ONE session (the loser gets a
   * typed `session_busy`, which the agent step retries). Only a LIVE
   * (active/waiting) holder blocks: a closed/error holder is evicted — its
   * key is released so the thread can start over (a terminal session can
   * never be continued). Ignored for continuations.
   *
   * That eviction is STATUS-driven and therefore only sees rows the platform
   * already knows are dead. eve 0.31 adds a second case — a row that still
   * reads `active` while its eve session is gone — which is released by the
   * 409 `session_not_active` handler in `failEveDispatch` instead.
   */
  newSessionSlackThreadKey?: string;
  /**
   * eve create options for a NEW session (ignored for continuations): the
   * pipeline agent step sends `mode: "task"` for `session: "fresh"` children
   * and adds `outputSchema` when the step declares one (spike finding 36).
   * Thread sessions stay conversational — a human can answer them in Slack.
   */
  eveCreate?: {
    mode?: EveSessionMode;
    outputSchema?: Record<string, unknown>;
  };
}

export interface DispatchRenderedRunResult {
  session: SessionRow;
  run: RunRow;
  /** False when the run was created but failed pre-flight (allowlist). */
  dispatched: boolean;
}

/**
 * Dispatch one rendered task message: create (or continue) the session + a
 * run, re-validate the allowlist, ensure-agent the version on a live worker,
 * send the message to the agent's eve session, and start the tailer. Typed
 * RuntimeApiErrors propagate (the agent step classifies them); a
 * now-disallowed model is a FAILED run (`dispatched: false`), not a thrown
 * request error.
 *
 * Child runs NEVER owe a delivery (`delivery_status` stays null): pipelines
 * deliver explicitly via the PARENT run's `onComplete.slackReply`.
 */
export async function dispatchRenderedRun(
  deps: RuntimeDeps,
  input: DispatchRenderedRunInput,
): Promise<DispatchRenderedRunResult> {
  const { db, runtime } = deps;
  const version = input.agent.version;
  const hash = version.contentHash;

  // Observe every dispatch on the fleet metrics registry, keyed by the
  // caller's trigger type ("pipeline" for agent-step children).
  deps.metrics.recordTrigger(input.triggerType, "received");

  const { worker } = await selectWorker(db, {
    heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
    defaultMaxAgents: runtime.maxAgentsPerWorker,
    versionHash: hash,
    affinityWorkerId: input.existingSession?.affinityWorkerId,
  });

  // Session + run rows land BEFORE the eve dispatch (202-async window: a crash
  // mid-dispatch leaves a visible failed run, never an untracked, uncapped eve
  // session), inside one advisory-locked transaction so the per-workspace cap
  // is atomic and a busy session cannot double-dispatch.
  const { session, run } = await db.transaction(async (tx: DbClient) => {
    await lockWorkspaceRunCap(tx, input.organizationId);
    if (input.existingSession) {
      if ((await countDispatchingRuns(tx, input.existingSession.id)) > 0) {
        throw errors.sessionBusy();
      }
    }
    await assertUnderRunCap(
      tx,
      input.organizationId,
      runtime.maxConcurrentRunsPerWorkspace,
    );

    let sessionRow = input.existingSession;
    if (!sessionRow) {
      const principal = {
        ...input.triggerEvent.principal,
        ...(input.sessionPrincipalExtra ?? {}),
      };
      if (input.newSessionSlackThreadKey) {
        // The thread claim is scoped by workflow (partial unique index on
        // (workflow_id, slack_thread_key)) — a caller passing a thread key
        // without workflow provenance is a programming error, not a request
        // condition.
        const workflowId = input.workflowId;
        if (!workflowId) {
          throw new Error(
            "dispatchRenderedRun: newSessionSlackThreadKey requires a workflowId",
          );
        }
        // Serialize "first message of this Slack thread": two concurrent
        // agent-step dispatches with distinct parent runs would both see no
        // existing session and mint two. The advisory lock + re-check
        // (backed by the partial unique index on (workflow_id,
        // slack_thread_key)) picks one winner.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${input.newSessionSlackThreadKey})::bigint)`,
        );
        const existing = await tx
          .select({
            id: schema.agentSessions.id,
            status: schema.agentSessions.status,
          })
          .from(schema.agentSessions)
          .where(
            and(
              eq(schema.agentSessions.workflowId, workflowId),
              eq(
                schema.agentSessions.slackThreadKey,
                input.newSessionSlackThreadKey,
              ),
            ),
          )
          .limit(1);
        const holder = existing[0];
        if (holder) {
          if (holder.status === "closed" || holder.status === "error") {
            // DEAD holder: a terminal session can never continue this thread
            // (findSlackThreadSession skips closed/error rows), so treating
            // it as busy would silently brick the thread forever. Evict its
            // claim (markSession also releases the key on terminal
            // transitions; this covers rows poisoned before that, e.g. by a
            // failed first dispatch) and mint a fresh session under the
            // advisory lock.
            await tx
              .update(schema.agentSessions)
              .set({ slackThreadKey: null })
              .where(eq(schema.agentSessions.id, holder.id));
          } else {
            // LIVE holder (active/waiting) — a concurrent dispatch won the
            // race; this one is a duplicate turn, not a new thread.
            throw errors.sessionBusy();
          }
        }
      }
      const inserted = await tx
        .insert(schema.agentSessions)
        .values({
          organizationId: input.organizationId,
          agentId: version.agentId,
          agentVersionId: version.id,
          workflowId: input.workflowId,
          eveSessionId: null,
          origin: input.origin,
          principal,
          slackThreadKey: input.newSessionSlackThreadKey ?? null,
          affinityWorkerId: worker.id,
          status: "active",
        })
        .returning();
      sessionRow = inserted[0]!;
    }

    const runRows = await tx
      .insert(schema.runs)
      .values({
        agentSessionId: sessionRow.id,
        organizationId: input.organizationId,
        workflowId: input.workflowId,
        mode: "agent",
        triggerEvent: input.triggerEvent as unknown as Record<string, unknown>,
        taskMessage: input.taskMessage,
        // Child runs never deliver — the PARENT pipeline run's explicit
        // onComplete owns the reply.
        deliveryStatus: null,
        status: "queued",
      })
      .returning();
    return { session: sessionRow, run: runRows[0]! };
  });

  const isNewSession = input.existingSession === undefined;

  // DISPATCH-TIME ALLOWLIST RE-VALIDATION: fail the run (do not execute) when
  // the version's compiled model is no longer allowlisted.
  try {
    await assertModelAllowlistedAtDispatch(db, input.organizationId, version);
  } catch (error) {
    if (!isRuntimeApiError(error)) throw error;
    deps.metrics.recordTrigger(input.triggerType, "failed");
    const detail = error.message;
    await deps.runStore.markRun(run.id, {
      status: "failed",
      error: detail,
      completedAt: new Date(),
    });
    if (isNewSession) await deps.runStore.markSession(session.id, "error");
    deps.bus.publish(run.id, {
      kind: "status",
      frame: { runId: run.id, status: "failed", error: detail },
    });
    return {
      session,
      run: { ...run, status: "failed", error: detail },
      dispatched: false,
    };
  }

  const jwt = agentJwtParams(runtime.platformJwtSecret, hash);
  let eveSessionId: string;
  try {
    await ensureAgentOnWorker(
      deps,
      { id: worker.id, address: worker.address },
      input.agent,
      input.organizationId,
    );
    // 0.31: a session is continuable iff it HAS an eve session id and this
    // dispatch is a continuation — the old continuation-token term must not
    // come back (the column is never written; see routes.ts).
    if (isNewSession || !input.existingSession?.eveSessionId) {
      // New session (or a session eve never acked): the task message opens
      // the eve session (202 async), carrying the caller's create options —
      // `mode: "task"` (+ outputSchema) for fresh agent-step children.
      const created = await deps.workerClient.createEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        {
          message: input.taskMessage,
          ...(input.eveCreate?.mode ? { mode: input.eveCreate.mode } : {}),
          ...(input.eveCreate?.outputSchema
            ? { outputSchema: input.eveCreate.outputSchema }
            : {}),
        },
      );
      eveSessionId = created.sessionId;
      await db
        .update(schema.agentSessions)
        .set({
          eveSessionId: created.sessionId,
          status: "active",
          affinityWorkerId: worker.id,
        })
        .where(eq(schema.agentSessions.id, session.id));
      session.eveSessionId = created.sessionId;
    } else {
      // Continuation (Slack thread reply): the task message rides the SAME
      // eve session as a follow-up turn — continuity is native to eve's
      // session API. Addressed by id alone; the body is exactly `{message}`
      // (send XOR respond, and a stray `continuationToken` key would be a
      // hard 400).
      eveSessionId = input.existingSession.eveSessionId;
      await deps.workerClient.continueEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        eveSessionId,
        { message: input.taskMessage },
      );
      await db
        .update(schema.agentSessions)
        .set({ status: "active", affinityWorkerId: worker.id })
        .where(eq(schema.agentSessions.id, session.id));
    }
  } catch (error) {
    deps.metrics.recordTrigger(input.triggerType, "failed");
    // EVE-DRIVEN EVICTION (the 0.31 half of the stuck-claim story) lives in
    // failEveDispatch: the status-driven eviction in the advisory-locked
    // insert above only fires for rows the PLATFORM already knows are dead,
    // and 0.31 lets eve's truth diverge from `agent_sessions.status`
    // indefinitely. Without an eve-driven release the continuation 409s
    // forever and the Slack thread is bricked. The NEXT agent-step attempt
    // finds no holder and mints a fresh session under the freed key.
    await failEveDispatch(
      deps,
      run.id,
      session.id,
      error,
      isNewSession ? { failSessionId: session.id } : {},
    );
    throw error; // unreachable — failEveDispatch always throws
  }

  startTail(deps, worker.address, hash, eveSessionId, run.id, session.id);

  deps.metrics.recordTrigger(input.triggerType, "dispatched");
  return { session, run, dispatched: true };
}

// ── Slack thread ↔ session mapping ───────────────────────────────────────────

/**
 * Stable key mapping a Slack thread onto an agent_session, stored on the
 * session's `principal` jsonb as `slackThreadKey`. Namespaced by integration +
 * channel so a `thread_ts` (unique only within a channel) can't collide across
 * channels/teams. The Slack ingress stamps the SAME key into the pipeline
 * run's `TriggerEvent.data.slackThreadKey`, which is how it reaches the two
 * downstream consumers that need it: the `agent` step (`session: "thread"`
 * continuity) and the DeliveryService (routing `onComplete.slackReply`).
 */
export function slackThreadKey(
  integrationId: string,
  channel: string,
  threadTs: string,
): string {
  return `${integrationId}:${channel}:${threadTs}`;
}

/**
 * Find the continuable agent_session a Slack thread maps to (same workflow,
 * slack origin, matching the indexed `slack_thread_key` column, not
 * closed/errored, and carrying an eve session id). Null when the thread is
 * new. Indexed lookup — O(1) per agent-step dispatch, not a scan of the
 * org's slack sessions.
 *
 * The predicate is `eve_session_id` + non-terminal status; it deliberately
 * ignores the dead `continuation_token` column (never written since eve
 * 0.31). A row that is live here but dead inside eve is caught one layer
 * down: the dispatch's 409 `session_not_active` handler evicts the claim.
 */
export async function findSlackThreadSession(
  db: Db,
  organizationId: string,
  workflowId: string,
  threadKey: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.organizationId, organizationId),
        eq(schema.agentSessions.workflowId, workflowId),
        eq(schema.agentSessions.origin, "slack"),
        eq(schema.agentSessions.slackThreadKey, threadKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    row &&
    row.eveSessionId &&
    row.status !== "closed" &&
    row.status !== "error"
  ) {
    return row;
  }
  return null;
}
