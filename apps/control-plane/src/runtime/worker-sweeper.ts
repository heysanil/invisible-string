/**
 * Dead-worker sweeper (docs/PLAN.md Phase 3 task 1+2) — the control plane's
 * side of the worker liveness state machine and session failover.
 *
 * Each pass:
 *  1. Marks `live`/`draining` workers whose heartbeat is older than the TTL
 *     `dead` (the heartbeat-crash path; a gracefully drained worker already
 *     deregistered itself to `dead`).
 *  2. Finds every non-terminal run whose session's `affinity_worker_id` points
 *     at a now-`dead` worker and reschedules it:
 *       - a PARKED run (`waiting` on HITL) → clear affinity so the eventual
 *         `POST /runs/:id/input` reschedules onto a DIFFERENT worker (the
 *         headline acceptance: a parked session resumes elsewhere after its
 *         home worker dies);
 *       - a RUNNING/queued run with a durable eve turn → pick a new live
 *         worker, ensure the agent there, repoint affinity, and RE-TAIL from
 *         the persisted seq (the durable world turn continues on the new
 *         worker). If no worker is available this tick, the run keeps its
 *         dead-affinity and is retried on the next pass (self-healing);
 *       - a run whose session never got an eve session id → fail it (nothing
 *         durable to resume).
 *
 * Idempotent and crash-safe: it only ever adopts runs the scan proves are
 * stranded on a dead worker, and a run already re-tailed locally is detached
 * before the fresh tail starts so a single NDJSON stream is never double-read.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import {
  ensureAgentOnWorker,
  requireReadyVersion,
  startTail,
  type RuntimeDeps,
} from "./routes";
import { isRuntimeApiError } from "./errors";
import { selectWorker } from "./scheduler";

type SessionRow = typeof schema.agentSessions.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

export interface SweepOutcome {
  /** Workers newly marked dead this pass (heartbeat crash path). */
  markedDead: number;
  /** Parked sessions whose affinity was cleared (resume on input). */
  cleared: number;
  /** Running/queued runs re-tailed on a fresh worker. */
  resumed: number;
  /** Runs left for a later pass (no worker available this tick). */
  deferred: number;
  /** Runs failed (no durable eve session to resume). */
  failed: number;
}

/** Resume one running/queued run on a freshly scheduled worker. */
export type ResumeRunFn = (input: {
  run: RunRow;
  session: SessionRow;
  versionId: string;
  contentHash: string;
  eveSessionId: string;
}) => Promise<"resumed" | "no_worker">;

export interface WorkerSweeper {
  sweepOnce(now?: Date): Promise<SweepOutcome>;
  start(): void;
  stop(): void;
}

