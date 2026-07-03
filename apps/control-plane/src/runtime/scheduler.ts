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
  /**
   * Boot-in-flight agents to count on top of the reported `runningAgents`
   * (heartbeat capacity is up to an interval stale, and an agent being ensured
   * is invisible to it until ready). Defaults to the process-wide reservation
   * registry ({@link reservedAgentsOf}); injectable for pure tests.
   */
  reservedOf?: (worker: SchedulableWorker, now: Date) => number;
}

// ── In-flight placement reservations ─────────────────────────────────────────
//
// Self-reported capacity lags by up to a heartbeat interval, so a burst of
// cold placements inside one interval would all see the same runningAgents
// and pile onto one worker, overshooting maxAgents unboundedly. Every
// placement of a hash the target is NOT already warm on records a short-lived
// reservation; selection counts live reservations as occupied slots. A
// reservation clears when the worker's heartbeat reports the hash running
// (it then counts via runningAgents) or when the TTL lapses (failed boot).
// In-process registry — fine under the single-control-plane deployment
// constraint (docs/runtime-worker-contract.md).

/**
 * Default reservation lifetime. The EFFECTIVE lifetime must cover the
 * worker-client's whole ensure budget (request timeout × retry attempts) —
 * a reservation that lapses while a cold boot is still ensuring lets
 * concurrent placements over-place onto the booting worker. index.ts wires
 * the configured budget via {@link setAgentReservationTtlMs}.
 */
export const AGENT_RESERVATION_TTL_MS = 60_000;

let reservationTtlMs = AGENT_RESERVATION_TTL_MS;

/** Wire the reservation lifetime to the configured ensure budget (index.ts). */
export function setAgentReservationTtlMs(ms: number): void {
  reservationTtlMs = ms;
}

const agentReservations = new Map<string, Map<string, number>>();

/** Record that `versionHash` is being booted on `workerId` right now. */
export function reserveAgentSlot(
  workerId: string,
  versionHash: string,
  now: number = Date.now(),
  ttlMs: number = reservationTtlMs,
): void {
  let byHash = agentReservations.get(workerId);
  if (!byHash) {
    byHash = new Map();
    agentReservations.set(workerId, byHash);
  }
  byHash.set(versionHash, now + ttlMs);
}

/** Live (unexpired, not-yet-reported) reservations for one worker. */
export function reservedAgentsOf(worker: SchedulableWorker, now: Date): number {
  const byHash = agentReservations.get(worker.id);
  if (!byHash) return 0;
  const running = worker.capacity.runningHashes ?? [];
  let count = 0;
  for (const [hash, expiresAt] of byHash) {
    if (expiresAt <= now.getTime() || running.includes(hash)) {
      byHash.delete(hash); // expired, or the heartbeat now reports it
      continue;
    }
    count += 1;
  }
  if (byHash.size === 0) agentReservations.delete(worker.id);
  return count;
}

/** Tests only: drop every reservation. */
export function clearAgentReservations(): void {
  agentReservations.clear();
}

export type PickReason = "affinity" | "warm" | "cold";

export type PickResult =
  | { ok: true; worker: SchedulableWorker; reason: PickReason }
  | { ok: false; reason: "no_live_worker" | "no_capacity" };

/** Is this worker eligible to receive new work right now? (pure) */
export function isWorkerLive(
  worker: Pick<SchedulableWorker, "status" | "lastHeartbeatAt">,
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

function occupiedAgentsOf(
  worker: SchedulableWorker,
  now: Date,
  reservedOf: (worker: SchedulableWorker, now: Date) => number,
): number {
  return runningAgentsOf(worker) + reservedOf(worker, now);
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
 * Cold-placement pick: least-occupied first (running + boot-in-flight
 * reservations), freshest heartbeat as the tiebreak — a burst of cold
 * placements spreads instead of stampeding the single freshest worker.
 */
function pickLeastOccupied(
  workers: SchedulableWorker[],
  now: Date,
  reservedOf: (worker: SchedulableWorker, now: Date) => number,
): SchedulableWorker | null {
  if (workers.length === 0) return null;
  return workers.reduce((a, b) => {
    const oa = occupiedAgentsOf(a, now, reservedOf);
    const ob = occupiedAgentsOf(b, now, reservedOf);
    if (oa !== ob) return oa < ob ? a : b;
    return freshest(a, b);
  });
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
  const reservedOf = options.reservedOf ?? reservedAgentsOf;
  const live = workers.filter((w) => isWorkerLive(w, now, options.heartbeatTtlMs));
  if (live.length === 0) return { ok: false, reason: "no_live_worker" };

  const hasHeadroom = (worker: SchedulableWorker): boolean =>
    occupiedAgentsOf(worker, now, reservedOf) <
    maxAgentsOf(worker, options.defaultMaxAgents);

  // 1. affinity — sticky sandbox. Honoured while the worker can host the
  //    session: warm on the hash (agent already there) OR has agent headroom.
  if (options.affinityWorkerId) {
    const sticky = live.find((w) => w.id === options.affinityWorkerId);
    if (
      sticky &&
      (isWarmOn(sticky, options.versionHash) || hasHeadroom(sticky))
    ) {
      return { ok: true, worker: sticky, reason: "affinity" };
    }
  }

  // 2. artifact-warm — a live worker already running the hash (no boot).
  const warm = pickFreshest(live.filter((w) => isWarmOn(w, options.versionHash)));
  if (warm) return { ok: true, worker: warm, reason: "warm" };

  // 3. any live worker with agent headroom (cold placement).
  const cold = pickLeastOccupied(live.filter(hasHeadroom), now, reservedOf);
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
  // The placement will boot an agent unless the worker is already warm on the
  // hash — reserve the slot so concurrent selections see it as occupied.
  if (
    options.versionHash !== undefined &&
    !(result.worker.capacity.runningHashes ?? []).includes(options.versionHash)
  ) {
    reserveAgentSlot(result.worker.id, options.versionHash);
  }
  return { worker: result.worker, reason: result.reason };
}
