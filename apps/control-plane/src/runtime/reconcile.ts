/**
 * Boot-time run reconciliation (review finding: a control-plane crash leaves
 * runs stuck in queued/running forever — permanently holding per-workspace
 * cap slots, hanging their SSE streams on heartbeats, and never recording
 * eve's durably-completed turn).
 *
 * On startup, two sweeps:
 *
 * 1. INTERRUPTED RUNS — every queued/running run:
 *    - session has an eve session AND its affinity worker is still live →
 *      restart the tail (tailRun is crash-safe: seq/startIndex derive from
 *      what is already persisted; the terminal gate handles a mid-turn
 *      resume).
 *    - otherwise → mark the run failed with completedAt so the cap slot frees
 *      and any SSE follower terminates on the persisted status.
 *
 * 2. STRANDED DELIVERIES (agents-first §5.5) — TERMINAL runs whose
 *    `delivery_status` is still `pending`: succeeded ones (the process died
 *    between the terminal event and the Slack post) recover the final
 *    stop-message from persisted `run_events` and deliver late
 *    (at-least-once — see runs/delivery.ts); failed/canceled ones — including
 *    the rows sweep 1 just marked failed — settle the ledger (no reply
 *    owed). Runs only when a DeliveryService is wired (the integrations
 *    config may be absent).
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { DeliveryService } from "../runs/delivery";
import { startTail, type RuntimeDeps } from "./routes";
import { isWorkerLive, toSchedulableWorker } from "./scheduler";

export interface ReconcileOutcome {
  resumed: number;
  failed: number;
  /** Stranded-delivery sweep tally (zeros when no DeliveryService is wired). */
  deliveries: { delivered: number; failed: number; skipped: number };
}

export interface ReconcileOptions {
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
    .where(and(inArray(schema.runs.status, ["queued", "running"])));

  const outcome: ReconcileOutcome = {
    resumed: 0,
    failed: 0,
    deliveries: { delivered: 0, failed: 0, skipped: 0 },
  };
  for (const row of rows) {
    // A tail already running in THIS process (normal operation) is left
    // alone — reconcile only adopts orphans.
    if (deps.tailers.get(row.run.id)) continue;

    const workerLive =
      row.worker !== null &&
      isWorkerLive(
        toSchedulableWorker(row.worker),
        now,
        deps.runtime.workerHeartbeatTtlMs,
      );

    if (workerLive && row.session.eveSessionId) {
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
        error: "control plane restarted while the run was active (no live worker to resume from)",
        completedAt: now,
      });
      outcome.failed += 1;
    }
  }

  if (options.delivery) {
    outcome.deliveries = await options.delivery.recoverPending();
  }
  return outcome;
}
