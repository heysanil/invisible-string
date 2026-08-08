/**
 * Worker HTTP surface — the observability additions (/internal/health,
 * /internal/status metrics block). Fakes stand in for the agent manager, cache,
 * and port pool so no real processes spawn.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AgentManager } from "./agents";
import type { ArtifactCache } from "./cache";
import type { WorkerConfig } from "./config";
import type { PortPool } from "./ports";
import {
  createWorkerServer,
  type WorkerHealthResponse,
  type WorkerServer,
  type WorkerStatusResponse,
} from "./server";

const SECRET = "worker-server-test-secret-0123456789-0123456789";

function config(): WorkerConfig {
  return {
    controlPlaneUrl: "http://control-plane.test",
    workerSharedSecret: SECRET,
    workerId: "wk_test",
    port: 0,
    publicUrl: "http://worker.test",
    artifactCacheDir: "/tmp/is-worker-test",
    artifactCacheMaxBytes: 100,
    agentIdleStopMs: 60_000,
    agentPortMin: 4310,
    agentPortMax: 4409,
    agentReadyTimeoutMs: 10_000,
    agentStopTimeoutMs: 10_000,
    drainTimeoutMs: 30_000,
    heartbeatIntervalMs: 10_000,
    maxAgents: 20,
    nodeBin: "node",
    authMode: "shared-secret",
    sandboxIdleStopMs: 1_800_000,
    dockerBin: "docker",
    sandboxLabelKey: "eve.session",
    sandboxReaperEnabled: false,
  };
}

const fakeAgents = { list: () => [], totalInflight: () => 3 } as unknown as AgentManager;
const fakeCache = {
  dir: "/tmp/is-worker-test",
  maxBytes: 100,
  totalBytes: () => 42,
  entries: () => [],
} as unknown as ArtifactCache;
const fakePorts = {
  min: 4310,
  max: 4409,
  size: 100,
  allocatedCount: () => 1,
} as unknown as PortPool;

let live: WorkerServer | null = null;
afterEach(() => {
  live?.stop();
  live = null;
});

function start(opts: { draining?: boolean; sandboxCount?: number } = {}): WorkerServer {
  live = createWorkerServer({
    config: config(),
    agents: fakeAgents,
    cache: fakeCache,
    ports: fakePorts,
    callbackToken: "cb-token",
    isDraining: () => opts.draining ?? false,
    requestDrain: () => {},
    sandboxCount: () => opts.sandboxCount ?? 0,
  });
  return live;
}

describe("GET /internal/health", () => {
  test("401 without the shared secret", async () => {
    const server = start();
    const res = await fetch(`${server.url}/internal/health`);
    expect(res.status).toBe(401);
    await res.text();
  });

  test("200 ready when not draining", async () => {
    const server = start({ sandboxCount: 2 });
    const res = await fetch(`${server.url}/internal/health`, {
      headers: { "x-worker-secret": SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerHealthResponse;
    expect(body).toMatchObject({ ok: true, ready: true, draining: false, sandboxCount: 2 });
  });

  test("ready:false while draining (still 200 — alive but not schedulable)", async () => {
    const server = start({ draining: true });
    const res = await fetch(`${server.url}/internal/health`, {
      headers: { "x-worker-secret": SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerHealthResponse;
    expect(body).toMatchObject({ ok: true, ready: false, draining: true });
  });
});

describe("GET /internal/status metrics block", () => {
  test("rolls up running agents, sandboxes, cache bytes, and capacity", async () => {
    const server = start({ sandboxCount: 4 });
    const res = await fetch(`${server.url}/internal/status`, {
      headers: { "x-worker-secret": SECRET },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerStatusResponse;
    expect(body.metrics).toEqual({
      runningAgents: 0,
      sandboxCount: 4,
      maxAgents: 20,
      activeRequests: 3,
      cacheBytes: 42,
      cacheMaxBytes: 100,
    });
  });
});

// ── agent proxy: eve 0.31 session surface ───────────────────────────────────
//
// The proxy is generic (`/eve/` forwards verbatim), so the four control
// subroutes 0.31 added need no code. These are GUARD tests: a future proxy
// refactor that drops the query string, buffers the body, strips response
// headers, or narrows the session-id regex would silently break the bounded
// catch-up read and the sandbox reaper's idle signal — the same class of
// failure as "proxies must forward both /eve/ and /.well-known/workflow/".

interface UpstreamCall {
  path: string;
  search: string;
  method: string;
  contentLength: string | null;
  body: string;
}

function startUpstreamAgent(calls: UpstreamCall[]): { port: number; stop: (force?: boolean) => void } {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        search: url.search,
        method: request.method,
        contentLength: request.headers.get("content-length"),
        body: await request.text(),
      });
      return new Response("upstream-ok", {
        status: 202,
        headers: {
          "x-eve-stream-tail-index": "7",
          "x-eve-session-id": "wrun_1",
          "x-accel-buffering": "no",
        },
      });
    },
  });
  return { port: server.port!, stop: (force) => server.stop(force) };
}

describe("agent proxy — eve 0.31 session routes", () => {
  const HASH = "a".repeat(64);

  function startWithUpstream(upstreamPort: number, seen: string[]): WorkerServer {
    live = createWorkerServer({
      config: config(),
      agents: {
        get: () => ({ hash: HASH, port: upstreamPort }),
        beginRequest: () => true,
        endRequest: () => {},
        list: () => [],
        totalInflight: () => 0,
      } as unknown as AgentManager,
      cache: fakeCache,
      ports: fakePorts,
      callbackToken: "cb-token",
      isDraining: () => false,
      requestDrain: () => {},
      onSessionActivity: (id) => seen.push(id),
    });
    return live;
  }

  test("forwards the four control subroutes with zero-byte bodies and counts them as session activity", async () => {
    const calls: UpstreamCall[] = [];
    const upstream = startUpstreamAgent(calls);
    const seen: string[] = [];
    const server = startWithUpstream(upstream.port, seen);
    try {
      for (const action of ["cancel", "clear", "compact", "reset"]) {
        const res = await fetch(
          `${server.url}/agents/${HASH}/eve/v1/session/wrun_1/${action}`,
          { method: "POST" },
        );
        expect(res.status).toBe(202);
        await res.text();
      }
      expect(calls.map((c) => c.path)).toEqual([
        "/eve/v1/session/wrun_1/cancel",
        "/eve/v1/session/wrun_1/clear",
        "/eve/v1/session/wrun_1/compact",
        "/eve/v1/session/wrun_1/reset",
      ]);
      // A body-less POST must survive the hop (eve accepts empty bodies on
      // all four); nothing may reject it for a missing content-length.
      expect(calls.every((c) => c.body === "")).toBeTrue();
      // The sandbox reaper's idle signal keeps working for the new subroutes
      // (`/^\/eve\/v1\/session\/([^/?]+)/` matches the sub-path too).
      expect(seen).toEqual(["wrun_1", "wrun_1", "wrun_1", "wrun_1"]);
    } finally {
      upstream.stop(true);
    }
  });

  test("forwards the stream query string and returns x-eve-stream-tail-index verbatim", async () => {
    const calls: UpstreamCall[] = [];
    const upstream = startUpstreamAgent(calls);
    const server = startWithUpstream(upstream.port, []);
    try {
      const res = await fetch(
        `${server.url}/agents/${HASH}/eve/v1/session/wrun_1/stream?startIndex=3&includeTailIndex=1`,
      );
      await res.text();
      expect(calls[0]!.search).toBe("?startIndex=3&includeTailIndex=1");
      // The bounded catch-up read is worthless if this header is dropped.
      expect(res.headers.get("x-eve-stream-tail-index")).toBe("7");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
    } finally {
      upstream.stop(true);
    }
  });
});
