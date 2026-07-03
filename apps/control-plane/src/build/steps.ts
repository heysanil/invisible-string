/**
 * Real build steps (docs/PLAN.md Phase 1 task 3): compiled files → installed
 * project → `eve build` → tar.gz artifact.
 *
 * eve requires Node 24.x (host Bun stays the control-plane runtime); every
 * node/npm invocation runs through `mise exec node@24 --`. npm installs share
 * NPM_CACHE_DIR across builds.
 *
 * PATHS: builds happen under the CANONICAL build root
 * (`<buildRoot>/<hash>`) because eve build output is NOT path-relocatable
 * (spike/REPORT.md finding 13 — absolute appRoot paths are baked into
 * .output/server/index.mjs). Workers must extract the artifact to the SAME
 * `<buildRoot>/<hash>` path. NOTE(integration): reconcile buildRoot with
 * apps/worker's extract root (AGENT_BUILD_ROOT on both sides).
 *
 * ARTIFACT CONTENTS: `.output/` (the self-contained nitro server),
 * `.eve/compile/compiled-agent-manifest.json` (schedule manifest, when
 * present) and `manifest.json` (build metadata). node_modules is NOT shipped
 * — `.output` bundles its runtime deps. NOTE(integration): if the worker
 * supervisor ends up running the `eve start` CLI instead of
 * `node .output/server/index.mjs`, widen this tarball (or npm-install eve on
 * the worker) at the Integrate stage.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

import type { RuntimeConfig } from "../runtime/config";
import { worldSetupBinPath } from "./world";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One shell step; non-zero exit fails the build with the captured output. */
export type RunCommand = (
  cmd: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<CommandResult>;

export interface BuildSteps {
  /** Materialize compiled files into the canonical project dir. */
  writeFiles(projectDir: string, files: ReadonlyMap<string, string>): Promise<void>;
  /** npm install with the shared cache (mise node@24). */
  install(projectDir: string): Promise<void>;
  /** npx eve build (mise node@24). */
  eveBuild(projectDir: string): Promise<void>;
  /** Provision + bootstrap the version's dedicated world database. */
  provisionWorld(contentHash: string, projectDir: string): Promise<void>;
  /** tar.gz the runnable output; returns the artifact bytes. */
  packageArtifact(projectDir: string, contentHash: string): Promise<Uint8Array>;
}

export class BuildStepError extends Error {
  override readonly name = "BuildStepError";
  constructor(
    public readonly step: string,
    public readonly log: string,
  ) {
    super(`build step "${step}" failed`);
  }
}

/**
 * Env allowlist for build subprocesses. Build steps run THIRD-PARTY code
 * (npm-installed dependency trees, `eve build`, world setup.js) — they must
 * never inherit the control plane's secrets (ENCRYPTION_MASTER_KEY,
 * PLATFORM_JWT_SECRET, WORKER_SHARED_SECRET, provider API keys, DB URLs).
 * Only process-hygiene vars pass through; each step adds exactly what it
 * needs via options.env (npm_config_cache, NODE_ENV, WORKFLOW_POSTGRES_URL).
 */
const STEP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  // mise resolves node@24 through these when customized.
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
] as const;

/** Scrubbed base env + per-step additions (exported for tests). */
export function buildStepEnv(
  extra?: Record<string, string>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of STEP_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Default RunCommand on Bun.spawn (scrubbed, allowlisted env). */
export const runCommand: RunCommand = async (cmd, options) => {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: buildStepEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), options.timeoutMs ?? 300_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

function failIfNonZero(step: string, result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw new BuildStepError(
      step,
      `exit ${result.exitCode}\n--- stdout ---\n${result.stdout.slice(-4000)}\n--- stderr ---\n${result.stderr.slice(-8000)}`,
    );
  }
}

/** Reject path traversal / absolute paths in compiled file maps. */
export function assertSafeRelativePath(path: string): void {
  const normalized = normalize(path);
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    normalized.startsWith("..") ||
    normalized.split("/").includes("..")
  ) {
    throw new BuildStepError("write-files", `unsafe compiled file path: "${path}"`);
  }
}

