/**
 * Trigger dispatch — the shared path every NON-chat trigger (webhook / form /
 * slack / schedule / manual "Run now") takes from a normalized ingress event
 * to a running eve session against the workflow's agent:
 *
 *   resolve the agent's ready published version → scheduler pick →
 *   renderTaskMessage(instructions, event) → (create | continue)
 *   agent_session + run (cap-locked, task-message + delivery provenance) →
 *   DISPATCH-TIME ALLOWLIST RE-VALIDATION → ensure-agent →
 *   createEveSession(taskMessage) | continueEveSession → persist eve ids →
 *   start the NDJSON tailer.
 *
 * AGENTS-FIRST CONTRACT (2026-07-10 redesign): compiled agents expose ONLY
 * eve's default channel — there is no trigger channel and the TriggerEvent
 * envelope is never sent to the agent. The control plane renders the
 * workflow's instructions against the event (`renderTaskMessage`, shared) and
 * sends THAT string as the eve session message; the envelope is persisted on
 * the run purely as provenance. Slack replies are delivered by the
 * control-plane DeliveryService off the run's terminal event (runs/delivery),
 * so agent env is identical across all dispatch paths — no per-trigger env
 * injection exists anymore.
 *
 * FLOATING BINDING: a workflow snapshot names an agent, not a version. A NEW
 * session runs the agent's CURRENT published version; a CONTINUATION (Slack
 * thread reply) always runs the session's PINNED version — republishing never
 * migrates a live session.
 *
 * DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7 / design correction):
 * a version's model was allowlisted at publish, but the workspace allowlist is
 * mutable — an admin may have removed or disabled the model since. Before
 * running we re-check the version's COMPILED (stored) provider+model against
 * the CURRENT allowlist; if it is now disallowed we FAIL the run with a clear
 * error and never dispatch it. {@link assertModelAllowlistedAtDispatch}.
 *
 * The chat path stays in runtime/routes.ts (sessions target agents directly);
 * this module reuses that file's exported dispatch primitives
 * (ensureAgentOnWorker/startTail/failDispatch/…) so the two paths share one
 * env contract, cap discipline, and tailer wiring.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  renderTaskMessage,
  type ModelProvider,
  type SessionOrigin,
  type TriggerEvent,
  type TriggerPrincipal,
  type WorkflowConfig,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import { publishedWorkflowOf } from "../resources/workflows";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import { errors, isRuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import {
  countDispatchingRuns,
  ensureAgentOnWorker,
  failDispatch,
  requireReadyAgentVersion,
  startTail,
  type ReadyAgentVersion,
  type RuntimeDeps,
} from "./routes";
import { selectWorker } from "./scheduler";

type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

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

// ── Published-workflow → ready-agent resolution ──────────────────────────────

type WorkflowRow = typeof schema.workflows.$inferSelect;

export interface WorkflowDispatchTarget {
  /** The immutable published WorkflowConfig snapshot (never the draft). */
  snapshot: WorkflowConfig;
  /** The delegated agent's CURRENT published version, build-ready. */
  agent: ReadyAgentVersion;
}

/**
 * Resolve a workflow row to its UNATTENDED-dispatch target: kill switch +
 * published snapshot ({@link publishedWorkflowOf}) + the delegated agent's
 * CURRENT published version with a ready build (floating binding — see the
 * module header). Shared by the trigger-ingress routes and the schedule
 * ticker; the manual "Run now" route deliberately bypasses the `enabled`
 * check (an explicit member action) and composes the same pieces itself.
 * Throws typed RuntimeApiErrors: `trigger_disabled` (kill switch),
 * `workflow_not_published`, `workflow_agent_missing`, `agent_not_published`,
 * `version_not_ready`.
 */
