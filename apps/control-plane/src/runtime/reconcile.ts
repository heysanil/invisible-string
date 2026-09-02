/**
 * Boot-time run reconciliation (review finding: a control-plane crash leaves
 * runs stuck in queued/running forever — permanently holding per-workspace
 * cap slots, hanging their SSE streams on heartbeats, and never recording
 * eve's durably-completed turn).
 *
 * On startup, four sweeps:
 *
 * 1. INTERRUPTED AGENT RUNS — every queued/running `mode: 'agent'` run:
 *    - the run's dispatch-attempt marker (`runs.started_at`) is set, the
 *      session has an eve session, AND its affinity worker is still live →
 *      restart the tail (tailRun is crash-safe: seq/startIndex derive from
 *      what is already persisted; the terminal gate handles a mid-turn
 *      resume).
 *    - marker NULL → the run's message PROVABLY never reached eve
 *      (dispatch.ts CAS-writes the marker strictly before every eve
 *      create/continue), so there is no turn to tail — even when the
 *      session carries an eve id from EARLIER turns (a thread continuation
 *      that crashed between the run insert and the send). Tailing it would
 *      hang on a turn that was never sent; mark it failed instead, which is
 *      exactly what the agent step's stillborn recovery
 *      (isProvablyUndispatched) needs to re-dispatch safely.
 *    - otherwise (no live worker / no eve session) → mark the run failed
 *      with completedAt so the cap slot frees and any SSE follower
 *      terminates on the persisted status.
 *
 * 2. ABANDONED EVELESS SESSIONS — non-terminal sessions with NO eve session
 *    id whose NEWEST run is terminal with the dispatch-attempt marker SET:
 *    the residue of a dispatch whose eve create raced a Stop or crashed
 *    between the marker write and the id persist. No create from BEFORE the
 *    crash can still be in flight, but reconciliation runs BESIDE live
 *    traffic (index.ts fires it after listen), so each candidate is taken
 *    under its per-session DISPATCH LOCK (session-lock.ts — a held lock
 *    means a dispatch is mid-flight this instant and the candidate is
 *    skipped), the nomination is re-read under that lock, and the close is
 *    an atomic guarded UPDATE (dispatch.ts `healAbandonedEvelessSession` →
 *    `closeEvelessSessionIfStillAbandoned`) that re-asserts eveless +
 *    non-terminal AND the ledger (NOT EXISTS a live run) in its WHERE — a
 *    candidate that gained its eve id, or a run, between snapshot and close
 *    stays untouched. Closing releases any Slack thread-key claim the
 *    thread-claim eviction deliberately refuses to evict for marker-SET
 *    holders (see dispatch.ts). Skipping a held lock is HARMLESS: the
 *    dispatch holding it is the session's exclusive owner and heals an
 *    abandoned row itself (the same primitive, under its own lock) instead
 *    of answering `session_busy` until the next boot. Marker-NULL eveless
 *    holders are left alone: the claim eviction handles theirs lazily, and
 *    an eveless CHAT session (including a post-reset replacement row, which
 *    has no runs at all) stays continuable by design.
 *
 * 2b. PENDING REMOTE CANCELS — canceled agent runs still carrying
 *    `remote_cancel_pending_at`: a Stop settled the row (the marker is set
 *    in the same CAS) but the process died before its guarded remote leg
 *    ran — the accepted eve turn would otherwise keep running forever. Each
 *    is finished through `cancelEveTurnGuarded` (routes.ts): under the
 *    session's dispatch lock it chases eve, or skips as superseded when a
 *    newer run owns the session, or finds nothing to chase — and clears the
 *    marker; a held lock defers it into the background exactly as the live
 *    route does. After sweep 2 on purpose: a session that sweep just closed
 *    has no eve id, so its pending cancels settle as "nothing to chase".
 *
 * 3. INTERRUPTED PIPELINE RUNS — `mode: 'pipeline'` runs (which have no
 *    session or worker to re-tail) are re-driven from their `run_steps`
 *    ledger instead: pipeline/recovery.ts adopts every queued/running/
 *    waiting run whose per-run advisory lock is acquirable. Runs only when
 *    the PipelineRunner is wired.
 *
 * 4. STRANDED DELIVERIES (agents-first §5.5) — TERMINAL runs whose
 *    `delivery_status` is still `pending`: succeeded ones (the process died
 *    between the terminal event and the Slack post) recover the final
 *    stop-message from persisted `run_events` and deliver late
 *    (at-least-once — see runs/delivery.ts); failed/canceled ones — including
 *    the rows sweep 1 just marked failed — settle the ledger (no reply
 *    owed). Runs only when a DeliveryService is wired (the integrations
 *    config may be absent).
 */
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import {
  recoverPipelineRuns,
  type PipelineRecoveryOutcome,
} from "../pipeline/recovery";
import type { PipelineRunner } from "../pipeline/runner";
import type { DeliveryService } from "../runs/delivery";
import { healAbandonedEvelessSession } from "./dispatch";
import { cancelEveTurnGuarded, startTail, type RuntimeDeps } from "./routes";
import { isWorkerLive, toSchedulableWorker } from "./scheduler";
import { sessionDispatchLocksOf } from "./session-lock";

