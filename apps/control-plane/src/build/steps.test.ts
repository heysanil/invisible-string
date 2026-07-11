import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type RunCommand,
  assertSafeRelativePath,
  buildStepEnv,
  createBuildSteps,
  createSetupDatabaseRunner,
  resolveNodeBinDir,
} from "./steps";

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
      { NODE_ENV: "production", WORKFLOW_POSTGRES_URL: "postgres://world/ag_v_x" },
      base,
    );
    expect(env.NODE_ENV).toBe("production");
    expect(env.WORKFLOW_POSTGRES_URL).toBe("postgres://world/ag_v_x");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("resolveNodeBinDir (build-step Node 24 runtime)", () => {
  const emptyHome = (): string => mkdtempSync(join(tmpdir(), "no-mise-home-"));

  test("BUILD_NODE_BIN override wins and yields its bin dir", () => {
    const dir = resolveNodeBinDir({
      BUILD_NODE_BIN: "/opt/node24/bin/node",
      HOME: emptyHome(),
      PATH: "",
    });
    expect(dir).toBe("/opt/node24/bin");
  });

  test("picks the newest mise-installed node 24 (numeric, not lexicographic)", () => {
    const home = mkdtempSync(join(tmpdir(), "mise-home-"));
    for (const version of ["24.2.0", "24.10.1", "22.9.0"]) {
      const bin = join(home, ".local/share/mise/installs/node", version, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), "", { mode: 0o755 });
    }
    expect(resolveNodeBinDir({ HOME: home, PATH: "" })).toBe(
      join(home, ".local/share/mise/installs/node/24.10.1/bin"),
    );
  });

  test("falls back to node on PATH (production image layout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-node-"));
    writeFileSync(join(dir, "node"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveNodeBinDir({ HOME: emptyHome(), PATH: dir })).toBe(dir);
  });

  test("returns null when no Node runtime is found", () => {
    expect(resolveNodeBinDir({ HOME: emptyHome(), PATH: "" })).toBeNull();
  });
});

describe("createBuildSteps node invocation (no mise binary at runtime)", () => {
  const NODE_BIN_DIR = "/opt/node24/bin";

  function capture(): {
    calls: { cmd: string[]; env: Record<string, string> | undefined }[];
    run: RunCommand;
  } {
    const calls: { cmd: string[]; env: Record<string, string> | undefined }[] = [];
    const run: RunCommand = async (cmd, options) => {
      calls.push({ cmd, env: options.env });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  function makeSteps(run: RunCommand, nodeBinDir: string | null) {
    return createBuildSteps({
      runtime: {
        npmCacheDir: mkdtempSync(join(tmpdir(), "npm-cache-")),
        worldDatabaseUrl: "postgres://dev:dev@localhost:5432/world",
      },
      run,
      provisionWorld: async () => {},
      nodeBinDir,
    });
  }

  test("npm install runs npm directly with the node bin dir prepended to PATH", async () => {
    const { calls, run } = capture();
    await makeSteps(run, NODE_BIN_DIR).install(mkdtempSync(join(tmpdir(), "proj-")));
    const call = calls[0];
    expect(call?.cmd[0]).toBe("npm");
    expect(call?.cmd).not.toContain("mise");
    expect(call?.env?.PATH?.startsWith(`${NODE_BIN_DIR}:`)).toBe(true);
    expect(call?.env?.npm_config_cache).toBeDefined();
  });

  test("eve build runs npx directly with the node bin dir prepended to PATH", async () => {
    const { calls, run } = capture();
    const projectDir = mkdtempSync(join(tmpdir(), "proj-"));
    // eveBuild verifies the entrypoint exists after a "successful" build.
    mkdirSync(join(projectDir, ".output", "server"), { recursive: true });
    writeFileSync(join(projectDir, ".output", "server", "index.mjs"), "");
    await makeSteps(run, NODE_BIN_DIR).eveBuild(projectDir);
    const call = calls[0];
    expect(call?.cmd.slice(0, 4)).toEqual(["npx", "--no-install", "eve", "build"]);
    expect(call?.env?.PATH?.startsWith(`${NODE_BIN_DIR}:`)).toBe(true);
    expect(call?.env?.NODE_ENV).toBe("production");
  });

  test("world setup runs node directly with the node bin dir prepended to PATH", async () => {
    const { calls, run } = capture();
    const runner = createSetupDatabaseRunner(run, NODE_BIN_DIR);
    await runner("/tmp/proj", "postgres://dev:dev@localhost:5432/ag_v_abc");
    const call = calls[0];
    expect(call?.cmd[0]).toBe("node");
    expect(call?.env?.PATH?.startsWith(`${NODE_BIN_DIR}:`)).toBe(true);
    expect(call?.env?.WORKFLOW_POSTGRES_URL).toBe("postgres://dev:dev@localhost:5432/ag_v_abc");
  });

  test("steps fail with setup guidance when no Node 24 runtime was resolved", async () => {
    const { run } = capture();
    const error = await makeSteps(run, null)
      .install(mkdtempSync(join(tmpdir(), "proj-")))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({
      name: "BuildStepError",
      log: expect.stringContaining("BUILD_NODE_BIN"),
    });
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
