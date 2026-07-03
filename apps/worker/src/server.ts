/**
 * Worker HTTP surface (Bun.serve):
 *
 * - `/internal/*` — control-plane API guarded by the `x-worker-secret`
 *   header (timing-safe compare): POST /internal/agents/ensure,
 *   POST /internal/drain, GET /internal/status.
 * - `/agents/:hash/*` — reverse proxy to the agent's port with the
 *   `/agents/:hash` prefix stripped. ONLY `/eve/` is forwarded here: eve's
 *   channel routes enforce the platform JWT themselves, but the
 *   `/.well-known/workflow/v1/*` run-callback surface has NO auth of its
 *   own — exposing it would let any client with network reach forge
 *   step/flow callbacks into any agent's durable runs (security review).
 * - `/cb/:token/agents/:hash/*` — the SAME proxy plus `/.well-known/
 *   workflow/` forwarding, gated by a per-boot callback token that only the
 *   co-located world queue knows (injected via WORKFLOW_LOCAL_BASE_URL —
 *   spike proxy contract: callbacks must traverse this ingress or runs
 *   stall forever, and proxying keeps idle/drain bookkeeping accurate).
 *   Path + query + headers + body pass through verbatim; response bodies
 *   stream unbuffered (NDJSON session streams stay open for minutes).
 * - `/healthz` — unauthenticated worker liveness.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import {
  verifyDispatchToken,
  DISPATCH_TOKEN_HEADER,
  WORKER_BOOTSTRAP_SECRET_HEADER,
  WORKER_ID_HEADER,
  type ApiErrorBody,
} from "@invisible-string/shared";

import { AgentBootError, type AgentManager, type EnsureAgentInput } from "./agents";
import { ArtifactError, type ArtifactCache } from "./cache";
import type { WorkerConfig } from "./config";
import { PortPoolExhaustedError, type PortPool } from "./ports";

/** Path prefixes forwarded to agent processes (both are load-bearing). */
export const FORWARDED_PREFIXES = ["/eve/", "/.well-known/workflow/"] as const;

/** Prefix forwarded on the PUBLIC `/agents/:hash` surface (JWT-enforcing). */
export const PUBLIC_FORWARDED_PREFIXES = ["/eve/"] as const;

/** eve's un-authenticated internal run-callback surface (token-gated). */
export const CALLBACK_PREFIX = "/.well-known/workflow/";

const HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Response body of POST /internal/agents/ensure. */
export interface EnsureAgentResponse {
  hash: string;
  port: number;
  /** Proxy base for this agent: `${publicUrl}/agents/${hash}`. */
  url: string;
  startedAt: string;
  reused: boolean;
}

/** Response body of GET /internal/status. */
export interface WorkerStatusResponse {
  workerId: string;
  publicUrl: string;
  draining: boolean;
  agents: {
    hash: string;
    port: number;
    state: string;
    startedAt: string;
    lastActivityAt: string;
    inflight: number;
  }[];
  cache: {
    dir: string;
    totalBytes: number;
    maxBytes: number;
    entries: { hash: string; bytes: number; lastUsedAt: string; running: boolean }[];
  };
  ports: { min: number; max: number; size: number; allocated: number };
}

