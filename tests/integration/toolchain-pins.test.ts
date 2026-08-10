/**
 * Toolchain-pin drift guard: mise.toml ↔ versions.json ↔ Dockerfiles ↔ CI.
 *
 * `mise.toml` is the single source of truth for the HOST tools every lane runs
 * on, but three things can silently diverge from it:
 *
 *  1. `packages/compiler/versions.json` owns the node the compiled agents need
 *     (eve's engines check refuses < 24). If mise.toml pins a different node,
 *     CI proves a runtime nobody ships — the exact failure mode
 *     spike/tests/pins.test.ts exists to prevent for the eve matrix.
 *  2. The prod images carry NO mise — they bake an `oven/bun` base and COPY a
 *     bare node out of `node:<version>-bookworm-slim` — so a bump in mise.toml
 *     or versions.json leaves them a lane behind. The node pin is the sharper
 *     of the two: production `eve build` runs under the IMAGE's node, the
 *     content hash does not encode a node version, and host lanes always build
 *     under the mise pin — so an image on a different patch is invisible drift
 *     between what CI proves and what production ships. (Aligning them is not
 *     a BUILD_ENV_EPOCH event: the epoch re-keys every version to abandon
 *     functionally poisoned artifacts, and matching an already-dominant node
 *     patch does not poison anything.)
 *  3. A new workflow (or a new job in an existing one) can reach for
 *     `oven-sh/setup-bun` / `actions/setup-node` out of habit, quietly
 *     reintroducing an unpinned second toolchain next to mise's.
 *
 * DELIBERATELY UNGATED, in the style of tests/integration/dockerfile-workspace
 * -manifests.test.ts: pure filesystem parsing — no DB, no docker, no network —
 * so the drift is caught in the default `bun test` lane, seconds after the
 * edit, instead of hours later in an acceptance lane.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/** Setup actions that mise.toml replaces — a second, unpinned toolchain. */
const BANNED_SETUP_ACTIONS = ["oven-sh/setup-bun", "actions/setup-node"];

/** Commands whose presence in a `run:` step means the job needs mise's tools. */
const TOOLCHAIN_BINARIES = ["bun", "bunx", "node", "npm", "npx", "wrangler"];

interface MiseConfig {
  tools: Record<string, string>;
}

interface WorkflowStep {
  uses?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob | undefined>;
}

const mise = Bun.TOML.parse(readFileSync(join(ROOT, "mise.toml"), "utf8")) as MiseConfig;

const versions = JSON.parse(
  readFileSync(join(ROOT, "packages", "compiler", "versions.json"), "utf8"),
) as Record<string, string>;

/** Every workflow file, parsed. */
function workflows(): { file: string; doc: Workflow }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((file) => ({
      file,
      doc: Bun.YAML.parse(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow,
    }));
}

/** Every capture-group-1 match of `pattern` across the prod Dockerfiles. */
function dockerfilePins(pattern: RegExp): { file: string; tag: string }[] {
  const dir = join(ROOT, "infra", "docker");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".Dockerfile"))
    .sort()
    .flatMap((file) =>
      [...readFileSync(join(dir, file), "utf8").matchAll(pattern)].map((m) => ({
        file,
        tag: m[1] ?? "",
      })),
    );
}

/** True when a `run:` script invokes one of the mise-managed binaries. */
function usesToolchain(script: string): boolean {
  // Command position only: start of a line, or after a shell operator. Keeps
  // an incidental mention inside a heredoc or a path from tripping the guard.
  const pattern = new RegExp(
    String.raw`(?:^|[\n;&|]\s*|\|\s*)(?:${TOOLCHAIN_BINARIES.join("|")})\b`,
  );
  return pattern.test(script);
}