export async function resolveWorkflowDispatchTarget(
  deps: RuntimeDeps,
  workflow: WorkflowRow,
): Promise<WorkflowDispatchTarget> {
  if (!workflow.enabled) throw errors.triggerDisabled();
  const { config, agentId } = publishedWorkflowOf(workflow);

  const agentRows = await deps.db
    .select({ publishedVersionId: schema.agents.publishedVersionId })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.organizationId, workflow.organizationId),
      ),
    )
    .limit(1);
  const agentRow = agentRows[0];
  if (!agentRow) throw errors.workflowAgentMissing();
  if (!agentRow.publishedVersionId) throw errors.agentNotPublished();

  const agent = await requireReadyAgentVersion(deps, agentRow.publishedVersionId);
  return { snapshot: config, agent };
}

// ── Trigger dispatch ─────────────────────────────────────────────────────────

export interface DispatchTriggerInput {
  organizationId: string;
  /** The delegating workflow: id (provenance) + its published snapshot. */
  workflow: {
    id: string;
    snapshot: WorkflowConfig;
  };
  /**
   * The agent version to run. For a NEW session this is the agent's CURRENT
   * published version; for a CONTINUATION it MUST be the existing session's
   * pinned version (immutable — republishing never migrates a live session).
   */
  agent: ReadyAgentVersion;
  origin: SessionOrigin;
  /** TriggerEvent provenance type: "webhook" | "form" | "slack" | "schedule" | "manual". */
  triggerType: string;
  principal: TriggerPrincipal;
  /** Normalized ingress payload the instructions render against. */
  ingress: {
    /** Model-facing prompt / primary input (may be empty, e.g. schedules). */
    message: string;
    /** Structured fields `@trigger.*` references resolve against. */
    data: Record<string, unknown>;
  };
  /** Continuation (e.g. a Slack thread reply): reuse this session. */
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
   * typed `session_busy`, which Slack routing logs and drops). Only a LIVE
   * (active/waiting) holder blocks: a closed/error holder is evicted — its
   * key is released so the thread can start over (a terminal session can
   * never be continued). Ignored for continuations.
   */
  newSessionSlackThreadKey?: string;
}

export interface DispatchTriggerResult {
  session: SessionRow;
  run: RunRow;
  /** False when the run was created but failed pre-flight (allowlist). */
  dispatched: boolean;
}

/**
 * Dispatch one trigger event: render the workflow's instructions into the
 * task message, create (or continue) the session + a run, re-validate the
 * allowlist, ensure-agent the version on a live worker, send the task message
 * to the agent's eve session, and start the tailer. Typed RuntimeApiErrors
 * propagate (the ingress route maps them); a now-disallowed model is a FAILED
 * run, not a thrown request error.
 */
