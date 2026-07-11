/**
 * Gated slow test (SPIKE_EVE_BUILD=1): proves the emitted templates COMPILE.
 *
 * EVERY fixture (basic persona-only, MCP+packaged-skill, custom approval
 * policy, anthropic model) is rendered to a temp dir, npm-installed with
 * Node 24 (mise) against a shared npm cache, and strict-typechecked with
 * `tsc --noEmit` against the real eve types. Two fixtures additionally run
 * the full `eve build` to a servable `.output` bundle:
 * - basic — the ONLY-default-eve-channel project (the agents-first
 *   artifact shape: no custom channels at all — the critical de-risk);
 * - mcp-skill — connection + packaged skill (SKILL.md + references/ file),
 *   the control-plane skill-attachment path in fixture form.
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
import {
  ALL_FIXTURES,
  basicFixture,
  mcpSkillFixture,
  type CompilerFixture,
} from "./test-fixtures";

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

function renderFixtureTo(dir: string, fixture: CompilerFixture): void {
  const { files } = compile(fixture.definition, fixture.deps);
  for (const [path, content] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

if (!GATE) console.log(`[eve-build] skipped: ${SKIP_REASON}`);

describe.skipIf(!GATE)("eve build (gated)", () => {
  const root = GATE ? mkdtempSync(join(tmpdir(), "is-compiler-build-")) : "";
  const nodeBinDir = GATE ? resolve(node24Bin(), "..") : "";
  const env = {
    PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`,
    // Shared npm cache: the first install is cold; the rest are warm.
    npm_config_cache: process.env.NPM_CACHE_DIR ?? undefined,
    // bun test exports NODE_ENV=test, which flips eve into mock-model
    // mode if it leaks into spawned processes (spike/REPORT.md 5).
    NODE_ENV: "production",
    // Prove the keyless path: no provider key may be required to build.
    OPENROUTER_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  };

  async function ensureInstalled(fixture: CompilerFixture): Promise<string> {
    const projectDir = join(root, fixture.name);
    if (!existsSync(join(projectDir, "package.json"))) {
      mkdirSync(projectDir, { recursive: true });
      renderFixtureTo(projectDir, fixture);
    }
    if (!existsSync(join(projectDir, "node_modules"))) {
      const install = await run(
        ["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts"],
        projectDir,
        env,
        420_000,
      );
      expect(install.exitCode, `npm install failed:\n${install.output.slice(-4000)}`).toBe(0);
    }
    return projectDir;
  }

  // ALL templates (incl. the custom-approval policy and the anthropic
  // provider branch) must typecheck strictly against the real eve@pinned
  // types.
  for (const fixture of ALL_FIXTURES) {
    test(
      `${fixture.name}: rendered project installs and typechecks strictly`,
      async () => {
        const projectDir = await ensureInstalled(fixture);
        const typecheck = await run(
          [join(projectDir, "node_modules", ".bin", "tsc"), "--noEmit"],
          projectDir,
          env,
          180_000,
        );
        expect(
          typecheck.exitCode,
          `tsc --noEmit failed for ${fixture.name}:\n${typecheck.output.slice(-4000)}`,
        ).toBe(0);
      },
      1_200_000,
    );
  }

  // The agents-first artifact shape: agent/channels/eve.ts is the ONLY
  // channel. Proving this project eve-builds keyless is the critical
  // de-risk for the trigger-agnostic compile unit.
  test(
    "basic fixture (default-eve-channel-only) eve-builds keyless to a servable .output bundle",
    async () => {
      const projectDir = await ensureInstalled(basicFixture);
      const build = await run(
        [node24Bin(), join(projectDir, "node_modules", "eve", "bin", "eve.js"), "build"],
        projectDir,
        env,
        420_000,
      );
      expect(build.exitCode, `eve build failed:\n${build.output.slice(-4000)}`).toBe(0);
      expect(existsSync(join(projectDir, ".output", "server", "index.mjs"))).toBe(true);
      expect(
        existsSync(join(projectDir, ".eve", "compile", "compiled-agent-manifest.json")),
      ).toBe(true);
    },
    1_200_000,
  );

  // Proves the control-plane skill-attachment path end product: an agent
  // whose skill carries a `references/` file compiles to a PACKAGED skill
  // directory and eve-builds keyless alongside its MCP connection.
  test(
    "mcp-skill fixture packages the attachment and eve-builds keyless",
    async () => {
      const projectDir = await ensureInstalled(mcpSkillFixture);

      // The compiler emitted a packaged skill (SKILL.md + the reference file).
      expect(
        existsSync(join(projectDir, "agent", "skills", "release-notes", "SKILL.md")),
      ).toBe(true);
      expect(
        existsSync(
          join(projectDir, "agent", "skills", "release-notes", "references", "rota.md"),
        ),
      ).toBe(true);

      const build = await run(
        [node24Bin(), join(projectDir, "node_modules", "eve", "bin", "eve.js"), "build"],
        projectDir,
        env,
        420_000,
      );
      expect(build.exitCode, `eve build failed:\n${build.output.slice(-4000)}`).toBe(0);
      expect(existsSync(join(projectDir, ".output", "server", "index.mjs"))).toBe(true);
    },
    1_200_000,
  );
});