// The guarded close lives beside the dispatch path that shares it
// (dispatch.ts); re-exported so existing importers keep resolving.
export { closeEvelessSessionIfStillAbandoned } from "./dispatch";

export interface ReconcileOutcome {
  resumed: number;
  failed: number;
  /** Abandoned eveless sessions closed by sweep 2 (thread claims released). */
  sessionsClosed: number;
  /**
   * Pending remote cancels (sweep 2b): settled synchronously under the
   * session lock vs deferred into the background because a dispatch held it.
   */
  remoteCancels: { settled: number; deferred: number };
  /** Pipeline-run sweep tally (zeros when no PipelineRunner is wired). */
  pipelines: PipelineRecoveryOutcome;
  /** Stranded-delivery sweep tally (zeros when no DeliveryService is wired). */
  deliveries: { delivered: number; failed: number; skipped: number };
}

export interface ReconcileOptions {
  /** Re-drives interrupted pipeline runs from their step ledgers. */
  pipelines?: PipelineRunner;
  /** Settles terminal runs stuck with a pending outbound reply. */
  delivery?: DeliveryService;
  now?: Date;
}

export async function reconcileInterruptedRuns(
  deps: RuntimeDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const now = options.now ?? new Date();
  const rows = await deps.db
    .select({
      run: schema.runs,
      session: schema.agentSessions,
      worker: schema.workers,
      contentHash: schema.agentVersions.contentHash,
    })
    .from(schema.runs)
    .innerJoin(
      schema.agentSessions,
      eq(schema.runs.agentSessionId, schema.agentSessions.id),
    )
    .innerJoin(
      schema.agentVersions,
      eq(schema.agentSessions.agentVersionId, schema.agentVersions.id),
    )
    .leftJoin(
      schema.workers,
      eq(schema.agentSessions.affinityWorkerId, schema.workers.id),
    )
    .where(
      and(
        inArray(schema.runs.status, ["queued", "running"]),
        // Pipeline runs have no session/worker to resume from — sweep 2
        // (recoverPipelineRuns) re-drives them; the inner session join above
        // would exclude them anyway, but the filter keeps intent explicit.
        eq(schema.runs.mode, "agent"),
      ),
    );

  const outcome: ReconcileOutcome = {
    resumed: 0,
    failed: 0,
    sessionsClosed: 0,
    remoteCancels: { settled: 0, deferred: 0 },
    pipelines: { resumed: 0, locked: 0, failed: 0 },
    deliveries: { delivered: 0, failed: 0, skipped: 0 },
  };
  for (const row of rows) {
    // A tail already running in THIS process (normal operation) is left
    // alone — reconcile only adopts orphans.
    if (deps.tailers.get(row.run.id)) continue;

    // THE MARKER IS THE AUTHORITY (dispatch.ts module doc): `started_at`
    // NULL means this run's eve create/continue was provably never issued —
    // even when the session carries an eve id from EARLIER turns (a thread
    // continuation interrupted between the run insert and the send).
    // Tailing such a run would follow a turn that was never sent (a hang,
    // or the previous turn's leftovers misclassified); fail it instead so
    // the agent step's stillborn recovery can re-dispatch safely.
    const markerArmed = row.run.startedAt !== null;

    const workerLive =
      row.worker !== null &&
      isWorkerLive(
        toSchedulableWorker(row.worker),
        now,
        deps.runtime.workerHeartbeatTtlMs,
      );

    if (markerArmed && workerLive && row.session.eveSessionId) {
      startTail(
        deps,
        row.worker!.address,
        row.contentHash,
        row.session.eveSessionId,
        row.run.id,
        row.session.id,
      );
      outcome.resumed += 1;
    } else {
      await deps.runStore.markRun(row.run.id, {
        status: "failed",
        error: markerArmed
          ? "control plane restarted while the run was active (no live worker to resume from)"
          : "control plane restarted before the run's message was sent (dispatch never reached the agent)",
        completedAt: now,
      });
      outcome.failed += 1;
    }
  }

  // Sweep 2 — ABANDONED EVELESS SESSIONS (module doc): after sweep 1 has
  // settled the interrupted runs, a non-terminal session with no eve id
  // whose newest run is terminal AND marker-set can only be the residue of a
  // dispatch that died (or was canceled) after arming but before the eve id
  // persisted — no create from BEFORE the crash is still in flight, so close
  // it and free its Slack thread-key claim. Live traffic runs beside this
  // sweep (index.ts fires it after listen), so each candidate is handled
  // under its per-session dispatch lock (skip when held — a dispatch is
  // mid-flight), the nomination is re-read under the lock, and the close
  // itself is a guarded UPDATE ({@link closeEvelessSessionIfStillAbandoned})
  // whose WHERE re-asserts eveless + non-terminal + no-live-run — a
  // candidate that gained its eve id (or a run) after this snapshot is
  // untouched, and only rows actually updated are counted.
  const evelessCandidates = await deps.db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        isNull(schema.agentSessions.eveSessionId),
        notInArray(schema.agentSessions.status, ["closed", "error"]),
      ),
    );
  const sessionLocks = sessionDispatchLocksOf(deps);
  for (const candidate of evelessCandidates) {
    // The candidate's DISPATCH LOCK first (session-lock.ts): a held lock
    // means a live dispatch owns the session this instant — its eve create
    // may be mid-flight — so the sweep skips it entirely (the next boot, or
    // the dispatch's own settlement, handles the row). The nomination read
    // then happens UNDER the lock, so no lock-honoring dispatch can change
    // the ledger between nomination and close; the guarded UPDATE's ledger
    // re-assertion remains as the atomic belt for anything else.
    const lock = await sessionLocks.acquire(candidate.id);
    if (!lock) {
      deps.logger.debug("reconcile.eveless_candidate_skipped", {
        sessionId: candidate.id,
        fields: { reason: "a dispatch holds the session's critical section" },
      });
      continue;
    }
    try {
      if (await healAbandonedEvelessSession(deps, candidate.id)) {
        outcome.sessionsClosed += 1;
      }
    } finally {
      await lock.release();
    }
  }

  // Sweep 2b — PENDING REMOTE CANCELS (module doc): canceled agent runs
  // whose durable remote-cancel obligation was never met. The guarded chase
  // clears the marker itself; a held lock defers it (the marker stays until
  // the deferred attempt completes, or the next boot).
  const pendingCancels = await deps.db
    .select({ runId: schema.runs.id, sessionId: schema.runs.agentSessionId })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.mode, "agent"),
        eq(schema.runs.status, "canceled"),
        isNotNull(schema.runs.remoteCancelPendingAt),
        isNotNull(schema.runs.agentSessionId),
      ),
    );
  for (const pending of pendingCancels) {
    if (!pending.sessionId) continue;
    if (await cancelEveTurnGuarded(deps, pending.sessionId, pending.runId)) {
      outcome.remoteCancels.settled += 1;
    } else {
      outcome.remoteCancels.deferred += 1;
    }
  }

  if (options.pipelines) {
    // Before the delivery sweep on purpose: an unresumable pipeline run is
    // marked failed here, and failOutright settles its own delivery ledger.
    outcome.pipelines = await recoverPipelineRuns({
      db: deps.db,
      runner: options.pipelines,
      logger: deps.logger,
    });
  }

  if (options.delivery) {
    outcome.deliveries = await options.delivery.recoverPending();
  }
  return outcome;
}
