import { describe, expect, test } from "bun:test";

import { buildAgentEnv, mcpTokenEnvName } from "./agent-env";
import { RuntimeApiError } from "./errors";
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
  maxRunWallClockMs: 600_000,
  maxConcurrentRunsPerWorkspace: 5,
  workerHeartbeatTtlMs: 30_000,
  npmCacheDir: "/tmp/npm-cache",
  buildRoot: "/var/lib/agents",
  sseHeartbeatMs: 15_000,
};

const HASH = "abcdef0123456789abcdef0123456789";

describe("mcpTokenEnvName", () => {
  test("upper-snakes the connection name", () => {
    expect(mcpTokenEnvName("linear")).toBe("MCP_LINEAR_TOKEN");
    expect(mcpTokenEnvName("Deep Wiki v2")).toBe("MCP_DEEP_WIKI_V2_TOKEN");
    expect(mcpTokenEnvName("--weird--")).toBe("MCP_WEIRD_TOKEN");
    expect(mcpTokenEnvName("!!!")).toBe("MCP_CONNECTION_TOKEN");
  });
});

describe("buildAgentEnv", () => {
  test("openrouter versions get OPENROUTER_API_KEY and never the anthropic key", () => {
    const env = buildAgentEnv({
      runtime: RUNTIME,
      worldUrl: "postgres://dev:dev@localhost:5432/ws_v_abcdef012345",
      contentHash: HASH,
      provider: "openrouter",
      mcpEnv: {},
    });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.WORKFLOW_POSTGRES_URL).toContain("ws_v_abcdef012345");
    expect(env.WORKFLOW_POSTGRES_JOB_PREFIX).toBe(HASH);
    expect(env.PLATFORM_JWT_SECRET).toBe("jwt-secret");
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
