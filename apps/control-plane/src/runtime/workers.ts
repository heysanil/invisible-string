/**
 * Internal worker-registry endpoints (PLAN §API surface "internal worker
 * endpoints with shared-secret auth") — the control-plane counterpart of
 * apps/worker/src/registration.ts:
 *
 *   POST /internal/workers/register    {id, url, capacity} → upsert, status live
 *   POST /internal/workers/heartbeat   {id, url, capacity} → refresh; 404 when
 *                                      the row is unknown (worker re-registers)
 *   POST /internal/workers/deregister  {id} → status dead (drain path)
 *
 * All guarded by the `x-worker-secret` header (timing-safe compare — same
 * scheme as the worker's own /internal/* surface). These rows feed the
 * scheduler (`runtime/scheduler.ts`): a worker is schedulable while status is
 * `live` AND its heartbeat is fresher than WORKER_HEARTBEAT_TTL_MS.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import type { ApiErrorBody } from "@invisible-string/shared";

import type { Db } from "../db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkerBody {
  id: string;
  url?: string;
  capacity?: Record<string, unknown>;
}

/**
 * A registered worker `url` receives ensure-agent payloads carrying the
 * agent's FULL secret env (provider key, derived JWT secret, decrypted MCP
 * tokens). Plaintext http is only acceptable for local dev/CI, behind the
 * explicit ALLOW_INSECURE_WORKER_TRANSPORT=1 opt-in. Per-worker credentials
 * / mTLS identity land with the Phase-3 worker pool.
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
  return { id: body.id, url: body.url as string | undefined, capacity };
}

export function workerRegistryPlugin(deps: {
  db: Db;
  workerSharedSecret: string;
  /** ALLOW_INSECURE_WORKER_TRANSPORT=1 — local dev/CI only. */
  allowInsecureWorkerTransport?: boolean;
}) {
  const { db } = deps;
  const allowInsecureHttp = deps.allowInsecureWorkerTransport === true;

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

  return new Elysia({ name: "worker-registry" })
    .onBeforeHandle(({ request, set }) => {
      const provided = request.headers.get("x-worker-secret");
      if (provided === null || !secretsEqual(provided, deps.workerSharedSecret)) {
        set.status = 401;
        return errorBody("unauthorized", "missing or invalid x-worker-secret header");
      }
      return undefined;
    })
    .post("/internal/workers/register", async ({ body, set }) => {
      const parsed = parseWorkerBody(body, true);
      if (!parsed) {
        set.status = 400;
        return errorBody("invalid_request", "expected {id: uuid, url: http(s) URL, capacity?}");
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
      return { ok: true };
    })
    .post("/internal/workers/heartbeat", async ({ body, set }) => {
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
      return { ok: true };
    })
    .post("/internal/workers/deregister", async ({ body, set }) => {
      const parsed = parseWorkerBody(body, false);
      if (!parsed) {
        set.status = 400;
        return errorBody("invalid_request", "expected {id: uuid}");
      }
      await db
        .update(schema.workers)
        .set({ status: "dead", updatedAt: new Date() })
        .where(eq(schema.workers.id, parsed.id));
      return { ok: true };
    });
}
