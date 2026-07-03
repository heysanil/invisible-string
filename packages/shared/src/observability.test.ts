import { describe, expect, test } from "bun:test";

import {
  bucketIndexForDuration,
  buildCacheHitRate,
  computeUtilization,
  createStructuredLogger,
  emptyRunDurationHistogram,
  emptyRunsByStatus,
  internalMetricsResponseSchema,
  isSecretFieldKey,
  makeLogEvent,
  recordRunDuration,
  redactLogFields,
  redactUrlCredentials,
  REDACTION_PLACEHOLDER,
  RUN_DURATION_BUCKET_BOUNDARIES_MS,
  structuredLogEventSchema,
  type StructuredLogEvent,
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

describe("redaction (secrets discipline)", () => {
  test("secret-shaped keys trip isSecretFieldKey; correlation ids do not", () => {
    for (const key of [
      "token",
      "apiKey",
      "MCP_SLACK_TOKEN",
      "x-worker-secret",
      "authorization",
      "continuationToken",
      "password",
      "encryptionKey",
      "jwtSecret",
    ]) {
      expect(isSecretFieldKey(key)).toBe(true);
    }
    for (const key of [
      "workspaceId",
      "workflowId",
      "workflowVersionId",
      "sessionId",
      "runId",
      "workerId",
      "attempt",
      "author",
      "url",
      "status",
    ]) {
      expect(isSecretFieldKey(key)).toBe(false);
    }
  });

  test("known secret keys are scrubbed at every nesting depth", () => {
    const redacted = redactLogFields({
      workerId: "wk_1",
      attempt: 3,
      OPENROUTER_API_KEY: "sk-or-supersecret",
      nested: {
        continuationToken: "ct_leak",
        harmless: "ok",
        deeper: [{ x_worker_secret: "shhh" }, "plain"],
      },
      list: ["visible", "still-visible"],
    });
    expect(redacted).toEqual({
      workerId: "wk_1",
      attempt: 3,
      OPENROUTER_API_KEY: REDACTION_PLACEHOLDER,
      nested: {
        continuationToken: REDACTION_PLACEHOLDER,
        harmless: "ok",
        deeper: [{ x_worker_secret: REDACTION_PLACEHOLDER }, "plain"],
      },
      list: ["visible", "still-visible"],
    });
  });

  test("URL credentials are stripped even under innocuous keys", () => {
    expect(redactUrlCredentials("postgres://user:p4ss@db:5432/world")).toBe(
      `postgres://${REDACTION_PLACEHOLDER}@db:5432/world`,
    );
    const redacted = redactLogFields({
      worldUrl: "postgres://svc:hunter2@world-db:5432/ws_v_abc",
      address: "https://worker-1.internal:8080",
    });
    expect(redacted.worldUrl).toBe(
      `postgres://${REDACTION_PLACEHOLDER}@world-db:5432/ws_v_abc`,
    );
    // no userinfo → untouched
    expect(redacted.address).toBe("https://worker-1.internal:8080");
  });

  test("redactLogFields never mutates its input", () => {
    const input = { token: "leak", keep: "yes" };
    redactLogFields(input);
    expect(input.token).toBe("leak");
  });
});

describe("createStructuredLogger", () => {
  const CLOCK = () => new Date("2026-07-03T00:00:00.000Z");

  function capture(minLevel?: "debug" | "info" | "warn" | "error") {
    const lines: StructuredLogEvent[] = [];
    const logger = createStructuredLogger({
      sink: (event) => lines.push(event),
      now: CLOCK,
      minLevel,
      base: { workerId: "wk_1", fields: { region: "local" } },
    });
    return { lines, logger };
  }

  test("emits a redacted, correlation-carrying JSON event", () => {
    const { lines, logger } = capture();
    logger.info("dispatch.delivered", {
      runId: "run_1",
      durationMs: 42,
      fields: { attempt: 1, MCP_TOKEN: "secret-value" },
    });
    expect(lines).toHaveLength(1);
    const event = lines[0]!;
    expect(structuredLogEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      at: "2026-07-03T00:00:00.000Z",
      level: "info",
      event: "dispatch.delivered",
      workerId: "wk_1",
      runId: "run_1",
    });
    expect(event.fields).toEqual({
      region: "local",
      attempt: 1,
      MCP_TOKEN: REDACTION_PLACEHOLDER,
      durationMs: 42,
    });
    // the raw secret never appears anywhere in the serialized line
    expect(JSON.stringify(event)).not.toContain("secret-value");
  });

  test("minLevel drops lower-severity lines", () => {
    const { lines, logger } = capture("warn");
    logger.info("run.started");
    logger.debug("run.started");
    logger.warn("worker.unreachable", { fields: { attempt: 5 } });
    logger.error("dispatch.failed");
    expect(lines.map((l) => l.event)).toEqual([
      "worker.unreachable",
      "dispatch.failed",
    ]);
  });

  test("child() propagates base correlation ids and merges fields", () => {
    const { lines, logger } = capture();
    const child = logger.child({ workspaceId: "org_1", fields: { phase: "3" } });
    child.info("run.created", { runId: "run_9" });
    const event = lines[0]!;
    // base workerId + child workspaceId + call runId all present
    expect(event.workerId).toBe("wk_1");
    expect(event.workspaceId).toBe("org_1");
    expect(event.runId).toBe("run_9");
    expect(event.fields).toEqual({ region: "local", phase: "3" });
  });

  test("err folds name + message (never the stack) into fields", () => {
    const { lines, logger } = capture();
    logger.error("build.failed", { err: new TypeError("boom at postgres://u:p@h/db") });
    const event = lines[0]!;
    expect(event.fields?.errorName).toBe("TypeError");
    // URL creds inside the error message are still scrubbed
    expect(event.fields?.error).toBe(
      `boom at postgres://${REDACTION_PLACEHOLDER}@h/db`,
    );
    expect(JSON.stringify(event)).not.toContain("stack");
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

  test("buildCacheHitRate is 0-safe", () => {
    expect(buildCacheHitRate(0, 0)).toBe(0);
    expect(buildCacheHitRate(3, 1)).toBe(0.75);
    expect(buildCacheHitRate(1, 0)).toBe(1);
  });

  test("a full metrics snapshot round-trips through the schema", () => {
    const snapshot = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      queueDepth: 4,
      activeRuns: 2,
      runsByStatus: emptyRunsByStatus(),
      activeSessions: 7,
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
      buildCache: { hits: 6, misses: 2, hitRate: buildCacheHitRate(6, 2) },
    };
    const parsed = internalMetricsResponseSchema.parse(snapshot);
    expect(parsed.workers[0]?.utilization).toBe(0.25);
    expect(parsed.triggers.webhook?.failed).toBe(1);
    expect(parsed.activeSessions).toBe(7);
    expect(parsed.buildCache.hitRate).toBe(0.75);
  });

  test("rejects a negative queue depth", () => {
    expect(
      internalMetricsResponseSchema.safeParse({
        generatedAt: "2026-07-03T00:00:00.000Z",
        queueDepth: -1,
        activeRuns: 0,
        runsByStatus: emptyRunsByStatus(),
        activeSessions: 0,
        runDuration: emptyRunDurationHistogram(),
        workers: [],
        triggers: {},
        buildCache: { hits: 0, misses: 0, hitRate: 0 },
      }).success,
    ).toBe(false);
  });
});