export interface WorkerServer {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

export function createWorkerServer(options: {
  config: WorkerConfig;
  agents: AgentManager;
  cache: ArtifactCache;
  ports: PortPool;
  /** Per-boot secret gating `/cb/:token/...` (see agents.ts callbackToken). */
  callbackToken: string;
  isDraining: () => boolean;
  /** Kicks off the (async) drain; the endpoint returns 202 immediately. */
  requestDrain: () => void;
  log?: (message: string) => void;
}): WorkerServer {
  const { config, agents, cache, ports, callbackToken, isDraining, requestDrain } =
    options;
  const log = options.log ?? (() => {});

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    // NDJSON session streams stay open for minutes; never idle-close them.
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, draining: isDraining() });
      }
      if (url.pathname.startsWith("/agents/")) {
        return proxy(request, url.pathname.slice("/agents/".length), url, false);
      }
      if (url.pathname.startsWith("/cb/")) {
        return callbackProxy(request, url);
      }
      if (url.pathname.startsWith("/internal/")) {
        return internal(request, url);
      }
      return errorResponse(404, "not_found", "unknown path");
    },
  });

  // ── internal API ──────────────────────────────────────────────────────────

  function authorized(request: Request): boolean {
    // Bootstrap shared secret (Phase-1 default, always accepted).
    const provided = request.headers.get(WORKER_BOOTSTRAP_SECRET_HEADER);
    if (provided !== null && secretsEqual(provided, config.workerSharedSecret)) {
      return true;
    }
    // Per-worker DISPATCH token (Phase-3 identity): audience-bound to THIS
    // worker id, so a dispatch captured for another worker is rejected here.
    const dispatchToken = request.headers.get(DISPATCH_TOKEN_HEADER);
    const workerId = request.headers.get(WORKER_ID_HEADER);
    if (
      dispatchToken !== null &&
      (workerId === null || workerId === config.workerId)
    ) {
      return verifyDispatchToken(
        config.workerSharedSecret,
        config.workerId,
        dispatchToken,
      ).ok;
    }
    return false;
  }

  async function internal(request: Request, url: URL): Promise<Response> {
    if (!authorized(request)) {
      return errorResponse(401, "unauthorized", "missing or invalid x-worker-secret header");
    }
    if (url.pathname === "/internal/agents/ensure" && request.method === "POST") {
      return ensureAgent(request);
    }
    if (url.pathname === "/internal/drain" && request.method === "POST") {
      requestDrain();
      return Response.json({ draining: true }, { status: 202 });
    }
    if (url.pathname === "/internal/status" && request.method === "GET") {
      return Response.json(statusBody());
    }
    return errorResponse(404, "not_found", "unknown internal endpoint");
  }

  async function ensureAgent(request: Request): Promise<Response> {
    if (isDraining()) {
      return errorResponse(503, "draining", "worker is draining — not accepting new agents");
    }
    let input: EnsureAgentInput;
    try {
      input = parseEnsureBody(await request.json());
    } catch (err) {
      return errorResponse(
        400,
        "invalid_request",
        err instanceof Error ? err.message : "invalid JSON body",
      );
    }
    try {
      const result = await agents.ensureAgent(input);
      const body: EnsureAgentResponse = {
        hash: result.hash,
        port: result.port,
        url: `${config.publicUrl}/agents/${result.hash}`,
        startedAt: new Date(result.startedAt).toISOString(),
        reused: result.reused,
      };
      return Response.json(body);
    } catch (err) {
      if (err instanceof PortPoolExhaustedError) {
        return errorResponse(503, "port_pool_exhausted", err.message);
      }
      if (err instanceof ArtifactError) {
        return errorResponse(
          err.code === "artifact_download_failed" ? 502 : 422,
          err.code,
          err.message,
        );
      }
      if (err instanceof AgentBootError) {
        return errorResponse(500, "agent_boot_failed", err.message, {
          logTail: err.logTail,
        });
      }
      log(`ensure ${input.versionHash}: unexpected error — ${String(err)}`);
      return errorResponse(500, "internal_error", "unexpected error ensuring agent");
    }
  }

  function statusBody(): WorkerStatusResponse {
    const running = new Set(agents.list().map((a) => a.hash));
    return {
      workerId: config.workerId,
      publicUrl: config.publicUrl,
      draining: isDraining(),
      agents: agents.list().map((a) => ({
        hash: a.hash,
        port: a.port,
        state: a.state,
        startedAt: new Date(a.startedAt).toISOString(),
        lastActivityAt: new Date(a.lastActivityAt).toISOString(),
        inflight: a.inflight,
      })),
      cache: {
        dir: cache.dir,
        totalBytes: cache.totalBytes(),
        maxBytes: cache.maxBytes,
        entries: cache.entries().map((e) => ({
          hash: e.hash,
          bytes: e.bytes,
          lastUsedAt: new Date(e.lastUsedAt).toISOString(),
          running: running.has(e.hash),
        })),
      },
      ports: {
        min: ports.min,
        max: ports.max,
        size: ports.size,
        allocated: ports.allocatedCount(),
      },
    };
  }

  // ── reverse proxy ─────────────────────────────────────────────────────────

  /**
   * /cb/<token>/agents/<hash>/<rest> — the world queue's run-callback route.
   * Verifies the per-boot callback token (timing-safe), then proxies with
   * `/.well-known/workflow/` forwarding enabled.
   */
  async function callbackProxy(request: Request, url: URL): Promise<Response> {
    const withoutBase = url.pathname.slice("/cb/".length);
    const slash = withoutBase.indexOf("/");
    const token = slash === -1 ? withoutBase : withoutBase.slice(0, slash);
    const rest = slash === -1 ? "" : withoutBase.slice(slash);
    if (token === "" || !secretsEqual(token, callbackToken)) {
      return errorResponse(401, "invalid_callback_token", "invalid callback token");
    }
    if (!rest.startsWith("/agents/")) {
      return errorResponse(404, "not_found", "expected /cb/:token/agents/:hash/<path>");
    }
    return proxy(request, rest.slice("/agents/".length), url, true);
  }

  async function proxy(
    request: Request,
    withoutBase: string,
    url: URL,
    allowCallbacks: boolean,
  ): Promise<Response> {
    // <hash>/<rest...> — forward <rest> verbatim.
    const slash = withoutBase.indexOf("/");
    const hash = slash === -1 ? withoutBase : withoutBase.slice(0, slash);
    const rest = slash === -1 ? "" : withoutBase.slice(slash);
    if (!HASH_RE.test(hash) || rest === "") {
      return errorResponse(404, "not_found", "expected /agents/:hash/<path>");
    }
    if (!allowCallbacks && rest.startsWith(CALLBACK_PREFIX)) {
      // eve's run-callback surface has no auth of its own; only the
      // co-located world queue (via the tokenized /cb/ route) may reach it.
      return errorResponse(
        403,
        "callback_auth_required",
        `${CALLBACK_PREFIX} is only reachable through the token-authenticated callback route`,
      );
    }
    const forwarded = allowCallbacks ? FORWARDED_PREFIXES : PUBLIC_FORWARDED_PREFIXES;
    if (!forwarded.some((prefix) => rest.startsWith(prefix))) {
      return errorResponse(
        404,
        "path_not_forwarded",
        `only ${forwarded.join(" and ")} are forwarded to agents`,
      );
    }
    if (isDraining()) {
      // In-flight requests finish; new ones are refused so drain converges.
      // Workflow-queue callbacks retry, so a 5xx here is safe (REPORT §12).
      return errorResponse(503, "draining", "worker is draining");
    }
    const agent = agents.get(hash);
    if (agent === undefined) {
      return errorResponse(
        404,
        "agent_not_running",
        `agent ${hash} is not running on this worker (re-ensure it first)`,
      );
    }
    if (!agents.beginRequest(hash)) {
      return errorResponse(503, "agent_stopping", `agent ${hash} is stopping`);
    }

    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        agents.endRequest(hash);
      }
    };

    try {
      const target = `http://127.0.0.1:${agent.port}${rest}${url.search}`;
      const headers = new Headers(request.headers);
      headers.set("host", `127.0.0.1:${agent.port}`);
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        // Required for streaming request bodies.
        duplex: "half",
      });

      const responseHeaders = new Headers(upstream.headers);
      if (responseHeaders.has("content-encoding")) {
        // fetch already decoded the body; length/encoding no longer apply.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      }

      if (upstream.body === null) {
        finish();
        return new Response(null, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }

      // Pass chunks through as they arrive (NDJSON must stream unbuffered)
      // while keeping in-flight bookkeeping exact for drain/idle-stop.
      const reader = upstream.body.getReader();
      const tracked = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              finish();
            } else {
              controller.enqueue(value);
            }
          } catch (err) {
            controller.error(err);
            finish();
          }
        },
        cancel(reason) {
          void reader.cancel(reason).catch(() => {});
          finish();
        },
      });

      return new Response(tracked, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      finish();
      log(`proxy ${hash}${rest}: upstream error — ${String(err)}`);
      return errorResponse(502, "upstream_unavailable", "agent did not respond");
    }
  }

  return {
    port: server.port ?? config.port,
    url: `http://127.0.0.1:${server.port ?? config.port}`,
    stop(): void {
      server.stop(true);
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseEnsureBody(raw: unknown): EnsureAgentInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const versionHash = body.versionHash;
  if (typeof versionHash !== "string" || !HASH_RE.test(versionHash)) {
    throw new Error("versionHash must be an 8-128 char [A-Za-z0-9_-] string");
  }
  const artifactUrl = body.artifactUrl;
  if (typeof artifactUrl !== "string" || !isHttpUrl(artifactUrl)) {
    throw new Error("artifactUrl must be an http(s) URL");
  }
  let env: Record<string, string> | undefined;
  if (body.env !== undefined) {
    if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
      throw new Error("env must be an object of string values");
    }
    for (const value of Object.values(body.env)) {
      if (typeof value !== "string") {
        throw new Error("env must be an object of string values");
      }
    }
    env = body.env as Record<string, string>;
  }
  return { versionHash, artifactUrl, env };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = { error: { code, message, details } };
  return Response.json(body, { status });
}

function secretsEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