export function createWorkerSweeper(
  deps: RuntimeDeps,
  options: { log?: (message: string) => void; resumeRun?: ResumeRunFn } = {},
): WorkerSweeper {
  const { db, runtime } = deps;
  const log = options.log ?? (() => {});
  const resumeRun = options.resumeRun ?? defaultResumeRun(deps);

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function sweepOnce(now: Date = new Date()): Promise<SweepOutcome> {
    const outcome: SweepOutcome = {
      markedDead: 0,
      cleared: 0,
      resumed: 0,
      deferred: 0,
      failed: 0,
    };

    // 1. Heartbeat crash → dead. (Graceful drain already deregistered to dead.)
    const cutoff = new Date(now.getTime() - runtime.workerHeartbeatTtlMs);
    const newlyDead = await db
      .update(schema.workers)
      .set({ status: "dead", updatedAt: now })
      .where(
        and(
          inArray(schema.workers.status, ["live", "draining"]),
          lt(schema.workers.lastHeartbeatAt, cutoff),
        ),
      )
      .returning({ id: schema.workers.id });
    outcome.markedDead = newlyDead.length;

    // 2. Every non-terminal run stranded on a dead worker (covers this pass's
    //    newly-dead AND any still-unresolved from a previous pass — scanning by
    //    the worker's dead status makes the sweep self-healing).
    const stranded = await db
      .select({
        run: schema.runs,
        session: schema.agentSessions,
        contentHash: schema.workflowVersions.contentHash,
      })
      .from(schema.runs)
      .innerJoin(
        schema.agentSessions,
        eq(schema.runs.agentSessionId, schema.agentSessions.id),
      )
      .innerJoin(
        schema.workers,
        eq(schema.agentSessions.affinityWorkerId, schema.workers.id),
      )
      .innerJoin(
        schema.workflowVersions,
        eq(schema.agentSessions.workflowVersionId, schema.workflowVersions.id),
      )
      .where(
        and(
          eq(schema.workers.status, "dead"),
          inArray(schema.runs.status, ["queued", "running", "waiting"]),
        ),
      );

    for (const row of stranded) {
      try {
        await handleStranded(row, outcome);
      } catch (error) {
        log(
          `sweep: run ${row.run.id} failover error — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      outcome.markedDead > 0 ||
      outcome.cleared > 0 ||
      outcome.resumed > 0 ||
      outcome.failed > 0
    ) {
      log(
        `sweep: ${outcome.markedDead} dead, ${outcome.cleared} parked cleared, ${outcome.resumed} resumed, ${outcome.deferred} deferred, ${outcome.failed} failed`,
      );
    }
    return outcome;
  }

  async function handleStranded(
    row: { run: RunRow; session: SessionRow; contentHash: string },
    outcome: SweepOutcome,
  ): Promise<void> {
    const { run, session } = row;

    // Parked on HITL: no active turn — just clear affinity so the user's
    // approval (`POST /runs/:id/input`) reschedules onto a live worker.
    if (run.status === "waiting") {
      await clearAffinity(session.id);
      outcome.cleared += 1;
      return;
    }

    // Never established an eve session (crashed mid-create) → unrecoverable.
    if (!session.eveSessionId) {
      await deps.runStore.markRun(run.id, {
        status: "failed",
        error: "home worker died before the session was established",
        completedAt: new Date(),
      });
      await clearAffinity(session.id);
      outcome.failed += 1;
      return;
    }

    const result = await resumeRun({
      run,
      session,
      versionId: session.workflowVersionId,
      contentHash: row.contentHash,
      eveSessionId: session.eveSessionId,
    });
    if (result === "resumed") outcome.resumed += 1;
    else outcome.deferred += 1; // keep dead-affinity; retried next pass
  }

  async function clearAffinity(sessionId: string): Promise<void> {
    await db
      .update(schema.agentSessions)
      .set({ affinityWorkerId: null })
      .where(eq(schema.agentSessions.id, sessionId));
  }

  return {
    sweepOnce,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (running) return; // never overlap passes
        running = true;
        void sweepOnce()
          .catch((error) => log(`sweep failed: ${String(error)}`))
          .finally(() => {
            running = false;
          });
      }, runtime.workerSweepIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Production reschedule: pick a fresh live worker (dead one is excluded — the
 * query filters `status = 'live'`), ensure the agent there, repoint affinity,
 * and re-tail from the persisted seq. Returns `no_worker` when the scheduler
 * has nothing to offer, so the sweep defers the run to a later pass.
 */
function defaultResumeRun(deps: RuntimeDeps): ResumeRunFn {
  const { db, runtime } = deps;
  return async ({ run, session, versionId, contentHash, eveSessionId }) => {
    let picked;
    try {
      picked = await selectWorker(db, {
        heartbeatTtlMs: runtime.workerHeartbeatTtlMs,
        defaultMaxAgents: runtime.maxAgentsPerWorker,
        versionHash: contentHash,
      });
    } catch (error) {
      if (isRuntimeApiError(error)) return "no_worker"; // no_live_worker / no_capacity
      throw error;
    }

    // Stop any stale in-process tail (its worker died) WITHOUT failing the run,
    // then resume against the fresh worker.
    await deps.tailers.detach(run.id);

    const ready = await requireReadyVersion(deps, versionId);
    await ensureAgentOnWorker(deps, picked.worker, ready, session.organizationId);

    await db
      .update(schema.agentSessions)
      .set({ affinityWorkerId: picked.worker.id, status: "active" })
      .where(eq(schema.agentSessions.id, session.id));

    startTail(
      deps,
      picked.worker.address,
      contentHash,
      eveSessionId,
      run.id,
      session.id,
    );
    return "resumed";
  };
}
