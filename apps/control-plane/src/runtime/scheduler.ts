/**
 * Scheduler (docs/PLAN.md Phase 3 task 1). Selects the worker that should run
 * a session's next turn, in strict preference order:
 *
 *   1. session AFFINITY   — the worker the session's sandbox/agent is already
 *      live on (`agent_sessions.affinity_worker_id`), as long as that worker
 *      is still live AND can host it (already warm on the hash, or has agent
 *      headroom). Keeps the durable sandbox local across a conversation.
 *   2. artifact-WARM      — a live worker already running this version hash
 *      (from its heartbeat capacity report): no artifact pull + agent boot.
 *   3. any LIVE worker with capacity headroom (runningAgents < maxAgents) —
 *      a cold placement.
 *   4. → 503. `no_live_worker` when none are live at all; `no_capacity` when
 *      live workers exist but every one is at its agent cap.
 *
 * Liveness = status `live` AND heartbeat fresher than the TTL. Affinity is
 * recorded on session create and CLEARED on worker death/drain (the sweeper,
 * runtime/worker-sweeper.ts) so a stranded session reschedules elsewhere.
 */
import { desc, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import type { Db } from "../db";
import { errors } from "./errors";

/** Live capacity a worker reports on register + every heartbeat (workers.capacity). */
export interface WorkerCapacitySnapshot {
  maxAgents?: number;
  runningAgents?: number;
  activeRequests?: number;
  /** Content hashes currently running on the worker (artifact-warm signal). */
  runningHashes?: string[];
}

export interface SchedulableWorker {
  id: string;
  address: string;
  status: "live" | "draining" | "dead";
  lastHeartbeatAt: Date;
  capacity: WorkerCapacitySnapshot;
}

export interface SelectWorkerOptions {
  now?: Date;
  heartbeatTtlMs: number;
  /** Fallback per-worker agent cap when the worker did not report `maxAgents`. */
  defaultMaxAgents: number;
  /** The version hash to run — enables the artifact-warm preference. */
  versionHash?: string;
  /** The session's current affinity worker id (sticky sandbox). */
  affinityWorkerId?: string | null;
}

export type PickReason = "affinity" | "warm" | "cold";

export type PickResult =
  | { ok: true; worker: SchedulableWorker; reason: PickReason }
  | { ok: false; reason: "no_live_worker" | "no_capacity" };

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

function maxAgentsOf(worker: SchedulableWorker, fallback: number): number {
  const reported = worker.capacity.maxAgents;
  return typeof reported === "number" && reported > 0 ? reported : fallback;
}

function runningAgentsOf(worker: SchedulableWorker): number {
  return worker.capacity.runningAgents ?? 0;
}

/** Already running this hash → placing the session here boots no new agent. */
function isWarmOn(worker: SchedulableWorker, versionHash: string | undefined): boolean {
  if (versionHash === undefined) return false;
  return (worker.capacity.runningHashes ?? []).includes(versionHash);
}

function hasHeadroom(worker: SchedulableWorker, defaultMaxAgents: number): boolean {
  return runningAgentsOf(worker) < maxAgentsOf(worker, defaultMaxAgents);
}

/** Freshest-heartbeat first (deterministic tiebreak on id). */
function freshest(a: SchedulableWorker, b: SchedulableWorker): SchedulableWorker {
  const at = a.lastHeartbeatAt.getTime();
  const bt = b.lastHeartbeatAt.getTime();
  if (at !== bt) return at > bt ? a : b;
  return a.id < b.id ? a : b;
}

function pickFreshest(workers: SchedulableWorker[]): SchedulableWorker | null {
  if (workers.length === 0) return null;
  return workers.reduce(freshest);
}

/**
 * Pure worker selection (affinity → warm → cold-with-headroom). Returns a
 * discriminated result so the DB-backed caller can throw the right 503.
 */
export function pickWorker(
  workers: SchedulableWorker[],
  options: SelectWorkerOptions,
): PickResult {
  const now = options.now ?? new Date();
  const live = workers.filter((w) => isWorkerLive(w, now, options.heartbeatTtlMs));
  if (live.length === 0) return { ok: false, reason: "no_live_worker" };

  // 1. affinity — sticky sandbox. Honoured while the worker can host the
  //    session: warm on the hash (agent already there) OR has agent headroom.
  if (options.affinityWorkerId) {
    const sticky = live.find((w) => w.id === options.affinityWorkerId);
    if (
      sticky &&
      (isWarmOn(sticky, options.versionHash) ||
        hasHeadroom(sticky, options.defaultMaxAgents))
    ) {
      return { ok: true, worker: sticky, reason: "affinity" };
    }
  }

  // 2. artifact-warm — a live worker already running the hash (no boot).
  const warm = pickFreshest(live.filter((w) => isWarmOn(w, options.versionHash)));
  if (warm) return { ok: true, worker: warm, reason: "warm" };

  // 3. any live worker with agent headroom (cold placement).
  const cold = pickFreshest(
    live.filter((w) => hasHeadroom(w, options.defaultMaxAgents)),
  );
  if (cold) return { ok: true, worker: cold, reason: "cold" };

  // Live workers exist but every one is at its agent cap.
  return { ok: false, reason: "no_capacity" };
}

/** Map a DB row (capacity is opaque jsonb) to a {@link SchedulableWorker}. */
export function toSchedulableWorker(row: {
  id: string;
  address: string;
  status: "live" | "draining" | "dead";
  lastHeartbeatAt: Date;
  capacity: Record<string, unknown> | null;
}): SchedulableWorker {
  return {
    id: row.id,
    address: row.address,
    status: row.status,
    lastHeartbeatAt: row.lastHeartbeatAt,
    capacity: normalizeCapacity(row.capacity),
  };
}

function normalizeCapacity(raw: Record<string, unknown> | null): WorkerCapacitySnapshot {
  if (!raw) return {};
  const snapshot: WorkerCapacitySnapshot = {};
  if (typeof raw.maxAgents === "number") snapshot.maxAgents = raw.maxAgents;
  if (typeof raw.runningAgents === "number") snapshot.runningAgents = raw.runningAgents;
  if (typeof raw.activeRequests === "number") snapshot.activeRequests = raw.activeRequests;
  if (Array.isArray(raw.runningHashes)) {
    snapshot.runningHashes = raw.runningHashes.filter(
      (h): h is string => typeof h === "string",
    );
  }
  return snapshot;
}

export interface SelectedWorker {
  worker: SchedulableWorker;
  reason: PickReason;
}

/**
 * DB-backed selection — throws a typed 503 (`no_live_worker` / `no_capacity`)
 * when nothing qualifies. `defaultMaxAgents` falls back to the reported
 * per-worker cap; callers pass the runtime default for workers that omit it.
 */
export async function selectWorker(
  db: Db,
  options: SelectWorkerOptions,
): Promise<SelectedWorker> {
  const rows = await db
    .select({
      id: schema.workers.id,
      address: schema.workers.address,
      status: schema.workers.status,
      lastHeartbeatAt: schema.workers.lastHeartbeatAt,
      capacity: schema.workers.capacity,
    })
    .from(schema.workers)
    .where(eq(schema.workers.status, "live"))
    .orderBy(desc(schema.workers.lastHeartbeatAt))
    .limit(200);

  const result = pickWorker(rows.map(toSchedulableWorker), options);
  if (!result.ok) {
    throw result.reason === "no_live_worker"
      ? errors.noLiveWorker()
      : errors.noCapacity();
  }
  return { worker: result.worker, reason: result.reason };
}
