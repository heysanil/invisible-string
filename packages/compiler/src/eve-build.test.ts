/**
 * Gated slow test (SPIKE_EVE_BUILD=1): proves the emitted templates COMPILE —
 * the form fixture is rendered to a temp dir, dependencies are installed with
 * Node 24 (mise), `tsc --noEmit` passes strict typechecking against the real
 * eve types, and `eve build` produces a servable .output bundle.
 *
 *   SPIKE_EVE_BUILD=1 bun test packages/compiler/src/eve-build.test.ts
 *
 * Requires: `mise install node@24` (or SPIKE_NODE24_BIN) + network for npm.
 * No provider keys required — keyless builds are part of the contract
 * (spike/REPORT.md friction 4).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compile } from "./compile";
import { formMcpSkillFixture } from "./test-fixtures";

const GATE = process.env.SPIKE_EVE_BUILD === "1";
const SKIP_REASON = "requires SPIKE_EVE_BUILD=1 (slow: npm install + eve build)";

function node24Bin(): string {
  const override = process.env.SPIKE_NODE24_BIN;
  if (override !== undefined && override.length > 0) return override;
  const installs = `${process.env.HOME}/.local/share/mise/installs/node`;
  if (existsSync(installs)) {
    const v24 = readdirSync(installs)
      .filter((dir) => dir.startsWith("24."))
      .sort()
      .at(-1);
    if (v24 !== undefined) return join(installs, v24, "bin", "node");
  }
  throw new Error("Node 24 not found. Run `mise install node@24` or set SPIKE_NODE24_BIN.");
}

async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  const proc = Bun.spawn(cmd, {
    cwd,
    env: merged,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

if (!GATE) console.log(`[eve-build] skipped: ${SKIP_REASON}`);

describe.skipIf(!GATE)("eve build (gated)", () => {
  test(
    "rendered form fixture installs, typechecks strictly, and eve-builds keyless",
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "is-compiler-build-"));
      const { files } = compile(formMcpSkillFixture.definition, formMcpSkillFixture.deps);
      for (const [path, content] of files) {
        const target = join(projectDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }

      const nodeBinDir = resolve(node24Bin(), "..");
      const env = {
        PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`,
        // bun test exports NODE_ENV=test, which flips eve into mock-model
        // mode if it leaks into spawned processes (spike/REPORT.md 5).
        NODE_ENV: "production",
        // Prove the keyless path: no provider key may be required to build.
        OPENROUTER_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      };

      const install = await run(
        ["npm", "install", "--no-audit", "--no-fund"],
        projectDir,
        env,
        420_000,
      );
      expect(install.exitCode, `npm install failed:\n${install.output.slice(-4000)}`).toBe(0);

      const typecheck = await run(
        [join(projectDir, "node_modules", ".bin", "tsc"), "--noEmit"],
        projectDir,
        env,
        180_000,
      );
      expect(typecheck.exitCode, `tsc --noEmit failed:\n${typecheck.output.slice(-4000)}`).toBe(0);

      const build = await run(
        [node24Bin(), join(projectDir, "node_modules", "eve", "bin", "eve.js"), "build"],
        projectDir,
        env,
        420_000,
      );
      expect(build.exitCode, `eve build failed:\n${build.output.slice(-4000)}`).toBe(0);
      expect(existsSync(join(projectDir, ".output", "server", "index.mjs"))).toBe(true);

      // The compiled manifest must register the form trigger channel route.
      const manifestPath = join(projectDir, ".eve", "compile", "compiled-agent-manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = await Bun.file(manifestPath).text();
      expect(manifest).toContain("/eve/v1/platform/form");
    },
    1_200_000,
  );
});
