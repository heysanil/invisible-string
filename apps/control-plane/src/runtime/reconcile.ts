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
 *    traffic (index.ts fires it after listen), so the close is an atomic
 *    guarded UPDATE ({@link closeEvelessSessionIfStillAbandoned}) that
 *    re-asserts eveless + non-terminal in its WHERE — a candidate that
 *    gained its eve id between snapshot and close stays untouched. Closing
 *    releases any Slack thread-key claim the thread-claim eviction now
 *    deliberately refuses to evict for marker-SET holders (see dispatch.ts).
 *    Marker-NULL eveless holders are left alone: the claim eviction handles
 *    theirs lazily, and an eveless CHAT session (including a post-reset
 *    replacement row, which has no runs at all) stays continuable by design.
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
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { Db } from "../db";
import {
  recoverPipelineRuns,
  type PipelineRecoveryOutcome,
} from "../pipeline/recovery";
import type { PipelineRunner } from "../pipeline/runner";
import type { DeliveryService } from "../runs/delivery";
import { startTail, type RuntimeDeps } from "./routes";
import { isWorkerLive, toSchedulableWorker } from "./scheduler";

/**
 * Sweep-2 close as an ATOMIC GUARDED UPDATE. The snapshot that nominated the
 * candidate is STALE by the time the close runs — boot reconciliation is
 * fired after the server starts listening (index.ts), so live traffic can
 * give a snapshotted session its eve id (and finish a run on it) between
 * selection and close. Closing on the snapshot's say-so would kill a healthy
 * session; instead the eveless + non-terminal predicate is re-asserted
 * INSIDE the UPDATE's WHERE, so a now-healthy row is untouched by
 * construction (the row is re-read under its lock, never trusted from the
 * snapshot). The thread-key release rides the same statement, mirroring
 * markSession's terminal transition. Returns true iff THIS call closed the
 * row — callers count only rows actually updated.
 */
export async function closeEvelessSessionIfStillAbandoned(
  db: Db,
  agentSessionId: string,
): Promise<boolean> {
  const closed = await db
    .update(schema.agentSessions)
    .set({ status: "closed", slackThreadKey: null })
    .where(
      and(
        eq(schema.agentSessions.id, agentSessionId),
        isNull(schema.agentSessions.eveSessionId),
        notInArray(schema.agentSessions.status, ["closed", "error"]),
      ),
    )
    .returning({ id: schema.agentSessions.id });
  return closed.length > 0;
}

export interface ReconcileOutcome {
  resumed: number;
  failed: number;
  /** Abandoned eveless sessions closed by sweep 2 (thread claims released). */
  sessionsClosed: number;
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
  // sweep (index.ts fires it after listen), so the close itself is a guarded
  // UPDATE ({@link closeEvelessSessionIfStillAbandoned}) — a candidate that
  // gained its eve id after this snapshot is untouched, and only rows
  // actually updated are counted.
  const evelessCandidates = await deps.db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        isNull(schema.agentSessions.eveSessionId),
        notInArray(schema.agentSessions.status, ["closed", "error"]),
      ),
    );
  for (const candidate of evelessCandidates) {
    const newest = await deps.db
      .select({ status: schema.runs.status, startedAt: schema.runs.startedAt })
      .from(schema.runs)
      .where(eq(schema.runs.agentSessionId, candidate.id))
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);
    const run = newest[0];
    if (
      run &&
      run.startedAt !== null &&
      (run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "canceled")
    ) {
      if (await closeEvelessSessionIfStillAbandoned(deps.db, candidate.id)) {
        outcome.sessionsClosed += 1;
      }
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
