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
