/**
 * Trigger dispatch (docs/PLAN.md Phase 3 task 3.2) — the shared path every
 * NON-chat trigger (webhook / form / slack) takes from a normalized
 * TriggerEvent to a running eve session:
 *
 *   resolve published+ready version → DISPATCH-TIME ALLOWLIST RE-VALIDATION →
 *   scheduler pick → (create | continue) agent_session + run (cap-locked) →
 *   ensure-agent (+ slack bot token) → POST the envelope to the compiled
 *   agent's `/eve/v1/platform/<trigger>` channel (version-bound JWT) →
 *   persist eve session ids → start the NDJSON tailer.
 *
 * DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7 / design correction):
 * a version's model was allowlisted at publish, but the workspace allowlist is
 * mutable — an admin may have removed or disabled the model since. Before
 * running we re-check the version's COMPILED (stored) provider+model against
 * the CURRENT allowlist; if it is now disallowed we FAIL the run with a clear
 * error and never dispatch it. {@link assertModelAllowlistedAtDispatch}.
 *
 * The chat/manual path stays in runtime/routes.ts (it drives eve's default
 * channel via POST /eve/v1/session); this module reuses that file's exported
 * dispatch primitives (ensureAgentOnWorker/startTail/failDispatch/…) so the
 * two paths share one env contract, cap discipline, and tailer wiring.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  SessionOrigin,
  TriggerEvent,
  TriggerPrincipal,
} from "@invisible-string/shared";

import type { Db, DbClient } from "../db";
import { assertUnderRunCap, lockWorkspaceRunCap } from "./caps";
import { errors, isRuntimeApiError } from "./errors";
import { agentJwtParams, mintPlatformJwt } from "./jwt";
import type { ModelProvider } from "./model-resolution";
import {
  countDispatchingRuns,
  ensureAgentOnWorker,
  failDispatch,
  startTail,
  type ReadyVersion,
  type RuntimeDeps,
} from "./routes";
import { selectWorker } from "./scheduler";

type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;
type VersionModel = { modelProvider: ModelProvider | null; modelId: string | null };

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
 * allowed (removed or disabled). Legacy versions with no stored provider/model
 * cannot be re-checked and are allowed through (they predate the stored-model
 * contract; the compile-time check still gated them).
 */
export async function assertModelAllowlistedAtDispatch(
  db: Db,
  organizationId: string,
  version: VersionModel,
): Promise<void> {
  if (!version.modelProvider || !version.modelId) return;
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

// ── Trigger dispatch ─────────────────────────────────────────────────────────

export interface DispatchTriggerInput {
  organizationId: string;
  workflowId: string;
  /**
   * The version to run. For a NEW session this is the workflow's published
   * version; for a CONTINUATION it MUST be the existing session's pinned
   * version (immutable — republishing never migrates a live session).
   */
  ready: ReadyVersion;
  origin: SessionOrigin;
  /** Compiled channel route segment: "webhook" | "form" | "slack". */
  triggerType: string;
  principal: TriggerPrincipal;
  message: string;
  data: Record<string, unknown>;
  /** Continuation (e.g. a Slack thread reply): reuse this session. */
  existingSession?: SessionRow;
  /**
   * Extra spawn-time-only agent env, e.g. the Slack team bot token
   * `SLACK_BOT_TOKEN` for a slack-triggered version (rides the same secret env
   * channel as provider keys / MCP tokens; never written to disk or logs).
   */
  extraAgentEnv?: Record<string, string>;
  /**
   * Extra fields folded into a NEW session's stored `principal` jsonb (e.g.
   * `slackThreadKey` so future thread replies map back to this session).
   * Ignored for continuations.
   */
  sessionPrincipalExtra?: Record<string, unknown>;
}

export interface DispatchTriggerResult {
  session: SessionRow;
  run: RunRow;
  /** False when the run was created but failed pre-flight (allowlist). */
  dispatched: boolean;
}

/**
 * Dispatch one trigger event through a compiled agent's custom trigger channel.
 * Creates (or continues) the session + a run, re-validates the allowlist,
 * ensure-agents the version on a live worker, POSTs the envelope, and starts
 * the tailer. Typed RuntimeApiErrors propagate (the ingress route maps them);
 * a now-disallowed model is a FAILED run, not a thrown request error.
 */
export async function dispatchTriggerRun(
  deps: RuntimeDeps,
  input: DispatchTriggerInput,
): Promise<DispatchTriggerResult> {
  const { db, runtime } = deps;
  const hash = input.ready.version.contentHash;

  // Observe every ingress-triggered dispatch on the fleet metrics registry
  // (GET /internal/metrics), keyed by the real trigger type (webhook/form/slack).
  deps.metrics.recordTrigger(input.triggerType, "received");

  const { worker } = await selectWorker(db, {
    heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
    defaultMaxAgents: runtime.maxAgentsPerWorker,
    versionHash: hash,
    affinityWorkerId: input.existingSession?.affinityWorkerId,
  });

  const continuationToken = input.existingSession?.continuationToken ?? undefined;
  const triggerEvent: TriggerEvent = {
    workflowId: input.workflowId,
    triggerType: input.triggerType,
    message: input.message,
    data: input.data,
    principal: input.principal,
    ...(continuationToken ? { continuationToken } : {}),
  };

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
        ...input.principal,
        ...(input.sessionPrincipalExtra ?? {}),
      };
      const inserted = await tx
        .insert(schema.agentSessions)
        .values({
          organizationId: input.organizationId,
          workflowId: input.workflowId,
          workflowVersionId: input.ready.version.id,
          eveSessionId: null,
          continuationToken: null,
          origin: input.origin,
          principal,
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
        status: "queued",
      })
      .returning();
    return { session: sessionRow, run: runRows[0]! };
  });

  const isNewSession = input.existingSession === undefined;

  // DISPATCH-TIME ALLOWLIST RE-VALIDATION: fail the run (do not execute) when
  // the version's compiled model is no longer allowlisted.
  try {
    await assertModelAllowlistedAtDispatch(db, input.organizationId, input.ready.version);
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
  let created;
  try {
    await ensureAgentOnWorker(
      deps,
      { id: worker.id, address: worker.address },
      input.ready,
      input.organizationId,
      input.extraAgentEnv,
    );
    created = await deps.workerClient.postTriggerEvent(
      worker.address,
      hash,
      await mintPlatformJwt(jwt.secret, { audience: jwt.audience }),
      input.triggerType,
      triggerEvent as unknown as Record<string, unknown>,
    );
  } catch (error) {
    deps.metrics.recordTrigger(input.triggerType, "failed");
    await failDispatch(deps, run.id, error, isNewSession ? { failSessionId: session.id } : {});
    throw error; // unreachable — failDispatch always throws
  }

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

  startTail(deps, worker.address, hash, created.sessionId, run.id, session.id);

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
 * slack origin, matching `principal.slackThreadKey`, not closed/errored, and
 * carrying an eve continuation token). Null when the thread is new.
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
      ),
    );
  for (const row of rows) {
    const key = (row.principal as { slackThreadKey?: unknown } | null)?.slackThreadKey;
    if (
      key === threadKey &&
      row.continuationToken &&
      row.eveSessionId &&
      row.status !== "closed" &&
      row.status !== "error"
    ) {
      return row;
    }
  }
  return null;
}
