/**
 * Control-plane registration loop.
 *
 * Contract (control plane's internal worker API — PLAN §API surface + Phase-3
 * per-worker identity):
 *   POST /internal/workers/register    {id, url, capacity, identity} on boot
 *   POST /internal/workers/heartbeat   {id, url, capacity} every ~10s
 *   POST /internal/workers/deregister  {id} on drain
 *
 * `capacity` carries running/active counts AND `runningHashes` (the content
 * hashes running here — the scheduler's artifact-warm signal). A heartbeat
 * answered with 404 (control plane lost the row) demotes to re-register.
 * Control-plane downtime is tolerated with exponential backoff (cap 60s).
 *
 * AUTH: `shared-secret` mode presents the bootstrap `x-worker-secret` on every
 * call (Phase-1 default). `worker-token` mode presents the bootstrap secret
 * ONLY on register, keeps the per-worker session token from the response, and
 * re-presents it via `x-worker-token` (+ `x-worker-id`) on heartbeat/
 * deregister; the token is rotated from each heartbeat response.
 */
import {
  WORKER_BOOTSTRAP_SECRET_HEADER,
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@invisible-string/shared";

import type { WorkerConfig } from "./config";

export interface WorkerCapacity {
  maxAgents: number;
  runningAgents: number;
  activeRequests: number;
  /** Content hashes running on this worker (scheduler artifact-warm signal). */
  runningHashes: string[];
}

export interface RegisterWorkerBody {
  id: string;
  url: string;
  capacity: WorkerCapacity;
  identity: { mode: "shared-secret" | "worker-token" };
}

export interface RegistrationState {
  registered: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  /** True once a per-worker session token has been obtained (worker-token mode). */
  hasSessionToken: boolean;
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
    | "authMode"
  >;
  snapshot: () => {
    runningAgents: number;
    activeRequests: number;
    runningHashes: string[];
  };
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
  /** Per-worker session token (worker-token mode). Rotated on each heartbeat. */
  let sessionToken: string | null = null;

  function registerBody(): RegisterWorkerBody {
    return { ...heartbeatBody(), identity: { mode: config.authMode } };
  }

  function heartbeatBody(): RegisterWorkerBody {
    const counts = snapshot();
    return {
      id: config.workerId,
      url: config.publicUrl,
      capacity: {
        maxAgents: config.maxAgents,
        runningAgents: counts.runningAgents,
        activeRequests: counts.activeRequests,
        runningHashes: counts.runningHashes,
      },
      identity: { mode: config.authMode },
    };
  }

  /** Headers for a worker→control-plane call given the current credential. */
  function authHeaders(useToken: boolean): Record<string, string> {
    if (useToken && config.authMode === "worker-token" && sessionToken) {
      return {
        [WORKER_TOKEN_HEADER]: sessionToken,
        [WORKER_ID_HEADER]: config.workerId,
      };
    }
    return { [WORKER_BOOTSTRAP_SECRET_HEADER]: config.workerSharedSecret };
  }

  async function post(
    path: string,
    payload: unknown,
    useToken: boolean,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const res = await fetch(`${config.controlPlaneUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(useToken) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    return { status: res.status, body };
  }

  /** Capture / rotate the session token from a register or heartbeat response. */
  function captureToken(body: Record<string, unknown> | null): void {
    if (config.authMode !== "worker-token" || !body) return;
    if (typeof body.workerToken === "string" && body.workerToken.length > 0) {
      sessionToken = body.workerToken;
    }
  }

  async function tick(): Promise<void> {
    try {
      if (!registered) {
        // Register always authenticates with the bootstrap secret.
        const { status, body } = await post(
          "/internal/workers/register",
          registerBody(),
          false,
        );
        if (status < 200 || status >= 300) {
          throw new Error(`register -> HTTP ${status}`);
        }
        captureToken(body);
        registered = true;
        log(`registered with control plane as ${config.workerId}`);
      } else {
        const { status, body } = await post(
          "/internal/workers/heartbeat",
          heartbeatBody(),
          true,
        );
        if (status === 404) {
          registered = false;
          sessionToken = null; // stale row — re-register (and re-mint a token)
          throw new Error("heartbeat -> HTTP 404 (re-registering)");
        }
        if (status < 200 || status >= 300) {
          throw new Error(`heartbeat -> HTTP ${status}`);
        }
        captureToken(body);
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
        await post("/internal/workers/deregister", { id: config.workerId }, true);
        log("deregistered from control plane");
      } catch (err) {
        log(
          `deregister failed (${err instanceof Error ? err.message : String(err)}) — continuing shutdown`,
        );
      }
      registered = false;
      sessionToken = null;
    },
    state(): RegistrationState {
      return {
        registered,
        consecutiveFailures,
        lastError,
        hasSessionToken: sessionToken !== null,
      };
    },
  };
}
