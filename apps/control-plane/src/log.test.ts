import { describe, expect, test } from "bun:test";

import type { StructuredLogEvent } from "@invisible-string/shared";

import { createLogger, resolveLogLevel } from "./log";

function capture() {
  const lines: StructuredLogEvent[] = [];
  const logger = createLogger({
    sink: (event) => lines.push(event),
    minLevel: "debug",
    base: { workspaceId: "org_1" },
  });
  return { lines, logger };
}

describe("control-plane logger", () => {
  test("stamps the service tag and base correlation ids", () => {
    const { lines, logger } = capture();
    logger.info("run.created", { runId: "run_1" });
    expect(lines[0]).toMatchObject({
      level: "info",
      event: "run.created",
      workspaceId: "org_1",
      runId: "run_1",
      fields: { service: "control-plane" },
    });
  });

  test("scrubs secret-shaped fields before they reach the sink", () => {
    const { lines, logger } = capture();
    logger.info("dispatch.delivered", {
      runId: "run_2",
      fields: {
        OPENROUTER_API_KEY: "sk-or-LEAK",
        worldUrl: "postgres://svc:pw@db/ws",
        attempt: 2,
      },
    });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("sk-or-LEAK");
    expect(serialized).not.toContain(":pw@");
    expect(lines[0]?.fields?.attempt).toBe(2);
  });

  test("child loggers thread additional correlation ids", () => {
    const { lines, logger } = capture();
    logger.child({ runId: "run_3", workerId: "wk_9" }).warn("worker.unreachable");
    expect(lines[0]).toMatchObject({
      workspaceId: "org_1",
      runId: "run_3",
      workerId: "wk_9",
      level: "warn",
    });
  });

  test("resolveLogLevel honors LOG_LEVEL and defaults to info", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ LOG_LEVEL: "WARN" })).toBe("warn");
    expect(resolveLogLevel({ LOG_LEVEL: "nonsense" })).toBe("info");
    expect(resolveLogLevel({})).toBe("info");
  });
});