describe("mise.toml is the single source of truth for host tools", () => {
  test("every pin is an EXACT version, never a range", () => {
    // AGENTS.md: "Version pins are exact". A floating pin makes CI
    // irreproducible and defeats mise-action's config-hash cache key.
    for (const [tool, version] of Object.entries(mise.tools)) {
      expect({ tool, exact: EXACT_SEMVER.test(version) }).toEqual({ tool, exact: true });
    }
  });

  test("node matches packages/compiler/versions.json", () => {
    // versions.json is the ONLY source for the runtime matrix; mise.toml's
    // node is DERIVED from it. Bump both in the same commit.
    expect({ source: "mise.toml", node: mise.tools.node }).toEqual({
      source: "mise.toml",
      node: versions.node,
    });
  });

  test("the prod images' node matches packages/compiler/versions.json exactly", () => {
    // The images COPY a bare node out of `node:<version>-bookworm-slim` and
    // carry no mise, so this is the ONE node version mise.toml cannot pin.
    // It must still be the matrix's node: production `eve build` runs under
    // it, and the content hash does NOT encode the node version — so an image
    // on a different patch than every host lane is invisible drift.
    const expected = versions.node ?? "";
    expect(expected).toMatch(EXACT_SEMVER); // versions.json really has a node pin
    const pins = dockerfilePins(/^COPY --from=node:(\S+?)-bookworm-slim/gm);
    expect(pins.length).toBeGreaterThan(0);
    for (const { file, tag } of pins) {
      expect({ file, tag }).toEqual({ file, tag: expected });
    }
  });

  test("bun major.minor matches the prod images' oven/bun tag", () => {
    // The images bake `oven/bun:<major.minor>` and carry no mise, so the two
    // toolchains only stay aligned if the minor line matches.
    const bun = mise.tools.bun ?? "";
    const line = bun.split(".").slice(0, 2).join(".");
    const pins = dockerfilePins(/^FROM\s+oven\/bun:(\S+)/gm);

    expect(pins.length).toBeGreaterThan(0);
    for (const { file, tag } of pins) {
      expect({ file, tag }).toEqual({ file, tag: line });
    }
  });
});

describe("CI installs the toolchain through mise, and only through mise", () => {
  test("no workflow uses a per-tool setup action", () => {
    const offenders: string[] = [];
    for (const { file, doc } of workflows()) {
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          const action = step.uses?.split("@")[0];
          if (action !== undefined && BANNED_SETUP_ACTIONS.includes(action)) {
            offenders.push(`${file} → ${jobName} → ${step.uses}`);
          }
        }
      }
    }
    expect({
      reason: "install host tools via mise.toml + jdx/mise-action@v4 instead",
      offenders,
    }).toEqual({
      reason: "install host tools via mise.toml + jdx/mise-action@v4 instead",
      offenders: [],
    });
  });

  test("every job that runs bun/node/npm/wrangler sets mise up first", () => {
    const missing: string[] = [];
    for (const { file, doc } of workflows()) {
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        const steps = job?.steps ?? [];
        const needsTools = steps.some((s) => s.run !== undefined && usesToolchain(s.run));
        const hasMise = steps.some((s) => s.uses?.startsWith("jdx/mise-action") === true);
        if (needsTools && !hasMise) missing.push(`${file} → ${jobName}`);
      }
    }
    expect({
      reason: "add `- uses: jdx/mise-action@v4` to the job",
      missing,
    }).toEqual({ reason: "add `- uses: jdx/mise-action@v4` to the job", missing: [] });
  });

  test("mise-action reads mise.toml — no inline tool versions in workflows", () => {
    // `install_args: node@24` and friends are FUZZY: they resolve to the
    // newest matching release, which may not be the version mise.toml pins,
    // and would then win the "newest installed 24.x" race in
    // resolveNodeBinDir()/resolveNodeBin().
    const offenders: string[] = [];
    for (const { file } of workflows()) {
      const body = readFileSync(join(WORKFLOW_DIR, file), "utf8");
      for (const key of ["install_args:", "tool_versions:", "mise_toml:"]) {
        if (body.includes(key)) offenders.push(`${file} → ${key}`);
      }
    }
    expect({ reason: "let mise-action read the repo-root mise.toml", offenders }).toEqual({
      reason: "let mise-action read the repo-root mise.toml",
      offenders: [],
    });
  });
});
