/**
 * Single source of truth for the spike agent project's dependency pins.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * AGENTS.md names the spike suites as the upgrade gate for eve version bumps.
 * That gate was silently broken: `spike/agent-project/package.json` and its
 * committed `package-lock.json` hardcoded the eve 0.19 matrix and never read
 * `packages/compiler/versions.json`, so the suites happily ran GREEN against
 * eve 0.19.0 while versions.json advertised 0.31.3 — gating nothing.
 *
 * npm needs a literal, committed `package.json` + `package-lock.json` pair
 * (`npm ci` refuses anything else), so the spike cannot import its pins at
 * install time. Instead the duplication is made *derived and enforced*:
 *
 *   - `sync-pins.ts` REWRITES spike/agent-project/package.json from
 *     versions.json (repinning is a regeneration, never retyping).
 *   - `pins.test.ts` FAILS — ungated, in the default `bun test` lane — the
 *     moment package.json or package-lock.json drifts from versions.json.
 *
 * Adding a runtime dependency to the spike agent means adding it to
 * versions.json first and then to SPIKE_PIN_MAP below.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SPIKE_TESTS_DIR = resolve(import.meta.dir);
export const SPIKE_ROOT = resolve(SPIKE_TESTS_DIR, "..");
export const REPO_ROOT_DIR = resolve(SPIKE_ROOT, "..");
export const AGENT_PROJECT_PACKAGE_JSON = join(
  SPIKE_ROOT,
  "agent-project",
  "package.json",
);
export const AGENT_PROJECT_PACKAGE_LOCK = join(
  SPIKE_ROOT,
  "agent-project",
  "package-lock.json",
);
export const VERSIONS_JSON = join(
  REPO_ROOT_DIR,
  "packages",
  "compiler",
  "versions.json",
);

/** versions.json key -> npm package name, split by dependency kind. */
export const SPIKE_PIN_MAP = {
  dependencies: {
    "@ai-sdk/anthropic": "anthropicProvider",
    "@openrouter/ai-sdk-provider": "openrouterProvider",
    "@workflow/world-postgres": "worldPostgres",
    ai: "ai",
    eve: "eve",
    zod: "zod",
  },
  devDependencies: {
    "@types/node": "typesNode",
    typescript: "typescript",
  },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

export interface VersionsMatrix {
  readonly [key: string]: unknown;
  readonly node: string;
}

export function readVersionsMatrix(): VersionsMatrix {
  return JSON.parse(readFileSync(VERSIONS_JSON, "utf8")) as VersionsMatrix;
}

function pinsFor(
  matrix: VersionsMatrix,
  group: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pkg, key] of Object.entries(group)) {
    const version = matrix[key];
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(
        `packages/compiler/versions.json is missing a string "${key}" (needed to pin ${pkg} in the spike agent project)`,
      );
    }
    out[pkg] = version;
  }
  return out;
}

/**
 * The exact `dependencies` / `devDependencies` / `engines.node` the spike
 * agent project must declare, derived from versions.json. Exact pins only —
 * never a range (AGENTS.md: "Version pins are exact ... Never `@latest` in
 * generated projects").
 */
export function expectedSpikePins(matrix: VersionsMatrix = readVersionsMatrix()): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  enginesNode: string;
} {
  const nodeMajor = matrix.node.split(".")[0];
  if (nodeMajor === undefined || !/^\d+$/.test(nodeMajor)) {
    throw new Error(
      `packages/compiler/versions.json "node" is not a version string: ${String(matrix.node)}`,
    );
  }
  return {
    dependencies: pinsFor(matrix, SPIKE_PIN_MAP.dependencies),
    devDependencies: pinsFor(matrix, SPIKE_PIN_MAP.devDependencies),
    enginesNode: `${nodeMajor}.x`,
  };
}
