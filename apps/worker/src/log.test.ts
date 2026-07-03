import { describe, expect, test } from "bun:test";

import type { StructuredLogEvent } from "@invisible-string/shared";

import { createLogger, stringLogAdapter } from "./log";

function capture() {
  const lines: StructuredLogEvent[] = [];
  const logger = createLogger({
    sink: (event) => lines.push(event),
    minLevel: "debug",
    base: { workerId: "wk_1" },
  });
  return { lines, logger };
}

describe("worker logger", () => {
  test("tags service=worker and binds the worker id", () => {
    const { lines, logger } = capture();
    logger.info("worker.ready", { fields: { port: 4000 } });
    expect(lines[0]).toMatchObject({
      event: "worker.ready",
      workerId: "wk_1",
      fields: { service: "worker", port: 4000 },
    });
  });

  test("stringLogAdapter upgrades legacy string logs to structured JSON", () => {
    const { lines, logger } = capture();
    const log = stringLogAdapter(logger);
    log("agent abc123: ready on :4310");
    expect(lines[0]).toMatchObject({
      level: "info",
      event: "worker.log",
      workerId: "wk_1",
      msg: "agent abc123: ready on :4310",
    });
  });

  test("a secret accidentally logged as a field is scrubbed", () => {
    const { lines, logger } = capture();
    logger.info("worker.log", {
      fields: { WORKER_SHARED_SECRET: "super-secret-value", note: "ok" },
    });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("super-secret-value");
    expect(lines[0]?.fields?.note).toBe("ok");
  });
});
