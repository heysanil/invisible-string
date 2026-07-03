/**
 * Supervisor integration tests — no real eve, no DB, no provider keys.
 * The "agent" is a fixture tarball built in-test with the exact artifact
 * layout (`.output/server/index.mjs`, launched with PORT env), served over
 * HTTP like a MinIO presigned URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiErrorBody } from "@invisible-string/shared";

import type { WorkerConfig } from "./config";
import type { EnsureAgentResponse, WorkerStatusResponse } from "./server";
import { createSupervisor, type Supervisor } from "./supervisor";
import {
  buildFixtureArtifact,
  CRASHING_SERVER_SOURCE,
  resolveTestNodeBin,
  startArtifactServer,
  type ArtifactServer,
} from "../test/fixture-agent";

const SECRET = "worker-test-secret-0123456789-0123456789";
const NODE_BIN = resolveTestNodeBin();

let scratchDir: string;
let artifacts: ArtifactServer;
let tarPlain: string;
let tarCrash: string;
let tarPadded: Record<"a" | "b" | "c", string>;

/** Unique agent-port range per supervisor so tests never collide. */
let portBase = 42_100;
function nextPortRange(size: number): { min: number; max: number } {
  const min = portBase;
  portBase += size + 5;
  return { min, max: min + size - 1 };
}

const liveSupervisors: Supervisor[] = [];
const scratchDirs: string[] = [];

function startSupervisor(overrides: Partial<WorkerConfig> = {}): Supervisor {
  const cacheDir = mkdtempSync(join(tmpdir(), "is-worker-cache-"));
  scratchDirs.push(cacheDir);
  const range = nextPortRange(4);
  const config: WorkerConfig = {
    controlPlaneUrl: "http://127.0.0.1:9", // closed port — registration off by default
    workerSharedSecret: SECRET,
    workerId: "worker-under-test",
    port: 0,
    publicUrl: "http://worker.test",
    artifactCacheDir: cacheDir,
    artifactCacheMaxBytes: 100 * 1024 * 1024,
    agentIdleStopMs: 60_000,
    agentPortMin: range.min,
    agentPortMax: range.max,
    agentReadyTimeoutMs: 15_000,
    agentStopTimeoutMs: 3_000,
    drainTimeoutMs: 5_000,
    heartbeatIntervalMs: 60_000,
    maxAgents: 20,
    nodeBin: NODE_BIN,
    ...overrides,
  };
  const supervisor = createSupervisor(config);
  liveSupervisors.push(supervisor);
  return supervisor;
}

function internalHeaders(): Record<string, string> {
  return { "x-worker-secret": SECRET, "content-type": "application/json" };
}

async function ensureAgent(
  sup: Supervisor,
  body: { versionHash: string; artifactUrl: string; env?: Record<string, string> },
): Promise<Response> {
  return fetch(`${sup.url}/internal/agents/ensure`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(body),
  });
}

async function getStatus(sup: Supervisor): Promise<WorkerStatusResponse> {
  const res = await fetch(`${sup.url}/internal/status`, {
    headers: internalHeaders(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as WorkerStatusResponse;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await Bun.sleep(intervalMs);
  }
}

function startStubControlPlane(port = 0): {
  url: string;
  port: number;
  calls: { path: string; body: unknown; secret: string | null }[];
  stop(): void;
} {
  const calls: { path: string; body: unknown; secret: string | null }[] = [];
  const server = Bun.serve({
    port,
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        body: await request.json().catch(() => null),
        secret: request.headers.get("x-worker-secret"),
      });
      return Response.json({ ok: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    calls,
    stop: () => server.stop(true),
  };
}

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "is-worker-fixtures-"));
  scratchDirs.push(scratchDir);
  artifacts = startArtifactServer();
  tarPlain = await buildFixtureArtifact({ scratchDir, name: "plain" });
  tarCrash = await buildFixtureArtifact({
    scratchDir,
    name: "crash",
    source: CRASHING_SERVER_SOURCE,
  });
  tarPadded = {
    a: await buildFixtureArtifact({ scratchDir, name: "pad-a", paddingBytes: 300_000 }),
    b: await buildFixtureArtifact({ scratchDir, name: "pad-b", paddingBytes: 300_000 }),
    c: await buildFixtureArtifact({ scratchDir, name: "pad-c", paddingBytes: 300_000 }),
  };
});