export async function dispatchTriggerRun(
  deps: RuntimeDeps,
  input: DispatchTriggerInput,
): Promise<DispatchTriggerResult> {
  const { db, runtime } = deps;
  const version = input.agent.version;
  const hash = version.contentHash;

  // Observe every ingress-triggered dispatch on the fleet metrics registry
  // (GET /internal/metrics), keyed by the real trigger type.
  deps.metrics.recordTrigger(input.triggerType, "received");

  const { worker } = await selectWorker(db, {
    heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
    defaultMaxAgents: runtime.maxAgentsPerWorker,
    versionHash: hash,
    affinityWorkerId: input.existingSession?.affinityWorkerId,
  });

  // The task message IS what the agent receives (agents-first: no envelope
  // crosses the wire). Rendered once, persisted on the run as provenance.
  const taskMessage = renderTaskMessage(input.workflow.snapshot.instructions.markdown, {
    message: input.ingress.message,
    data: input.ingress.data,
  });

  const continuationToken = input.existingSession?.continuationToken ?? undefined;
  const triggerEvent: TriggerEvent = {
    agentId: version.agentId,
    workflowId: input.workflow.id,
    triggerType: input.triggerType,
    message: input.ingress.message,
    data: input.ingress.data,
    principal: input.principal,
    ...(continuationToken ? { continuationToken } : {}),
  };

  // Session + run rows land BEFORE the eve dispatch (202-async window: a crash
  // mid-dispatch leaves a visible failed run, never an untracked, uncapped eve
  // session), inside one advisory-locked transaction so the per-workspace cap
  // is atomic and a busy session cannot double-dispatch. Slack-origin runs are
  // born owing a reply (`delivery_status = pending`) — the DeliveryService
  // settles it off the terminal event.
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
        ...input.principal,
        ...(input.sessionPrincipalExtra ?? {}),
      };
      if (input.newSessionSlackThreadKey) {
        // Serialize "first message of this Slack thread": two concurrent
        // events with distinct event_ids would both see no existing session
        // and mint two. The advisory lock + re-check (backed by the partial
        // unique index on (workflow_id, slack_thread_key)) picks one winner.
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
              eq(schema.agentSessions.workflowId, input.workflow.id),
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
            // it as busy would silently brick the thread forever — every
            // later message would 409 here and Slack routing drops
            // session_busy. Evict its claim (markSession also releases the
            // key on terminal transitions; this covers rows poisoned before
            // that, e.g. by a failed first dispatch) and mint a fresh
            // session under the advisory lock.
            await tx
              .update(schema.agentSessions)
              .set({ slackThreadKey: null })
              .where(eq(schema.agentSessions.id, holder.id));
          } else {
            // LIVE holder (active/waiting) — a concurrent first message won
            // the race; this event is a duplicate turn, not a new thread.
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
          workflowId: input.workflow.id,
          eveSessionId: null,
          continuationToken: null,
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
        triggerEvent: triggerEvent as unknown as Record<string, unknown>,
        taskMessage,
        deliveryStatus: input.origin === "slack" ? "pending" : null,
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
    // Settle a pending outbound-reply marker (slack-origin runs are born
    // owing one) — this run never gets a tail, so the tailer hook will
    // never fire for it. deliver() no-ops for runs owing nothing.
    await deps.delivery?.deliver({
      runId: run.id,
      status: "failed",
      lastAssistantMessage: null,
    });
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
    if (isNewSession || !input.existingSession?.eveSessionId || !continuationToken) {
      // New session (or a session eve never acked): the task message opens
      // the eve session (202 async).
      const created = await deps.workerClient.createEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        taskMessage,
      );
      eveSessionId = created.sessionId;
      await db
        .update(schema.agentSessions)
        .set({
          eveSessionId: created.sessionId,
          continuationToken: created.continuationToken,
          status: "active",
          affinityWorkerId: worker.id,
        })
        .where(eq(schema.agentSessions.id, session.id));
      session.eveSessionId = created.sessionId;
      session.continuationToken = created.continuationToken;
    } else {
      // Continuation (Slack thread reply): the task message rides the SAME
      // eve session as a follow-up turn — continuity is native to eve's
      // session API, no custom channel involved.
      eveSessionId = input.existingSession.eveSessionId;
      const result = await deps.workerClient.continueEveSession(
        worker.address,
        hash,
        await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
        eveSessionId,
        { continuationToken, message: taskMessage },
      );
      if (result.continuationToken) {
        // eve may rotate the token on follow-ups.
        await deps.runStore.updateSessionContinuation(
          session.id,
          result.continuationToken,
        );
        session.continuationToken = result.continuationToken;
      }
      await db
        .update(schema.agentSessions)
        .set({ status: "active", affinityWorkerId: worker.id })
        .where(eq(schema.agentSessions.id, session.id));
    }
  } catch (error) {
    deps.metrics.recordTrigger(input.triggerType, "failed");
    await failDispatch(deps, run.id, error, isNewSession ? { failSessionId: session.id } : {});
    throw error; // unreachable — failDispatch always throws
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
 * channels/teams. A reply in the thread resolves the same session ⇒ same eve
 * session ⇒ threaded continuity.
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
 * closed/errored, and carrying an eve continuation token). Null when the
 * thread is new. Indexed lookup — O(1) per inbound event, not a scan of the
 * org's slack sessions.
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
    row.continuationToken &&
    row.eveSessionId &&
    row.status !== "closed" &&
    row.status !== "error"
  ) {
    return row;
  }
  return null;
}
