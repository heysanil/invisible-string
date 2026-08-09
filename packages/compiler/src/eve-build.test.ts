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
 * And two run the WIRE PROBE (`wire-probe.mjs`): the emitted agent module is
 * imported for real, its model is pointed at a stub gateway through the
 * generated OPENROUTER_BASE_URL branch, and the captured request BODY is
 * asserted — the only check that proves the reasoning effort actually reaches
 * OpenRouter rather than being read out of the provider's source.
 *
 *   SPIKE_EVE_BUILD=1 bun test packages/compiler/src/eve-build.test.ts
 *
 * Requires: `mise install` (or SPIKE_NODE24_BIN) + network for npm.
 * No provider keys required — keyless builds are part of the contract
 * (spike/REPORT.md friction 4).
 */
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compile } from "./compile";
import {
  ALL_FIXTURES,
  basicFixture,
  customApprovalFixture,
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
  throw new Error("Node 24 not found. Run `mise install` or set SPIKE_NODE24_BIN.");
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
      // eve 0.31 RELOCATED the compiled-agent manifest into the build output:
      // it is `.output/.eve/compile/compiled-agent-manifest.json` now, and the
      // legacy project-root `.eve/compile/…` path is simply absent (no
      // fallback copy). `<project>/.eve/` still exists on 0.31 but holds
      // agent-summary.json / builds/ / locks/ / sandbox-cache/ instead, so
      // probing the directory is not enough — assert BOTH directions or a
      // future relocation slips through silently.
      expect(
        existsSync(
          join(projectDir, ".output", ".eve", "compile", "compiled-agent-manifest.json"),
        ),
      ).toBe(true);
      expect(
        existsSync(join(projectDir, ".eve", "compile", "compiled-agent-manifest.json")),
      ).toBe(false);
    },
    1_200_000,
  );

  /**
   * Run `wire-probe.mjs` inside a rendered project and return the request
   * bodies its stub gateway captured. No `eve build` needed: the probe
   * imports the emitted `agent/agent.ts` directly (Node 24 strips the types)
   * and calls the model that `defineAgent` was handed, which is precisely the
   * object the built artifact carries.
   */
  async function captureWireBodies(
    fixture: CompilerFixture,
  ): Promise<Record<string, unknown>[]> {
    const projectDir = await ensureInstalled(fixture);
    copyFileSync(
      join(import.meta.dir, "wire-probe.mjs"),
      join(projectDir, "wire-probe.mjs"),
    );
    const probe = await run([node24Bin(), "wire-probe.mjs"], projectDir, env, 120_000);
    expect(
      probe.exitCode,
      `wire probe failed for ${fixture.name}:\n${probe.output.slice(-4000)}`,
    ).toBe(0);
    const marker = probe.output
      .split("\n")
      .find((line) => line.startsWith("__WIRE_PROBE__"));
    expect(marker, `no probe output:\n${probe.output.slice(-4000)}`).toBeDefined();
    const captured = JSON.parse(marker!.slice("__WIRE_PROBE__".length)) as {
      path: string;
      body: string;
    }[];
    expect(captured.length).toBe(2);
    for (const request of captured) expect(request.path).toBe("/api/v1/chat/completions");
    return captured.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }

  // THE proof the whole reasoning change rests on: an effort emitted as
  // `extraBody` lands in the request body verbatim. Everything else about the
  // effort (schema, resolution, hashing, UI) is worthless if this line is
  // wrong, and it cannot be proven by reading the generated source — that is
  // exactly how the pre-4.0.0 no-op survived review.
  test(
    "basic fixture: the resolved effort reaches the OpenRouter request body",
    async () => {
      const [plain, withCallOption] = await captureWireBodies(basicFixture);
      expect(plain).toMatchObject({
        model: "deepseek/deepseek-v4-pro",
        reasoning: { effort: "max" },
      });
      // Nothing but `effort` inside it — a stray key would be sent to the
      // provider on every turn of every agent.
      expect(Object.keys(plain!.reasoning as object)).toEqual(["effort"]);
      // Passing `reasoning` the way eve's tool loop does changes NOTHING:
      // @openrouter/ai-sdk-provider@3.0.0's getArgs() never destructures the
      // call option (spike finding 29). This is the empirical half of that
      // finding, and it is why the effort has to ride extraBody.
      expect(withCallOption).toEqual(plain!);
    },
    1_200_000,
  );

  // The suppression branch: `provider-default` must send NO reasoning key at
  // all — distinct from `"none"`, and the escape hatch for models with no
  // reasoning support.
  test(
    "custom-approval fixture: provider-default sends no reasoning key",
    async () => {
      const bodies = await captureWireBodies(customApprovalFixture);
      for (const body of bodies) {
        expect(body).toMatchObject({ model: "deepseek/deepseek-v4-pro" });
        expect("reasoning" in body).toBe(false);
      }
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
