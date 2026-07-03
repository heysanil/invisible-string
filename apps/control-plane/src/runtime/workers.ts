/**
 * Internal worker-registry endpoints (PLAN §API surface "internal worker
 * endpoints") — the control-plane counterpart of apps/worker/src/registration.ts:
 *
 *   POST /internal/workers/register    {id, url, capacity, identity} → upsert,
 *                                      status live; in `worker-token` mode the
 *                                      response carries a short-lived
 *                                      per-worker session token
 *   POST /internal/workers/heartbeat   {id, url?, capacity?, draining?} →
 *                                      refresh; 404 when the row is unknown OR
 *                                      when the row was marked `dead` (fenced —
 *                                      the worker must stop its orphaned agents
 *                                      and re-register as a fresh epoch);
 *                                      `draining: true` flips a live row to
 *                                      `draining` so the scheduler stops
 *                                      routing new work at drain start; rotates
 *                                      the session token when the caller
 *                                      authenticated with one
 *   POST /internal/workers/deregister  {id} → status dead (drain path)
 *
 * FENCING (zombie-dead / split-brain guard): a worker the sweeper marked
 * `dead` (heartbeat gap > TTL) may still be alive and running agents. Its next
 * heartbeat is answered 404 `worker_fenced` — NEVER silently 200 — so the
 * worker stops its (possibly failed-over) agents and re-registers as a fresh
 * epoch instead of running the same version hash concurrently with the worker
 * the sweeper resumed those runs on (one live agent per hash per world DB).
 *
 * AUTH (docs/PLAN.md Phase 3 task 5 — per-worker identity, deferred from
 * Phase 1): the first `register` authenticates with the bootstrap
 * `x-worker-secret` (the ONLY call that must). In `worker-token` mode the
 * control plane then mints a per-worker HS256 SESSION token (secret derived
 * from the bootstrap secret + worker id) which the worker re-presents via
 * `x-worker-token` (+ `x-worker-id`) on heartbeat/deregister — attributable,
 * and it never resends the bootstrap secret. `shared-secret` mode (Phase-1
 * default) keeps guarding every call with `x-worker-secret`. Either credential
 * is accepted on heartbeat/deregister so both modes interoperate.
 *
 * REGISTRATION ALLOWLIST: the bootstrap secret alone lets any holder register
 * an arbitrary worker id + URL and attract secret-bearing dispatches. When
 * `WORKER_ALLOWED_IDS` is configured, register rejects worker ids that were
 * not pre-provisioned (403 `worker_not_allowed`) — a leaked bootstrap secret
 * then no longer suffices to join the fleet.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  mintWorkerSessionToken,
  verifyWorkerSessionToken,
  workerIdentityDeclarationSchema,
  WORKER_BOOTSTRAP_SECRET_HEADER,
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
  type ApiErrorBody,
  type Logger,
  type WorkerIdentityDeclaration,
} from "@invisible-string/shared";

import type { Db } from "../db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkerBody {
  id: string;
  url?: string;
  capacity?: Record<string, unknown>;
  identity: WorkerIdentityDeclaration;
  /** Heartbeat only: the worker has begun a graceful drain. */
  draining?: boolean;
}

/**
 * A registered worker `url` receives ensure-agent payloads carrying the
 * agent's FULL secret env (provider key, derived JWT secret, decrypted MCP
 * tokens). Plaintext http is only acceptable for local dev/CI, behind the
 * explicit ALLOW_INSECURE_WORKER_TRANSPORT=1 opt-in.
 */
function workerUrlProblem(url: URL, allowInsecureHttp: boolean): string | null {
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && allowInsecureHttp) return null;
  return url.protocol === "http:"
    ? "worker url must be https:// (secret-bearing dispatches; set ALLOW_INSECURE_WORKER_TRANSPORT=1 for local dev only)"
    : "worker url must be an http(s) URL";
}

function secretsEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function parseWorkerBody(raw: unknown, requireUrl: boolean): WorkerBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) return null;
  if (requireUrl) {
    if (typeof body.url !== "string") return null;
    try {
      const url = new URL(body.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  const capacity =
    typeof body.capacity === "object" && body.capacity !== null && !Array.isArray(body.capacity)
      ? (body.capacity as Record<string, unknown>)
      : undefined;
  // Additive to the Phase-1 shape: defaults to shared-secret when absent.
  const identity = workerIdentityDeclarationSchema.safeParse(
    body.identity ?? { mode: "shared-secret" },
  );
  if (!identity.success) return null;
  return {
    id: body.id,
    url: body.url as string | undefined,
    capacity,
    identity: identity.data,
    draining: body.draining === true,
  };
}

export function workerRegistryPlugin(deps: {
  db: Db;
  workerSharedSecret: string;
  /** ALLOW_INSECURE_WORKER_TRANSPORT=1 — local dev/CI only. */
  allowInsecureWorkerTransport?: boolean;
  /** Heartbeat cadence advertised to workers (default = ttl/3). */
  heartbeatIntervalMs?: number;
  /**
   * Pre-provisioned worker ids (WORKER_ALLOWED_IDS). When set, register
   * rejects any id not on the list — the bootstrap secret alone no longer
   * admits arbitrary workers into the fleet. Unset = allow all (dev/CI).
   */
  allowedWorkerIds?: readonly string[];
  /** Structured lifecycle logging (worker.registered / worker.deregistered). */
  logger?: Logger;
}) {
  const { db } = deps;
  const allowInsecureHttp = deps.allowInsecureWorkerTransport === true;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 10_000;
  const allowedIds =
    deps.allowedWorkerIds && deps.allowedWorkerIds.length > 0
      ? new Set(deps.allowedWorkerIds.map((id) => id.toLowerCase()))
      : null;

  function urlProblemFor(parsed: WorkerBody): string | null {
    if (parsed.url === undefined) return null;
    let url: URL;
    try {
      url = new URL(parsed.url);
    } catch {
      return "worker url must be an http(s) URL";
    }
    return workerUrlProblem(url, allowInsecureHttp);
  }

  /** Bootstrap secret OR a valid per-worker session token authorizes the call. */
  function isAuthorized(request: Request): boolean {
    const bootstrap = request.headers.get(WORKER_BOOTSTRAP_SECRET_HEADER);
    if (bootstrap !== null && secretsEqual(bootstrap, deps.workerSharedSecret)) {
      return true;
    }
    const token = request.headers.get(WORKER_TOKEN_HEADER);
    const workerId = request.headers.get(WORKER_ID_HEADER);
    if (token !== null && workerId !== null && UUID_RE.test(workerId)) {
      return verifyWorkerSessionToken(deps.workerSharedSecret, workerId, token).ok;
    }
    return false;
  }

  /** Did the caller authenticate with a session token? (→ rotate on ack) */
  function usedSessionToken(request: Request): string | null {
    const token = request.headers.get(WORKER_TOKEN_HEADER);
    const workerId = request.headers.get(WORKER_ID_HEADER);
    if (token !== null && workerId !== null && UUID_RE.test(workerId)) {
      if (verifyWorkerSessionToken(deps.workerSharedSecret, workerId, token).ok) {
        return workerId;
      }
    }
    return null;
  }

  return new Elysia({ name: "worker-registry" })
    .onBeforeHandle(({ request, set }) => {
      if (!isAuthorized(request)) {
        set.status = 401;
        return errorBody(
          "unauthorized",
          "missing or invalid worker credential (x-worker-secret or x-worker-token)",
        );
      }
      return undefined;
    })
    .post("/internal/workers/register", async ({ body, set }) => {
      const parsed = parseWorkerBody(body, true);
      if (!parsed) {
        set.status = 400;
        return errorBody(
          "invalid_request",
          "expected {id: uuid, url: http(s) URL, capacity?, identity?}",
        );
      }
      if (allowedIds !== null && !allowedIds.has(parsed.id.toLowerCase())) {
        set.status = 403;
        deps.logger?.warn("worker.register_rejected", {
          workerId: parsed.id,
          fields: { reason: "worker_not_allowed" },
        });
        return errorBody(
          "worker_not_allowed",
          "worker id is not on this control plane's allowlist (WORKER_ALLOWED_IDS)",
        );
      }
      const urlProblem = urlProblemFor(parsed);
      if (urlProblem) {
        set.status = 400;
        return errorBody("insecure_worker_url", urlProblem);
      }
      await db
        .insert(schema.workers)
        .values({
          id: parsed.id,
          address: parsed.url!,
          status: "live",
          lastHeartbeatAt: new Date(),
          capacity: parsed.capacity ?? {},
        })
        .onConflictDoUpdate({
          target: schema.workers.id,
          set: {
            address: parsed.url!,
            status: "live",
            lastHeartbeatAt: new Date(),
            capacity: parsed.capacity ?? {},
            updatedAt: new Date(),
          },
        });
      deps.logger?.info("worker.registered", {
        workerId: parsed.id,
        fields: { authMode: parsed.identity.mode },
      });

      // Per-worker identity: mint a fresh session token (rotate on re-register).
      if (parsed.identity.mode === "worker-token") {
        const minted = mintWorkerSessionToken(deps.workerSharedSecret, parsed.id);
        return {
          ok: true as const,
          workerId: parsed.id,
          authMode: "worker-token" as const,
          workerToken: minted.token,
          workerTokenExpiresAt: minted.expiresAt,
          heartbeatIntervalMs,
        };
      }
      return { ok: true as const, workerId: parsed.id, authMode: parsed.identity.mode, heartbeatIntervalMs };
    })
    .post("/internal/workers/heartbeat", async ({ body, request, set }) => {
      const parsed = parseWorkerBody(body, false);
      if (!parsed) {
        set.status = 400;
        return errorBody("invalid_request", "expected {id: uuid, capacity?}");
      }
      const urlProblem = urlProblemFor(parsed);
      if (urlProblem) {
        set.status = 400;
        return errorBody("insecure_worker_url", urlProblem);
      }
      // NEVER touch a `dead` row from a heartbeat: the sweeper may have failed
      // that worker over already. Answer 404 so the worker fences itself
      // (stops orphaned agents) and re-registers as a fresh epoch.
      const updated = await db
        .update(schema.workers)
        .set({
          lastHeartbeatAt: new Date(),
          ...(parsed.url ? { address: parsed.url } : {}),
          ...(parsed.capacity ? { capacity: parsed.capacity } : {}),
          // Graceful drain start: live → draining (scheduler filters `live`,
          // so new work stops routing here immediately). Never the reverse —
          // a heartbeat cannot un-drain a worker.
          ...(parsed.draining ? { status: "draining" as const } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.workers.id, parsed.id),
            ne(schema.workers.status, "dead"),
          ),
        )
        .returning({ id: schema.workers.id });
      if (updated.length === 0) {
        const existing = await db
          .select({ status: schema.workers.status })
          .from(schema.workers)
          .where(eq(schema.workers.id, parsed.id))
          .limit(1);
        if (existing[0]?.status === "dead") {
          deps.logger?.warn("worker.fenced", {
            workerId: parsed.id,
            fields: { reason: "heartbeat_from_dead_worker" },
          });
          set.status = 404;
          return errorBody(
            "worker_fenced",
            "worker was marked dead — stop local agents and re-register",
          );
        }
        // 404 → the worker re-registers on its next tick (registration.ts).
        set.status = 404;
        return errorBody("worker_not_registered", "unknown worker id — re-register");
      }
      // Rotate the session token when the caller presented one for this worker.
      const tokenWorkerId = usedSessionToken(request);
      if (tokenWorkerId === parsed.id) {
        const minted = mintWorkerSessionToken(deps.workerSharedSecret, parsed.id);
        return {
          ok: true as const,
          workerToken: minted.token,
          workerTokenExpiresAt: minted.expiresAt,
        };
      }
      return { ok: true as const };
    })
    .post("/internal/workers/deregister", async ({ body, set }) => {
      const parsed = parseWorkerBody(body, false);
      if (!parsed) {
        set.status = 400;
        return errorBody("invalid_request", "expected {id: uuid}");
      }
      // Graceful drain → dead. The sweeper (worker-sweeper.ts) then clears the
      // worker's sessions' affinity and reschedules any interrupted runs.
      await db
        .update(schema.workers)
        .set({ status: "dead", updatedAt: new Date() })
        .where(eq(schema.workers.id, parsed.id));
      deps.logger?.info("worker.deregistered", { workerId: parsed.id });
      return { ok: true as const };
    });
}
