/**
 * Control-plane registration loop.
 *
 * Contract (control plane's internal worker API, shared-secret guarded via
 * the `x-worker-secret` header — PLAN §API surface "internal worker
 * endpoints"):
 *   POST /internal/workers/register    {id, url, capacity} on boot (upsert)
 *   POST /internal/workers/heartbeat   {id, url, capacity} every 10s
 *   POST /internal/workers/deregister  {id} on drain
 *
 * `capacity` carries running/active counts (persisted into workers.capacity
 * jsonb). A heartbeat answered with 404 (control plane lost the row, e.g.
 * after a wipe) demotes to re-register on the next tick. Control-plane
 * downtime is tolerated with exponential backoff (cap 60s) — the worker
 * keeps serving; it never crashes on registration failures.
 */
import type { WorkerConfig } from "./config";

export interface WorkerCapacity {
  maxAgents: number;
  runningAgents: number;
  activeRequests: number;
}

export interface RegisterWorkerBody {
  id: string;
  url: string;
  capacity: WorkerCapacity;
}

export interface RegistrationState {
  registered: boolean;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface Registration {
  /** Start the register-then-heartbeat loop (idempotent). */
  start(): void;
  stop(): void;
  /** Best-effort deregister — never throws (control plane may be down). */
  deregister(): Promise<void>;
  state(): RegistrationState;
}

const BACKOFF_CAP_MS = 60_000;

export function createRegistration(options: {
  config: Pick<
    WorkerConfig,
    | "controlPlaneUrl"
    | "workerSharedSecret"
    | "workerId"
    | "publicUrl"
    | "heartbeatIntervalMs"
    | "maxAgents"
  >;
  snapshot: () => { runningAgents: number; activeRequests: number };
  log?: (message: string) => void;
}): Registration {
  const { config, snapshot } = options;
  const log = options.log ?? (() => {});

  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  let registered = false;
  let consecutiveFailures = 0;
  let lastError: string | null = null;

  function body(): RegisterWorkerBody {
    const counts = snapshot();
    return {
      id: config.workerId,
      url: config.publicUrl,
      capacity: {
        maxAgents: config.maxAgents,
        runningAgents: counts.runningAgents,
        activeRequests: counts.activeRequests,
      },
    };
  }

  async function post(path: string, payload: unknown): Promise<number> {
    const res = await fetch(`${config.controlPlaneUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": config.workerSharedSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    return res.status;
  }

  async function tick(): Promise<void> {
    try {
      if (!registered) {
        const status = await post("/internal/workers/register", body());
        if (status < 200 || status >= 300) {
          throw new Error(`register -> HTTP ${status}`);
        }
        registered = true;
        log(`registered with control plane as ${config.workerId}`);
      } else {
        const status = await post("/internal/workers/heartbeat", body());
        if (status === 404) {
          // Control plane forgot us — re-register on the next tick.
          registered = false;
          throw new Error("heartbeat -> HTTP 404 (re-registering)");
        }
        if (status < 200 || status >= 300) {
          throw new Error(`heartbeat -> HTTP ${status}`);
        }
      }
      consecutiveFailures = 0;
      lastError = null;
    } catch (err) {
      consecutiveFailures += 1;
      lastError = err instanceof Error ? err.message : String(err);
      if (consecutiveFailures === 1) {
        log(`control plane unreachable (${lastError}) — backing off`);
      }
    }
    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) return;
    const delay =
      consecutiveFailures === 0
        ? config.heartbeatIntervalMs
        : Math.min(
            config.heartbeatIntervalMs * 2 ** Math.min(consecutiveFailures, 5),
            BACKOFF_CAP_MS,
          );
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      void tick();
    },
    stop(): void {
      stopped = true;
      started = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async deregister(): Promise<void> {
      try {
        await post("/internal/workers/deregister", { id: config.workerId });
        log("deregistered from control plane");
      } catch (err) {
        log(
          `deregister failed (${err instanceof Error ? err.message : String(err)}) — continuing shutdown`,
        );
      }
      registered = false;
    },
    state(): RegistrationState {
      return { registered, consecutiveFailures, lastError };
    },
  };
}
