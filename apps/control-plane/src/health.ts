/**
 * Control-plane health (docs/PLAN.md Phase 3 task 5).
 *
 * `GET /api/health` stays a cheap liveness probe: `{ ok: true }`, 200, no IO.
 * `GET /api/health?deep=1` runs a readiness probe over the dependencies a run
 * actually needs — Postgres, the object store (build artifacts), and at least
 * one live worker — and reports each check's status so an operator sees WHICH
 * dependency is down. A degraded deep probe answers HTTP 503 (load balancers
 * drain it) while the shallow probe still says 200 (the process is alive).
 *
 * Checks are injected (pure to test): the wiring in `index.ts` supplies a DB
 * ping, an object-store reachability probe, and a live-worker count. The last
 * two are only present when the runtime env is configured; in a Phase-0-style
 * boot the deep probe degrades to the DB check alone.
 */
import { Elysia } from "elysia";

export type HealthState = "ok" | "degraded" | "skipped";

export interface HealthCheckResult {
  status: HealthState;
  /** Human detail — a failure reason, a count, or why a check was skipped. */
  detail?: string;
  /** Wall-clock of the probe (ms), when it ran. */
  latencyMs?: number;
}

export interface DeepHealthReport {
  ok: boolean;
  status: "ok" | "degraded";
  at: string;
  checks: Record<string, HealthCheckResult>;
}

export interface DeepHealthDeps {
  /** Ping Postgres (e.g. `select 1`). Throw ⇒ degraded. Always present. */
  pingDb: () => Promise<void>;
  /** Probe the object store (build artifacts). Absent ⇒ skipped. */
  pingObjectStore?: () => Promise<void>;
  /** Count workers eligible to take work right now. Absent ⇒ skipped. */
  countLiveWorkers?: () => Promise<number>;
  now?: () => Date;
}

async function timedCheck(
  run: () => Promise<void>,
  now: () => number,
): Promise<HealthCheckResult> {
  const start = now();
  try {
    await run();
    return { status: "ok", latencyMs: now() - start };
  } catch (error) {
    return {
      status: "degraded",
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: now() - start,
    };
  }
}

/**
 * Run the deep readiness probe. Overall `ok` is false when ANY applicable check
 * is degraded (a skipped check never fails the probe — it was not configured).
 */
export async function runDeepHealth(
  deps: DeepHealthDeps,
): Promise<DeepHealthReport> {
  const now = deps.now ?? (() => new Date());
  const millis = () => now().getTime();
  const checks: Record<string, HealthCheckResult> = {};

  checks.database = await timedCheck(deps.pingDb, millis);

  if (deps.pingObjectStore) {
    checks.objectStore = await timedCheck(deps.pingObjectStore, millis);
  } else {
    checks.objectStore = { status: "skipped", detail: "runtime not configured" };
  }

  if (deps.countLiveWorkers) {
    const start = millis();
    try {
      const live = await deps.countLiveWorkers();
      checks.workers =
        live > 0
          ? { status: "ok", detail: `${live} live`, latencyMs: millis() - start }
          : {
              status: "degraded",
              detail: "no live workers",
              latencyMs: millis() - start,
            };
    } catch (error) {
      checks.workers = {
        status: "degraded",
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: millis() - start,
      };
    }
  } else {
    checks.workers = { status: "skipped", detail: "runtime not configured" };
  }

  const ok = Object.values(checks).every((c) => c.status !== "degraded");
  return {
    ok,
    status: ok ? "ok" : "degraded",
    at: now().toISOString(),
    checks,
  };
}

/**
 * `GET /api/health` — liveness by default (`{ ok: true }`, no IO), readiness on
 * `?deep=1` (runs {@link runDeepHealth}; 503 when degraded). When `health` is
 * absent (deep probes unwired) the deep query still answers a shallow 200.
 */
export function healthPlugin(health?: DeepHealthDeps) {
  return new Elysia({ name: "health" }).get(
    "/api/health",
    async ({ query, set }) => {
      const deep = query.deep === "1" || query.deep === "true";
      if (!deep || !health) return { ok: true };
      const report = await runDeepHealth(health);
      if (!report.ok) set.status = 503;
      return report;
    },
  );
}
