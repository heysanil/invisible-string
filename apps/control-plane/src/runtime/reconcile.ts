/**
 * Boot-time run reconciliation (review finding: a control-plane crash leaves
 * runs stuck in queued/running forever — permanently holding per-workspace
 * cap slots, hanging their SSE streams on heartbeats, and never recording
 * eve's durably-completed turn).
 *
 * On startup, every queued/running run is swept:
 * - session has an eve session AND its affinity worker is still live →
 *   restart the tail (tailRun is crash-safe: seq/startIndex derive from what
 *   is already persisted; the terminal gate handles a mid-turn resume).
 * - otherwise → mark the run failed with completedAt so the cap slot frees
 *   and any SSE follower terminates on the persisted status.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { startTail, type RuntimeDeps } from "./routes";
import { isWorkerLive, toSchedulableWorker } from "./scheduler";

export interface ReconcileOutcome {
  resumed: number;
  failed: number;
}

export async function reconcileInterruptedRuns(
  deps: RuntimeDeps,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  const rows = await deps.db
    .select({
      run: schema.runs,
      session: schema.agentSessions,
      worker: schema.workers,
      contentHash: schema.workflowVersions.contentHash,
    })
    .from(schema.runs)
    .innerJoin(
      schema.agentSessions,
      eq(schema.runs.agentSessionId, schema.agentSessions.id),
    )
    .innerJoin(
      schema.workflowVersions,
      eq(schema.agentSessions.workflowVersionId, schema.workflowVersions.id),
    )
    .leftJoin(
      schema.workers,
      eq(schema.agentSessions.affinityWorkerId, schema.workers.id),
    )
    .where(and(inArray(schema.runs.status, ["queued", "running"])));

  const outcome: ReconcileOutcome = { resumed: 0, failed: 0 };
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
  return outcome;
}
