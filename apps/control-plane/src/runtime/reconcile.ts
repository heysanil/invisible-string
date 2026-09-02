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
 *    in the same CAS) but its remote leg never completed — the process died
 *    before the guarded chase ran, the chase was refused (lock held, lock
 *    pool saturated), or the cancel failed in transport before it reached
 *    eve (N1: such a marker is RETAINED, never cleared on a guess) — and the
 *    accepted eve turn would otherwise keep running forever. Each is
 *    finished through `cancelEveTurnGuarded` (routes.ts): under the
 *    session's dispatch lock it chases eve, or skips as superseded when a
 *    newer run PROVABLY reached eve (running/waiting, or terminal with
 *    observed events — a merely queued successor is no proof and RETAINS
 *    the marker instead), or finds nothing to chase — and clears the
 *    marker only on such a CONFIRMED outcome; at boot a held lock defers it
 *    into the background exactly as the live route does. After sweep 2 on
 *    purpose: a session that sweep just closed has no eve id, so its pending
 *    cancels settle as "nothing to chase". This sweep is ALSO the body of
 *    the PERIODIC remote-cancel sweeper ({@link createRemoteCancelSweeper},
 *    `REMOTE_CANCEL_SWEEP_MS`, N2): boot reconciliation runs once, but a
 *    healthy process must finish its obligations without a restart — the
 *    ticker re-runs this sweep with `defer: false` (the tick IS the retry;
 *    no background chases fan out), and is advisory-try-locked so replicas
 *    do not scan in lockstep (each candidate is in any case serialized by
 *    its session's dispatch lock and the under-lock marker re-read).
 *
 * 3. INTERRUPTED PIPELINE RUNS — `mode: 'pipeline'` runs (which have no
 *    session or worker to re-tail) are re-driven from their `run_steps`
 *    ledger instead: pipeline/recovery.ts adopts every queued/running/
 *    waiting run whose per-run advisory lock is acquirable. Runs only when
 *    the PipelineRunner is wired. Like sweep 2b this one has a PERIODIC
 *    twin (`createPipelineRecoverySweeper`, `PIPELINE_RECOVERY_SWEEP_MS`):
 *    an orphan counted `locked` here (pipeline lock pool exhausted, or a
 *    driver in another replica) is re-adopted by a healthy process instead
 *    of holding its cap slot until the next restart.
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
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
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
   * session lock, deferred into the background because the lock could not
   * be taken, or retained because the cancel provably did not reach eve.
   */
  remoteCancels: RemoteCancelSweepOutcome;
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
    remoteCancels: { settled: 0, deferred: 0, retained: 0 },
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
  // clears the marker itself on a confirmed outcome; a held lock defers it
  // into the background at boot (the marker stays until the deferred
  // attempt completes, the periodic sweep, or the next boot), and a
  // transport failure retains it.
  outcome.remoteCancels = await sweepPendingRemoteCancels(deps, { defer: true });

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

// ── Sweep 2b as a reusable body + the periodic remote-cancel sweeper ────────

/** Tally of one pending-remote-cancel sweep (boot sweep 2b, or one tick).
 *  Type alias (not interface) so it logs as a structured `fields` value. */
export type RemoteCancelSweepOutcome = {
  /** Obligation met under the lock (acknowledged / terminal / superseded / nothing to chase). */
  settled: number;
  /** Lock unavailable (held, or pool exhausted) — retried next tick / by the boot deferral. */
  deferred: number;
  /** The cancel provably did not reach eve, or was withheld behind a queued
   *  (unproven) successor — marker kept for the next sweep. */
  retained: number;
};

/** Default periodic sweep cadence; overridden by REMOTE_CANCEL_SWEEP_MS. */
export const DEFAULT_REMOTE_CANCEL_SWEEP_MS = 60_000;

/** Advisory key that elects one replica's scan per instant (a try-lock). */
const REMOTE_CANCEL_SWEEP_LOCK_KEY = "remote-cancel-sweep";

/**
 * Sweep 2b's body: every canceled agent run still carrying
 * `remote_cancel_pending_at`, each finished through `cancelEveTurnGuarded`
 * under its session's dispatch lock. `defer: true` (boot) lets a held lock
 * spawn the bounded background chase exactly as the live route does;
 * `defer: false` (the periodic ticker) just counts it `deferred` — the next
 * tick is the retry, and no replica fans out minutes-long chases.
 */
export async function sweepPendingRemoteCancels(
  deps: RuntimeDeps,
  options: { defer: boolean },
): Promise<RemoteCancelSweepOutcome> {
  const outcome: RemoteCancelSweepOutcome = { settled: 0, deferred: 0, retained: 0 };
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
    const result = await cancelEveTurnGuarded(deps, pending.sessionId, pending.runId, {
      defer: options.defer,
    });
    outcome[result] += 1;
  }
  return outcome;
}

export interface RemoteCancelSweeper {
  /** Begin the periodic sweep (idempotent). */
  start(): void;
  /** Stop sweeping and wait for an in-flight tick to finish. */
  stop(): Promise<void>;
  /**
   * One sweep pass (exposed for tests + acceptance proofs). Null when this
   * tick lost the replica election (another instance is scanning right now).
   */
  tick(): Promise<RemoteCancelSweepOutcome | null>;
}

/**
 * The PERIODIC remote-cancel sweeper (N2): re-runs sweep 2b every
 * `REMOTE_CANCEL_SWEEP_MS` so a healthy process finishes a Stop's remote
 * obligation that its in-process chase could not — the session lock pool
 * was saturated when the Stop landed and stayed so past the chase's bound,
 * the worker was unreachable, the cancel failed in transport — without a
 * restart. Each tick first takes a short transaction-scoped advisory
 * TRY-lock (`pg_try_advisory_xact_lock`) to elect one scanning replica per
 * instant, like the registry sync's single try-lock; the real double-run
 * guard is per candidate — the session dispatch lock held across the chase,
 * plus the under-lock marker re-read that makes a second attempt a no-op.
 * No pool resource is held across the tick's I/O: the election lock ends
 * with its transaction before any chase runs.
 *
 * index.ts wiring (start/stop beside the schedule ticker) belongs to the
 * integrator; this module only exposes the factory.
 */
export function createRemoteCancelSweeper(
  deps: RuntimeDeps,
  options: { intervalMs?: number } = {},
): RemoteCancelSweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_REMOTE_CANCEL_SWEEP_MS;
  const { logger } = deps;

  async function elected(): Promise<boolean> {
    return deps.db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext(${REMOTE_CANCEL_SWEEP_LOCK_KEY})::bigint) as elected`,
      );
      const row = (rows as unknown as Array<{ elected?: boolean }>)[0];
      return row?.elected === true;
    });
  }

  async function tick(): Promise<RemoteCancelSweepOutcome | null> {
    if (!(await elected())) return null;
    const outcome = await sweepPendingRemoteCancels(deps, { defer: false });
    if (outcome.settled > 0 || outcome.deferred > 0 || outcome.retained > 0) {
      logger.info("run.remote_cancel_sweep", {
        msg: `remote-cancel sweep: settled ${outcome.settled}, deferred ${outcome.deferred}, retained ${outcome.retained}`,
        fields: { ...outcome },
      });
    }
    return outcome;
  }

  // setTimeout chain (not setInterval): ticks never overlap themselves, and a
  // slow tick delays the next one instead of stacking.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick()
        .catch((error) => {
          logger.error("run.remote_cancel_sweep_failed", { err: error });
        })
        .finally(scheduleNext);
    }, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      scheduleNext();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    },
    tick,
  };
}
