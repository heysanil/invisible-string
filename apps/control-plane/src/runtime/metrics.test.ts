import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  emptyRunsByStatus,
  internalMetricsResponseSchema,
  type RunStatus,
} from "@invisible-string/shared";

import {
  collectMetrics,
  MetricsRegistry,
  metricsPlugin,
  renderMetricsText,
  type MetricsDbReader,
  type MetricsWorkerRow,
} from "./metrics";

const SECRET = "metrics-test-secret-0123456789-0123456789";

/** A fake DB reader — no live Postgres. */
function fakeReader(overrides: Partial<{
  runsByStatus: Record<RunStatus, number>;
  activeSessions: number;
  workers: MetricsWorkerRow[];
}> = {}): MetricsDbReader {
  return {
    async runsByStatus() {
      return { ...emptyRunsByStatus(), ...(overrides.runsByStatus ?? {}) };
    },
    async activeSessions() {
      return overrides.activeSessions ?? 0;
    },
    async workers() {
      return overrides.workers ?? [];
    },
  };
}

describe("MetricsRegistry", () => {
  test("trigger counters increment per type and outcome", () => {
    const m = new MetricsRegistry();
    m.recordTrigger("manual", "received");
    m.recordTrigger("manual", "dispatched");
    m.recordTrigger("webhook", "received");
    m.recordTrigger("webhook", "failed");
    m.recordTrigger("webhook", "received");
    expect(m.triggerCounts()).toEqual({
      manual: { received: 1, dispatched: 1, failed: 0 },
      webhook: { received: 2, dispatched: 0, failed: 1 },
    });
  });

  test("run-duration observations land in histogram buckets", () => {
    const m = new MetricsRegistry();
    m.recordRunDuration(42);
    m.recordRunDuration(750);
    m.recordRunDuration(Number.NaN); // ignored
    const h = m.runDuration();
    expect(h.count).toBe(2);
    expect(h.sumMs).toBe(792);
  });

  test("build-cache hit rate reflects hits vs misses", () => {
    const m = new MetricsRegistry();
    m.recordBuildCache(true);
    m.recordBuildCache(true);
    m.recordBuildCache(false);
    expect(m.buildCache()).toEqual({ hits: 2, misses: 1, hitRate: 2 / 3 });
  });
});

describe("collectMetrics", () => {
  const NOW = new Date("2026-07-03T00:00:00.000Z");

  test("folds registry + DB read into the shared contract", async () => {
    const registry = new MetricsRegistry();
    registry.recordTrigger("manual", "dispatched");
    registry.recordRunDuration(1234);
    registry.recordBuildCache(true);

    const reader = fakeReader({
      runsByStatus: {
        ...emptyRunsByStatus(),
        queued: 3,
        running: 2,
        succeeded: 10,
      },
      activeSessions: 5,
      workers: [
        {
          id: "wk_1",
          status: "live",
          capacity: { maxAgents: 20, runningAgents: 5, activeRequests: 2 },
          lastHeartbeatAt: NOW,
        },
        // capacity missing fields → zeros, utilization 0-safe
        {
          id: "wk_2",
          status: "draining",
          capacity: {},
          lastHeartbeatAt: NOW,
        },
      ],
    });

    const snapshot = await collectMetrics({ registry, reader, now: NOW });
    expect(internalMetricsResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.queueDepth).toBe(3);
    expect(snapshot.activeRuns).toBe(2);
    expect(snapshot.activeSessions).toBe(5);
    expect(snapshot.runDuration.count).toBe(1);
    expect(snapshot.buildCache.hits).toBe(1);
    expect(snapshot.workers[0]).toMatchObject({
      workerId: "wk_1",
      utilization: 0.25,
      runningAgents: 5,
    });
    expect(snapshot.workers[1]).toMatchObject({
      workerId: "wk_2",
      maxAgents: 0,
      utilization: 0,
    });
  });
});

describe("renderMetricsText", () => {
  test("emits Prometheus-style lines", async () => {
    const registry = new MetricsRegistry();
    registry.recordTrigger("manual", "received");
    const snapshot = await collectMetrics({
      registry,
      reader: fakeReader({ runsByStatus: { ...emptyRunsByStatus(), queued: 4 } }),
    });
    const text = renderMetricsText(snapshot);
    expect(text).toContain("is_scheduler_queue_depth 4");
    expect(text).toContain('is_triggers_total{type="manual",outcome="received"} 1');
    expect(text).toContain('is_run_duration_ms_bucket{le="+Inf"}');
  });
});

describe("metricsPlugin (worker-secret guarded)", () => {
  function app(registry = new MetricsRegistry()) {
    return {
      registry,
      instance: new Elysia().use(
        metricsPlugin({ registry, reader: fakeReader(), workerSharedSecret: SECRET }),
      ),
    };
  }

  test("401 without the shared secret", async () => {
    const { instance } = app();
    const res = await instance.handle(
      new Request("http://localhost/internal/metrics"),
    );
    expect(res.status).toBe(401);
  });

  test("401 with a wrong secret", async () => {
    const { instance } = app();
    const res = await instance.handle(
      new Request("http://localhost/internal/metrics", {
        headers: { "x-worker-secret": "nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("200 JSON with the shared secret; counters reflected", async () => {
    const { registry, instance } = app();
    registry.recordTrigger("manual", "dispatched");
    const res = await instance.handle(
      new Request("http://localhost/internal/metrics", {
        headers: { "x-worker-secret": SECRET },
      }),
    );
    expect(res.status).toBe(200);
    const body = internalMetricsResponseSchema.parse(await res.json());
    expect(body.triggers.manual?.dispatched).toBe(1);
  });

  test("text exposition when ?format=text", async () => {
    const { instance } = app();
    const res = await instance.handle(
      new Request("http://localhost/internal/metrics?format=text", {
        headers: { "x-worker-secret": SECRET },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("is_scheduler_queue_depth");
  });
});
