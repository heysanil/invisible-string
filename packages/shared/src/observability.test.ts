import { describe, expect, test } from "bun:test";

import {
  bucketIndexForDuration,
  computeUtilization,
  emptyRunDurationHistogram,
  emptyRunsByStatus,
  internalMetricsResponseSchema,
  makeLogEvent,
  recordRunDuration,
  RUN_DURATION_BUCKET_BOUNDARIES_MS,
  structuredLogEventSchema,
} from "./observability";

describe("structured log events", () => {
  test("makeLogEvent drops undefined correlation ids", () => {
    const event = makeLogEvent({
      level: "info",
      event: "run.started",
      workspaceId: "org_1",
      runId: "run_1",
      at: new Date("2026-07-03T00:00:00.000Z"),
    });
    expect(event).toEqual({
      at: "2026-07-03T00:00:00.000Z",
      level: "info",
      event: "run.started",
      workspaceId: "org_1",
      runId: "run_1",
    });
    // absent ids are truly absent, not `undefined`
    expect("workflowId" in event).toBe(false);
    expect("sessionId" in event).toBe(false);
    expect(structuredLogEventSchema.safeParse(event).success).toBe(true);
  });

  test("carries the full correlation chain + structured fields", () => {
    const event = makeLogEvent({
      level: "error",
      event: "dispatch.failed",
      workspaceId: "org_1",
      workflowId: "wf_1",
      workflowVersionId: "wfv_1",
      sessionId: "sess_1",
      runId: "run_1",
      workerId: "wk_1",
      msg: "worker unreachable",
      fields: { attempt: 3, worker: { url: "https://w1" }, ids: ["a", "b"] },
    });
    const parsed = structuredLogEventSchema.parse(event);
    expect(parsed.fields).toEqual({
      attempt: 3,
      worker: { url: "https://w1" },
      ids: ["a", "b"],
    });
    expect(parsed.workerId).toBe("wk_1");
  });

  test("empty fields object is omitted", () => {
    const event = makeLogEvent({ level: "debug", event: "x", fields: {} });
    expect("fields" in event).toBe(false);
  });
});

describe("run duration histogram", () => {
  test("empty histogram has boundaries.length + 1 zeroed buckets", () => {
    const h = emptyRunDurationHistogram();
    expect(h.counts).toHaveLength(RUN_DURATION_BUCKET_BOUNDARIES_MS.length + 1);
    expect(h.counts.every((c) => c === 0)).toBe(true);
    expect(h.count).toBe(0);
    expect(h.sumMs).toBe(0);
  });

  test("bucket index respects upper-bound-inclusive edges", () => {
    // boundaries: 100, 500, 1000, 5000, 15000, 60000, 300000, 600000
    expect(bucketIndexForDuration(50)).toBe(0); // <= 100
    expect(bucketIndexForDuration(100)).toBe(0); // inclusive edge
    expect(bucketIndexForDuration(101)).toBe(1);
    expect(bucketIndexForDuration(600_000)).toBe(7); // last real bucket
    expect(bucketIndexForDuration(600_001)).toBe(8); // overflow
    expect(bucketIndexForDuration(-5)).toBe(0); // clamp
  });

  test("recordRunDuration is immutable and accumulates", () => {
    const empty = emptyRunDurationHistogram();
    const a = recordRunDuration(empty, 42);
    const b = recordRunDuration(a, 750);
    expect(empty.count).toBe(0); // unchanged
    expect(b.count).toBe(2);
    expect(b.sumMs).toBe(792);
    expect(b.counts[bucketIndexForDuration(42)]).toBe(1);
    expect(b.counts[bucketIndexForDuration(750)]).toBe(1);
  });

  test("NaN durations are ignored", () => {
    const h = recordRunDuration(emptyRunDurationHistogram(), Number.NaN);
    expect(h.count).toBe(0);
  });
});

describe("worker utilization", () => {
  test("computeUtilization is bounded and zero-safe", () => {
    expect(computeUtilization(0, 0)).toBe(0);
    expect(computeUtilization(5, 0)).toBe(0);
    expect(computeUtilization(5, 20)).toBe(0.25);
    expect(computeUtilization(30, 20)).toBe(1); // clamped
  });
});

describe("GET /internal/metrics DTO", () => {
  test("emptyRunsByStatus covers every run status", () => {
    expect(emptyRunsByStatus()).toEqual({
      queued: 0,
      running: 0,
      waiting: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    });
  });

  test("a full metrics snapshot round-trips through the schema", () => {
    const snapshot = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      queueDepth: 4,
      activeRuns: 2,
      runsByStatus: emptyRunsByStatus(),
      runDuration: recordRunDuration(emptyRunDurationHistogram(), 1234),
      workers: [
        {
          workerId: "wk_1",
          status: "live" as const,
          maxAgents: 20,
          runningAgents: 5,
          activeRequests: 2,
          utilization: computeUtilization(5, 20),
          lastHeartbeatAt: "2026-07-03T00:00:00.000Z",
        },
      ],
      triggers: {
        webhook: { received: 10, dispatched: 9, failed: 1 },
        slack: { received: 3, dispatched: 3, failed: 0 },
      },
    };
    const parsed = internalMetricsResponseSchema.parse(snapshot);
    expect(parsed.workers[0]?.utilization).toBe(0.25);
    expect(parsed.triggers.webhook?.failed).toBe(1);
  });

  test("rejects a negative queue depth", () => {
    expect(
      internalMetricsResponseSchema.safeParse({
        generatedAt: "2026-07-03T00:00:00.000Z",
        queueDepth: -1,
        activeRuns: 0,
        runsByStatus: emptyRunsByStatus(),
        runDuration: emptyRunDurationHistogram(),
        workers: [],
        triggers: {},
      }).success,
    ).toBe(false);
  });
});
