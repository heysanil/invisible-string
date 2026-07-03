import { describe, expect, test } from "bun:test";

import { assertSafeRelativePath, buildStepEnv } from "./steps";

describe("buildStepEnv (build-subprocess secrets scrub)", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/cp",
    LANG: "en_US.UTF-8",
    // Control-plane secrets that must NEVER reach npm/eve-build/setup.js:
    ENCRYPTION_MASTER_KEY: "supersecret",
    PLATFORM_JWT_SECRET: "supersecret",
    WORKER_SHARED_SECRET: "supersecret",
    OPENROUTER_API_KEY: "supersecret",
    ANTHROPIC_API_KEY: "supersecret",
    DATABASE_URL: "postgres://secret@db/product",
    WORLD_DATABASE_URL: "postgres://secret@db/world",
    S3_SECRET_ACCESS_KEY: "supersecret",
  };

  test("passes only allowlisted hygiene vars through", () => {
    const env = buildStepEnv(undefined, base);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/cp",
      LANG: "en_US.UTF-8",
    });
  });

  test("never leaks control-plane secrets", () => {
    const env = buildStepEnv({ npm_config_cache: "/tmp/cache" }, base);
    for (const key of [
      "ENCRYPTION_MASTER_KEY",
      "PLATFORM_JWT_SECRET",
      "WORKER_SHARED_SECRET",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
      "WORLD_DATABASE_URL",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("per-step extras ride along (and win over the base)", () => {
    const env = buildStepEnv(
      { NODE_ENV: "production", WORKFLOW_POSTGRES_URL: "postgres://world/ws_v_x" },
      base,
    );
    expect(env.NODE_ENV).toBe("production");
    expect(env.WORKFLOW_POSTGRES_URL).toBe("postgres://world/ws_v_x");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("assertSafeRelativePath", () => {
  test("rejects traversal and absolute paths", () => {
    expect(() => assertSafeRelativePath("../evil")).toThrow();
    expect(() => assertSafeRelativePath("/abs")).toThrow();
    expect(() => assertSafeRelativePath("a/../../b")).toThrow();
    expect(() => assertSafeRelativePath("")).toThrow();
  });

  test("accepts normal project-relative paths", () => {
    expect(() => assertSafeRelativePath("agent/agent.ts")).not.toThrow();
    expect(() => assertSafeRelativePath("package.json")).not.toThrow();
  });
});