export interface CreateBuildStepsOptions {
  runtime: Pick<RuntimeConfig, "npmCacheDir" | "worldDatabaseUrl">;
  run?: RunCommand;
  /** World provisioner (index.ts wires build/world.ts's ensure()). */
  provisionWorld: (contentHash: string, projectDir: string) => Promise<void>;
}

const MISE_NODE24 = ["mise", "exec", "node@24", "--"];

export function createBuildSteps(options: CreateBuildStepsOptions): BuildSteps {
  const run = options.run ?? runCommand;
  const { npmCacheDir } = options.runtime;

  return {
    async writeFiles(projectDir, files) {
      await rm(projectDir, { force: true, recursive: true });
      await mkdir(projectDir, { recursive: true });
      for (const [path, content] of files) {
        assertSafeRelativePath(path);
        const target = join(projectDir, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
    },

    async install(projectDir) {
      await mkdir(npmCacheDir, { recursive: true });
      const result = await run(
        // --ignore-scripts: third-party lifecycle scripts are arbitrary code
        // on the build host — the pinned dependency tree works without them
        // (spike/REPORT.md finding 19: cbor-x falls back to pure JS).
        [...MISE_NODE24, "npm", "install", "--no-audit", "--no-fund", "--ignore-scripts"],
        {
          cwd: projectDir,
          env: { npm_config_cache: npmCacheDir },
          timeoutMs: 300_000,
        },
      );
      failIfNonZero("npm-install", result);
    },

    async eveBuild(projectDir) {
      const result = await run(
        // --no-install: eve must come from the project's own pinned deps,
        // never fetched ad hoc from the registry.
        [...MISE_NODE24, "npx", "--no-install", "eve", "build"],
        {
          cwd: projectDir,
          // bun test leaks NODE_ENV=test which flips eve into mock-model mode
          // (REPORT finding 5) — pin production for build determinism.
          env: { NODE_ENV: "production" },
          timeoutMs: 300_000,
        },
      );
      failIfNonZero("eve-build", result);
      if (!existsSync(join(projectDir, ".output", "server", "index.mjs"))) {
        throw new BuildStepError(
          "eve-build",
          "eve build reported success but .output/server/index.mjs is missing",
        );
      }
    },

    provisionWorld: options.provisionWorld,

    async packageArtifact(projectDir, contentHash) {
      const manifest = {
        contentHash,
        builtAt: new Date().toISOString(),
        /** Canonical extraction path (REPORT finding 13 — not relocatable). */
        appRoot: projectDir,
        entry: ".output/server/index.mjs",
      };
      await writeFile(
        join(projectDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      const members = [".output", "manifest.json"];
      const scheduleManifest = join(".eve", "compile", "compiled-agent-manifest.json");
      if (existsSync(join(projectDir, scheduleManifest))) {
        members.push(scheduleManifest);
      }

      const tarball = join(projectDir, `artifact-${contentHash}.tar.gz`);
      const result = await run(
        ["tar", "-czf", tarball, "-C", projectDir, ...members],
        { cwd: projectDir, timeoutMs: 120_000 },
      );
      failIfNonZero("package-artifact", result);
      const bytes = await Bun.file(tarball).bytes();
      await rm(tarball, { force: true });
      return bytes;
    },
  };
}

/** Default world setupDatabase runner: the built project's own pinned bin. */
export function createSetupDatabaseRunner(run: RunCommand = runCommand) {
  return async (projectDir: string, worldUrl: string): Promise<void> => {
    const result = await run([...MISE_NODE24, "node", worldSetupBinPath(projectDir)], {
      cwd: projectDir,
      env: { WORKFLOW_POSTGRES_URL: worldUrl },
      timeoutMs: 120_000,
    });
    failIfNonZero("world-setup", result);
  };
}
