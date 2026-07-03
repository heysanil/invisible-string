import { describe, expect, test } from "bun:test";

import { ConfigError, loadConfig } from "./config";

/** Minimal valid env; WORKER_NODE_BIN avoids filesystem probing in tests. */
const BASE_ENV = {
  CONTROL_PLANE_URL: "http://control-plane:3000",
  WORKER_SHARED_SECRET: "test-secret-0123456789-0123456789",
  WORKER_NODE_BIN: "/bin/echo",
};

describe("loadConfig", () => {
  test("applies documented defaults", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.port).toBe(4000);
    expect(config.publicUrl).toBe("http://localhost:4000");
    expect(config.artifactCacheDir).toBe("/var/lib/agents");
    expect(config.artifactCacheMaxBytes).toBe(20 * 1024 ** 3);
    expect(config.agentIdleStopMs).toBe(15 * 60_000);
    expect(config.agentPortMin).toBe(4310);
    expect(config.agentPortMax).toBe(4409);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.maxAgents).toBe(20);
    expect(config.nodeBin).toBe("/bin/echo");
    // WORKER_ID unset → generated per boot (uuid-ish, non-empty).
    expect(config.workerId.length).toBeGreaterThan(8);
  });

  test("lists every missing required variable at once", () => {
    expect(() => loadConfig({ WORKER_NODE_BIN: "/bin/echo" })).toThrow(ConfigError);
    try {
      loadConfig({ WORKER_NODE_BIN: "/bin/echo" });
      expect.unreachable();
    } catch (err) {
      const problems = (err as ConfigError).problems.join("\n");
      expect(problems).toContain("CONTROL_PLANE_URL");
      expect(problems).toContain("WORKER_SHARED_SECRET");
    }
  });

  test("rejects a short WORKER_SHARED_SECRET (offline-brute-forceable)", () => {
    try {
      loadConfig({ ...BASE_ENV, WORKER_SHARED_SECRET: "short" });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems.join("\n")).toContain(
        "at least 32 characters",
      );
    }
  });

  test("rejects malformed values with readable problems", () => {
    try {
      loadConfig({
        ...BASE_ENV,
        CONTROL_PLANE_URL: "not-a-url",
        PORT: "eighty",
        ARTIFACT_CACHE_MAX_BYTES: "-5",
        AGENT_PORT_MIN: "5000",
        AGENT_PORT_MAX: "4000",
      });
      expect.unreachable();
    } catch (err) {
      const problems = (err as ConfigError).problems.join("\n");
      expect(problems).toContain("CONTROL_PLANE_URL");
      expect(problems).toContain("PORT");
      expect(problems).toContain("ARTIFACT_CACHE_MAX_BYTES");
      expect(problems).toContain("AGENT_PORT_MIN");
    }
  });

  test("respects explicit overrides and normalizes trailing slashes", () => {
    const config = loadConfig({
      ...BASE_ENV,
      CONTROL_PLANE_URL: "http://cp.internal:3000/",
      WORKER_ID: "worker-7",
      PORT: "4444",
      PUBLIC_URL: "https://worker-7.internal/",
      ARTIFACT_CACHE_DIR: "/data/agents",
      ARTIFACT_CACHE_MAX_BYTES: "1048576",
      AGENT_IDLE_STOP_MS: "1000",
      AGENT_PORT_MIN: "5100",
      AGENT_PORT_MAX: "5105",
      HEARTBEAT_INTERVAL_MS: "250",
      WORKER_MAX_AGENTS: "3",
    });
    expect(config.controlPlaneUrl).toBe("http://cp.internal:3000");
    expect(config.workerId).toBe("worker-7");
    expect(config.port).toBe(4444);
    expect(config.publicUrl).toBe("https://worker-7.internal");
    expect(config.artifactCacheDir).toBe("/data/agents");
    expect(config.artifactCacheMaxBytes).toBe(1_048_576);
    expect(config.agentIdleStopMs).toBe(1000);
    expect(config.agentPortMin).toBe(5100);
    expect(config.agentPortMax).toBe(5105);
    expect(config.heartbeatIntervalMs).toBe(250);
    expect(config.maxAgents).toBe(3);
  });

  test("derives PUBLIC_URL default from a custom PORT", () => {
    const config = loadConfig({ ...BASE_ENV, PORT: "4123" });
    expect(config.publicUrl).toBe("http://localhost:4123");
  });
});
