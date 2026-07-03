import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import type { StructuredLogEvent } from "@invisible-string/shared";

import { createLogger } from "./log";
import { requestLoggerPlugin } from "./request-log";

function harness() {
  const lines: StructuredLogEvent[] = [];
  const logger = createLogger({ sink: (e) => lines.push(e), minLevel: "debug" });
  const app = new Elysia()
    .use(requestLoggerPlugin(logger))
    // A handler that logs with the request-scoped child logger.
    .get("/thing/:id", ({ reqLog, params }) => {
      reqLog.info("run.created", { runId: `run_${params.id}` });
      return { ok: true };
    });
  return { lines, app };
}

describe("requestLoggerPlugin", () => {
  test("closes each request with one http.request line (method/path/status/duration)", async () => {
    const { lines, app } = harness();
    const res = await app.handle(new Request("http://localhost/thing/7"));
    expect(res.status).toBe(200);
    const http = lines.find((l) => l.event === "http.request");
    expect(http?.fields).toMatchObject({ method: "GET", path: "/thing/7", status: 200 });
    expect(typeof http?.fields?.durationMs).toBe("number");
  });

  test("propagates an inbound x-request-id across the whole request", async () => {
    const { lines, app } = harness();
    await app.handle(
      new Request("http://localhost/thing/42", {
        headers: { "x-request-id": "req-abc-123" },
      }),
    );
    // Both the handler's own log and the completion line carry the SAME id.
    const handlerLine = lines.find((l) => l.event === "run.created");
    const httpLine = lines.find((l) => l.event === "http.request");
    expect(handlerLine?.fields?.requestId).toBe("req-abc-123");
    expect(handlerLine?.runId).toBe("run_42");
    expect(httpLine?.fields?.requestId).toBe("req-abc-123");
  });

  test("mints a requestId when none is provided", async () => {
    const { lines, app } = harness();
    await app.handle(new Request("http://localhost/thing/1"));
    const httpLine = lines.find((l) => l.event === "http.request");
    expect(typeof httpLine?.fields?.requestId).toBe("string");
    expect((httpLine?.fields?.requestId as string).length).toBeGreaterThan(0);
  });
});