afterEach(async () => {
  while (liveSupervisors.length > 0) {
    await liveSupervisors.pop()?.stop();
  }
});

afterAll(() => {
  artifacts.stop();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("internal API auth", () => {
  test("rejects missing and wrong x-worker-secret with 401; accepts the right one", async () => {
    const sup = startSupervisor();
    const bare = await fetch(`${sup.url}/internal/status`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${sup.url}/internal/status`, {
      headers: { "x-worker-secret": "nope" },
    });
    expect(wrong.status).toBe(401);
    const drainWrong = await fetch(`${sup.url}/internal/drain`, { method: "POST" });
    expect(drainWrong.status).toBe(401);
    const right = await fetch(`${sup.url}/internal/status`, {
      headers: internalHeaders(),
    });
    expect(right.status).toBe(200);
    // /healthz stays unauthenticated (compose liveness probe).
    const health = await fetch(`${sup.url}/healthz`);
    expect(health.status).toBe(200);
  });
});

describe("ensure → ready → proxy round-trip", () => {
  test(
    "boots the agent, proxies both forwarded prefixes verbatim, rejects the rest",
    async () => {
      const sup = startSupervisor();
      const hash = "roundtrip-0001";
      const res = await ensureAgent(sup, {
        versionHash: hash,
        artifactUrl: artifacts.urlFor(tarPlain),
      });
      expect(res.status).toBe(200);
      const ensured = (await res.json()) as EnsureAgentResponse;
      expect(ensured.hash).toBe(hash);
      expect(ensured.url).toBe(`http://worker.test/agents/${hash}`);
      expect(ensured.reused).toBe(false);

      // /eve/ prefix: health through the proxy.
      const health = await fetch(`${sup.url}/agents/${hash}/eve/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      // Path + query + headers + body arrive verbatim.
      const echoed = await fetch(
        `${sup.url}/agents/${hash}/eve/v1/platform/dispatch?a=1&b=two%20words`,
        {
          method: "POST",
          headers: { "x-custom-header": "abc", "content-type": "text/plain" },
          body: "hello-body",
        },
      );
      expect(echoed.status).toBe(200);
      const echo = (await echoed.json()) as {
        method: string;
        path: string;
        query: Record<string, string>;
        headers: Record<string, string>;
        body: string;
      };
      expect(echo.method).toBe("POST");
      expect(echo.path).toBe("/eve/v1/platform/dispatch");
      expect(echo.query).toEqual({ a: "1", b: "two words" });
      expect(echo.headers["x-custom-header"]).toBe("abc");
      expect(echo.body).toBe("hello-body");

      // /.well-known/workflow/ MUST forward for the world queue (run
      // callbacks stall otherwise) — but ONLY through the token-authenticated
      // /cb/ route; the public /agents surface refuses it (security review:
      // eve's callback surface has no auth of its own).
      const publicFlow = await fetch(
        `${sup.url}/agents/${hash}/.well-known/workflow/v1/flow?run=42`,
      );
      expect(publicFlow.status).toBe(403);
      expect(((await publicFlow.json()) as ApiErrorBody).error.code).toBe(
        "callback_auth_required",
      );

      const wrongToken = await fetch(
        `${sup.url}/cb/not-the-token/agents/${hash}/.well-known/workflow/v1/flow?run=42`,
      );
      expect(wrongToken.status).toBe(401);
      expect(((await wrongToken.json()) as ApiErrorBody).error.code).toBe(
        "invalid_callback_token",
      );

      const flow = await fetch(
        `${sup.url}/cb/${sup.callbackToken}/agents/${hash}/.well-known/workflow/v1/flow?run=42`,
      );
      expect(flow.status).toBe(200);
      const flowEcho = (await flow.json()) as { path: string; query: Record<string, string> };
      expect(flowEcho.path).toBe("/.well-known/workflow/v1/flow");
      expect(flowEcho.query).toEqual({ run: "42" });

      // Everything else is refused.
      const refused = await fetch(`${sup.url}/agents/${hash}/admin/secrets`);
      expect(refused.status).toBe(404);
      expect(((await refused.json()) as ApiErrorBody).error.code).toBe(
        "path_not_forwarded",
      );
      const noPath = await fetch(`${sup.url}/agents/${hash}`);
      expect(noPath.status).toBe(404);
      const unknownHash = await fetch(
        `${sup.url}/agents/ffffffff9999/eve/v1/health`,
      );
      expect(unknownHash.status).toBe(404);
      expect(((await unknownHash.json()) as ApiErrorBody).error.code).toBe(
        "agent_not_running",
      );
    },
    20_000,
  );

  test(
    "re-ensuring a running hash reuses the process",
    async () => {
      const sup = startSupervisor();
      const hash = "reuse-000001";
      const first = (await (
        await ensureAgent(sup, { versionHash: hash, artifactUrl: artifacts.urlFor(tarPlain) })
      ).json()) as EnsureAgentResponse;
      const second = (await (
        await ensureAgent(sup, { versionHash: hash, artifactUrl: artifacts.urlFor(tarPlain) })
      ).json()) as EnsureAgentResponse;
      expect(second.port).toBe(first.port);
      expect(second.reused).toBe(true);
      const status = await getStatus(sup);
      expect(status.agents).toHaveLength(1);
    },
    20_000,
  );

  test("rejects malformed ensure bodies", async () => {
    const sup = startSupervisor();
    const bad = await fetch(`${sup.url}/internal/agents/ensure`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ versionHash: "../etc/passwd", artifactUrl: "http://x/" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiErrorBody).error.code).toBe("invalid_request");
  });
});

describe("agent process env", () => {
  test(
    "spawned env = caller env + PORT on a minimal base; supervisor env does not leak; NODE_ENV pinned",
    async () => {
      process.env.WORKER_TEST_CANARY = "must-not-leak";
      try {
        const sup = startSupervisor();
        const hash = "envcheck-0001";
        const ensured = (await (
          await ensureAgent(sup, {
            versionHash: hash,
            artifactUrl: artifacts.urlFor(tarPlain),
            env: { FIXTURE_FOO: "bar", OPENROUTER_API_KEY: "sk-test-not-real" },
          })
        ).json()) as EnsureAgentResponse;
        const env = (await (
          await fetch(`${sup.url}/agents/${hash}/eve/v1/env`)
        ).json()) as Record<string, string | undefined>;
        expect(env.FIXTURE_FOO).toBe("bar");
        expect(env.OPENROUTER_API_KEY).toBe("sk-test-not-real");
        expect(env.PORT).toBe(String(ensured.port));
        // Run callbacks traverse the token-authenticated callback route.
        expect(env.WORKFLOW_LOCAL_BASE_URL).toBe(
          `http://worker.test/cb/${sup.callbackToken}/agents/${hash}`,
        );
        // spike/REPORT.md finding 5: NODE_ENV=test flips eve to mock models.
        expect(env.NODE_ENV).toBe("production");
        expect(env.WORKER_TEST_CANARY).toBeUndefined();
        expect(env.PATH).toBeDefined();
      } finally {
        delete process.env.WORKER_TEST_CANARY;
      }
    },
    20_000,
  );
});

describe("streaming proxy", () => {
  test(
    "NDJSON streams through unbuffered (chunks arrive as produced)",
    async () => {
      const sup = startSupervisor();
      const hash = "ndjson-00001";
      await ensureAgent(sup, { versionHash: hash, artifactUrl: artifacts.urlFor(tarPlain) });

      const res = await fetch(
        `${sup.url}/agents/${hash}/eve/v1/ndjson?lines=4&gapMs=150`,
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const chunkTimes: number[] = [];
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkTimes.push(Date.now());
        text += decoder.decode(value, { stream: true });
      }
      const lines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { type: string; i: number });
      expect(lines).toHaveLength(4);
      expect(lines.map((l) => l.i)).toEqual([0, 1, 2, 3]);
      // Buffered proxying would deliver everything in one final gulp; the
      // fixture emits a line every 150ms, so pass-through must show multiple
      // reads spread over ≥ 250ms.
      expect(chunkTimes.length).toBeGreaterThanOrEqual(3);
      expect(chunkTimes.at(-1)! - chunkTimes[0]!).toBeGreaterThanOrEqual(250);
    },
    20_000,
  );
});

describe("idle stop", () => {
  test(
    "stops the agent process after the idle window and frees its port",
    async () => {
      const sup = startSupervisor({ agentIdleStopMs: 300 });
      const hash = "idlestop-0001";
      await ensureAgent(sup, { versionHash: hash, artifactUrl: artifacts.urlFor(tarPlain) });
      expect((await getStatus(sup)).agents).toHaveLength(1);

      await waitFor(async () => (await getStatus(sup)).agents.length === 0, 5_000);
      const status = await getStatus(sup);
      expect(status.ports.allocated).toBe(0);
      // Artifact stays cached for a warm restart…
      expect(status.cache.entries.map((e) => e.hash)).toContain(hash);
      // …but the proxy no longer routes to it.
      const gone = await fetch(`${sup.url}/agents/${hash}/eve/v1/health`);
      expect(gone.status).toBe(404);
    },
    20_000,
  );
});

describe("artifact cache LRU", () => {
  test(
    "evicts the least-recently-used stopped artifact when over the cap",
    async () => {
      const sup = startSupervisor({
        artifactCacheMaxBytes: 700_000, // fits two ~305KB artifacts
      });
      const url = (tar: string) => artifacts.urlFor(tar);

      await ensureAgent(sup, { versionHash: "lru-aaaa0001", artifactUrl: url(tarPadded.a) });
      await sup.agents.stopAgent("lru-aaaa0001");
      await ensureAgent(sup, { versionHash: "lru-bbbb0001", artifactUrl: url(tarPadded.b) });
      await sup.agents.stopAgent("lru-bbbb0001");
      await ensureAgent(sup, { versionHash: "lru-cccc0001", artifactUrl: url(tarPadded.c) });

      const status = await getStatus(sup);
      const cached = status.cache.entries.map((e) => e.hash).sort();
      expect(cached).toEqual(["lru-bbbb0001", "lru-cccc0001"]);
      expect(existsSync(join(sup.config.artifactCacheDir, "lru-aaaa0001"))).toBe(false);
      expect(status.cache.totalBytes).toBeLessThanOrEqual(700_000);
    },
    30_000,
  );

  test(
    "never evicts artifacts of running agents, even over the cap",
    async () => {
      const sup = startSupervisor({ artifactCacheMaxBytes: 1 });
      await ensureAgent(sup, {
        versionHash: "lru-run-aa01",
        artifactUrl: artifacts.urlFor(tarPadded.a),
      });
      await ensureAgent(sup, {
        versionHash: "lru-run-bb01",
        artifactUrl: artifacts.urlFor(tarPadded.b),
      });
      const status = await getStatus(sup);
      expect(status.agents).toHaveLength(2);
      expect(status.cache.entries.map((e) => e.hash).sort()).toEqual([
        "lru-run-aa01",
        "lru-run-bb01",
      ]);
      expect(existsSync(join(sup.config.artifactCacheDir, "lru-run-aa01"))).toBe(true);
      expect(existsSync(join(sup.config.artifactCacheDir, "lru-run-bb01"))).toBe(true);
    },
    30_000,
  );
});

describe("port pool exhaustion", () => {
  test(
    "returns 503 port_pool_exhausted when every agent port is taken",
    async () => {
      const range = nextPortRange(1); // pool of exactly one port
      const sup = startSupervisor({
        agentPortMin: range.min,
        agentPortMax: range.min,
      });
      const first = await ensureAgent(sup, {
        versionHash: "pool-aaaa001",
        artifactUrl: artifacts.urlFor(tarPlain),
      });
      expect(first.status).toBe(200);
      const second = await ensureAgent(sup, {
        versionHash: "pool-bbbb001",
        artifactUrl: artifacts.urlFor(tarPadded.a),
      });
      expect(second.status).toBe(503);
      expect(((await second.json()) as ApiErrorBody).error.code).toBe(
        "port_pool_exhausted",
      );
    },
    20_000,
  );
});

describe("boot failures", () => {
  test(
    "surfaces the crash log and releases the port when the agent dies on boot",
    async () => {
      const sup = startSupervisor();
      const res = await ensureAgent(sup, {
        versionHash: "crash-aaa001",
        artifactUrl: artifacts.urlFor(tarCrash),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe("agent_boot_failed");
      expect(
        (body.error.details as { logTail: string }).logTail,
      ).toContain("fixture boot failure");
      const status = await getStatus(sup);
      expect(status.agents).toHaveLength(0);
      expect(status.ports.allocated).toBe(0);
    },
    20_000,
  );

  test("maps unreachable artifacts to 502 artifact_download_failed", async () => {
    const sup = startSupervisor();
    const res = await ensureAgent(sup, {
      versionHash: "missing-0001",
      artifactUrl: artifacts.urlFor("/nonexistent/artifact.tar.gz"),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe(
      "artifact_download_failed",
    );
  });
});

describe("drain", () => {
  test(
    "finishes in-flight proxied requests, refuses new work, stops agents, deregisters",
    async () => {
      const stub = startStubControlPlane();
      try {
        const sup = startSupervisor({ controlPlaneUrl: stub.url });
        const hash = "drain-aaa001";
        await ensureAgent(sup, { versionHash: hash, artifactUrl: artifacts.urlFor(tarPlain) });

        // In-flight request that outlives the drain call.
        const slow = fetch(`${sup.url}/agents/${hash}/eve/v1/slow?ms=600`);
        await waitFor(async () => (await getStatus(sup)).agents[0]!.inflight > 0, 2_000, 20);

        const drainRes = await fetch(`${sup.url}/internal/drain`, {
          method: "POST",
          headers: internalHeaders(),
        });
        expect(drainRes.status).toBe(202);
        expect(await drainRes.json()).toEqual({ draining: true });

        // New ensures are refused while draining.
        const refused = await ensureAgent(sup, {
          versionHash: "drain-bbb001",
          artifactUrl: artifacts.urlFor(tarPadded.b),
        });
        expect(refused.status).toBe(503);
        expect(((await refused.json()) as ApiErrorBody).error.code).toBe("draining");

        // The in-flight request still completes.
        const slowRes = await slow;
        expect(slowRes.status).toBe(200);
        expect(((await slowRes.json()) as { slow: boolean }).slow).toBe(true);

        // Drain converges: agents stopped, ports freed, deregistered.
        await waitFor(async () => (await getStatus(sup)).agents.length === 0, 8_000);
        const status = await getStatus(sup);
        expect(status.draining).toBe(true);
        expect(status.ports.allocated).toBe(0);
        await waitFor(
          () => stub.calls.some((c) => c.path === "/internal/workers/deregister"),
          3_000,
        );
        const dereg = stub.calls.find((c) => c.path === "/internal/workers/deregister");
        expect((dereg?.body as { id: string }).id).toBe("worker-under-test");
      } finally {
        stub.stop();
      }
    },
    30_000,
  );
});

describe("registration loop", () => {
  test(
    "registers on boot then heartbeats with capacity counts and the shared secret",
    async () => {
      const stub = startStubControlPlane();
      try {
        const sup = startSupervisor({
          controlPlaneUrl: stub.url,
          heartbeatIntervalMs: 40,
        });
        sup.registration.start();
        await waitFor(
          () => stub.calls.some((c) => c.path === "/internal/workers/register"),
          3_000,
        );
        await waitFor(
          () => stub.calls.some((c) => c.path === "/internal/workers/heartbeat"),
          3_000,
        );
        const register = stub.calls.find((c) => c.path === "/internal/workers/register")!;
        expect(register.secret).toBe(SECRET);
        const body = register.body as {
          id: string;
          url: string;
          capacity: { maxAgents: number; runningAgents: number; activeRequests: number };
        };
        expect(body.id).toBe("worker-under-test");
        expect(body.url).toBe("http://worker.test");
        expect(body.capacity.maxAgents).toBe(20);
        expect(body.capacity.runningAgents).toBe(0);
        expect(body.capacity.activeRequests).toBe(0);
        expect(sup.registration.state().registered).toBe(true);
      } finally {
        stub.stop();
      }
    },
    15_000,
  );

  test(
    "tolerates control-plane downtime with backoff and registers once it appears",
    async () => {
      // Reserve a port, then leave it closed until later.
      const placeholder = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = placeholder.port ?? 0;
      placeholder.stop(true);

      const sup = startSupervisor({
        controlPlaneUrl: `http://127.0.0.1:${port}`,
        heartbeatIntervalMs: 30,
      });
      sup.registration.start();
      await Bun.sleep(200);
      expect(sup.registration.state().registered).toBe(false);
      expect(sup.registration.state().consecutiveFailures).toBeGreaterThanOrEqual(1);

      const stub = startStubControlPlane(port);
      try {
        await waitFor(() => sup.registration.state().registered, 8_000);
        expect(stub.calls.some((c) => c.path === "/internal/workers/register")).toBe(true);
      } finally {
        stub.stop();
      }
    },
    15_000,
  );
});
