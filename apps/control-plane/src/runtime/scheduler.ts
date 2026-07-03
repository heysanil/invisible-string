/**
 * Scheduler v1 (docs/PLAN.md Phase 1 task 5): pick a live worker from the
 * `workers` registry — status `live` AND heartbeat fresher than the TTL
 * (default 30s). Affinity/warm-artifact/capacity scoring lands in Phase 3;
 * v1 keeps session affinity sticky when the affinity worker is still live,
 * else falls back to the freshest live worker.
 */
import { desc, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { Db } from "../db";
import { errors } from "./errors";

export interface SchedulableWorker {
  id: string;
  address: string;
  status: "live" | "draining" | "dead";
  lastHeartbeatAt: Date;
}

/** Is this worker eligible to receive new work right now? (pure) */
export function isWorkerLive(
  worker: SchedulableWorker,
  now: Date,
  heartbeatTtlMs: number,
): boolean {
  return (
    worker.status === "live" &&
    now.getTime() - worker.lastHeartbeatAt.getTime() < heartbeatTtlMs
  );
}

/**
 * Pure pick: prefer `affinityWorkerId` while it is live (sticky sandboxes),
 * else the live worker with the freshest heartbeat. Null when none qualify.
 */
export function pickWorker(
  workers: SchedulableWorker[],
  now: Date,
  heartbeatTtlMs: number,
  affinityWorkerId?: string | null,
): SchedulableWorker | null {
  const live = workers.filter((w) => isWorkerLive(w, now, heartbeatTtlMs));
  if (live.length === 0) return null;
  if (affinityWorkerId) {
    const sticky = live.find((w) => w.id === affinityWorkerId);
    if (sticky) return sticky;
  }
  return live.reduce((best, w) =>
    w.lastHeartbeatAt.getTime() > best.lastHeartbeatAt.getTime() ? w : best,
  );
}

/** DB-backed pick — throws typed 503 when no live worker exists. */
export async function selectWorker(
  db: Db,
  heartbeatTtlMs: number,
  affinityWorkerId?: string | null,
  now: Date = new Date(),
): Promise<SchedulableWorker> {
  const rows = await db
    .select({
      id: schema.workers.id,
      address: schema.workers.address,
      status: schema.workers.status,
      lastHeartbeatAt: schema.workers.lastHeartbeatAt,
    })
    .from(schema.workers)
    .where(eq(schema.workers.status, "live"))
    .orderBy(desc(schema.workers.lastHeartbeatAt))
    .limit(50);

  const picked = pickWorker(rows, now, heartbeatTtlMs, affinityWorkerId);
  if (!picked) throw errors.noLiveWorker();
  return picked;
}
