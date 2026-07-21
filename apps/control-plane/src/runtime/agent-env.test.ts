import { describe, expect, test } from "bun:test";

import { connectionTokenEnvVar } from "@invisible-string/compiler";

import { slugifyName } from "../build/compiler-adapter";
import { buildAgentEnv, mcpTokenEnvName } from "./agent-env";
import { RuntimeApiError } from "./errors";
import { derivePlatformJwtSecret } from "./jwt";
import type { RuntimeConfig } from "./config";

const RUNTIME: RuntimeConfig = {
  worldDatabaseUrl: "postgres://dev:dev@localhost:5432/world",
  platformJwtSecret: "jwt-secret",
  workerSharedSecret: "worker-secret",
  s3: {
    endpoint: "http://localhost:9000",
    accessKeyId: "dev",
    secretAccessKey: "devdevdev",
    bucket: "artifacts",
  },
  openrouterApiKey: "or-key",
  anthropicApiKey: "an-key",
  openrouterBaseUrl: undefined,
  mockAuthoredModels: false,
  maxRunWallClockMs: 600_000,
  maxConcurrentRunsPerWorkspace: 5,
  workerHeartbeatTtlMs: 30_000,
  maxAgentsPerWorker: 20,
  workerSweepIntervalMs: 30_000,
  scheduleTickMs: 30_000,
  npmCacheDir: "/tmp/npm-cache",
  buildRoot: "/var/lib/agents",
  sseHeartbeatMs: 15_000,
  worldMaxPoolSize: 5,
  worldWorkerConcurrency: 5,
  workerRequestTimeoutMs: 120_000,
  allowInsecureWorkerTransport: false,
  workerAuthMode: "shared-secret",
};

const HASH = "abcdef0123456789abcdef0123456789";

describe("mcpTokenEnvName", () => {
  test("upper-snakes the connection name", () => {
    expect(mcpTokenEnvName("linear")).toBe("MCP_LINEAR_TOKEN");
    expect(mcpTokenEnvName("Deep Wiki v2")).toBe("MCP_DEEP_WIKI_V2_TOKEN");
    expect(mcpTokenEnvName("--weird--")).toBe("MCP_WEIRD_TOKEN");
    expect(mcpTokenEnvName("!!!")).toBe("MCP_CONNECTION_TOKEN");
  });

  test("agrees with the compiler for >64-char names (slug truncation)", () => {
    // The generated code reads connectionTokenEnvVar(slugifyName(name)); the
    // dispatcher must inject the SAME var or publish fails with the adapter's
    // "token env var mismatch" guard.
    const longName = `Very ${"long ".repeat(20)}connection name`;
    expect(mcpTokenEnvName(longName)).toBe(
      connectionTokenEnvVar(slugifyName(longName)),
    );
  });
});

describe("buildAgentEnv", () => {
  test("openrouter versions get OPENROUTER_API_KEY and never the anthropic key", () => {
    const env = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://dev:dev@localhost:5432/ag_v_abcdef012345",
      contentHash: HASH,
      provider: "openrouter",
      mcpEnv: {},
    });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.WORKFLOW_POSTGRES_URL).toContain("ag_v_abcdef012345");
    expect(env.WORKFLOW_POSTGRES_JOB_PREFIX).toBe(HASH);
    // Per-version DERIVED secret — never the platform master.
    expect(env.PLATFORM_JWT_SECRET).toBe(derivePlatformJwtSecret("jwt-secret", HASH));
    expect(env.PLATFORM_JWT_SECRET).not.toBe("jwt-secret");
    // Postgres connection budget (spike REPORT finding 15).
    expect(env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("5");
    expect(env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe("5");
  });

  test("different versions get DIFFERENT derived JWT secrets", () => {
    const a = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://x/a",
      contentHash: "a".repeat(64),
      provider: "openrouter",
      mcpEnv: {},
    });
    const b = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://x/b",
      contentHash: "b".repeat(64),
      provider: "openrouter",
      mcpEnv: {},
    });
    expect(a.PLATFORM_JWT_SECRET).not.toBe(b.PLATFORM_JWT_SECRET);
  });

  test("anthropic versions get ANTHROPIC_API_KEY only", () => {
    const env = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://x/y",
      contentHash: HASH,
      provider: "anthropic",
      mcpEnv: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBe("an-key");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("OPENROUTER_BASE_URL");
  });

  test("OPENROUTER_BASE_URL passes through when configured (openrouter only)", () => {
    const runtime = { ...RUNTIME, openrouterBaseUrl: "http://localhost:9910/v1" };
    const openrouterEnv = buildAgentEnv({
      runtime,
      worldUrl: "postgres://x/y",
      contentHash: HASH,
      provider: "openrouter",
      mcpEnv: {},
    });
    expect(openrouterEnv.OPENROUTER_BASE_URL).toBe("http://localhost:9910/v1");
    const anthropicEnv = buildAgentEnv({
      runtime,
      worldUrl: "postgres://x/y",
      contentHash: HASH,
      provider: "anthropic",
      mcpEnv: {},
    });
    expect(anthropicEnv).not.toHaveProperty("OPENROUTER_BASE_URL");
  });

  test("missing provider key is a typed 500", () => {
    try {
      buildAgentEnv({
        runtime: { ...RUNTIME, anthropicApiKey: undefined },
        worldUrl: "postgres://x/y",
        contentHash: HASH,
        provider: "anthropic",
        mcpEnv: {},
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeApiError);
      expect((error as RuntimeApiError).code).toBe("provider_key_missing");
    }
  });

  test("decrypted MCP tokens ride along", () => {
    const env = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://x/y",
      contentHash: HASH,
      provider: "openrouter",
      mcpEnv: { MCP_LINEAR_TOKEN: "lin-token" },
    });
    expect(env.MCP_LINEAR_TOKEN).toBe("lin-token");
  });
});
