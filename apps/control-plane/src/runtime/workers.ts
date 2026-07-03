/**
 * Internal worker-registry endpoints (PLAN §API surface "internal worker
 * endpoints") — the control-plane counterpart of apps/worker/src/registration.ts:
 *
 *   POST /internal/workers/register    {id, url, capacity, identity} → upsert,
 *                                      status live; in `worker-token` mode the
 *                                      response carries a short-lived
 *                                      per-worker session token
 *   POST /internal/workers/heartbeat   {id, url?, capacity?} → refresh; 404 when
 *                                      the row is unknown (worker re-registers);
 *                                      rotates the session token when the caller
 *                                      authenticated with one
 *   POST /internal/workers/deregister  {id} → status dead (drain path)
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
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
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
  };
}

export function workerRegistryPlugin(deps: {
  db: Db;
  workerSharedSecret: string;
  /** ALLOW_INSECURE_WORKER_TRANSPORT=1 — local dev/CI only. */
  allowInsecureWorkerTransport?: boolean;
  /** Heartbeat cadence advertised to workers (default = ttl/3). */
  heartbeatIntervalMs?: number;
}) {
  const { db } = deps;
  const allowInsecureHttp = deps.allowInsecureWorkerTransport === true;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 10_000;

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
      const updated = await db
        .update(schema.workers)
        .set({
          lastHeartbeatAt: new Date(),
          ...(parsed.url ? { address: parsed.url } : {}),
          ...(parsed.capacity ? { capacity: parsed.capacity } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.workers.id, parsed.id))
        .returning({ id: schema.workers.id });
      if (updated.length === 0) {
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
      return { ok: true as const };
    });
}
