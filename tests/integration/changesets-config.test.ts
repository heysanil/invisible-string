/**
 * Changesets config drift guard.
 *
 * The release flow versions eight workspaces in lockstep and EXCLUDES the two
 * test harnesses. The exclusion is not a config toggle — it is the absence of a
 * `version` field, paired with negation globs in `fixed`. Both halves must stay
 * in sync: a versionless workspace that the positive glob still matches makes
 * `changeset version` die with `TypeError: Invalid version. Must be a string.`
 * — on main, in the release job, hours after the offending workspace merged.
 *
 * DELIBERATELY UNGATED, like tests/integration/toolchain-pins.test.ts: pure
 * filesystem parsing, so drift surfaces in the default `bun test` lane.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: string[];
  devDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;
}

/** Every workspace directory, expanded from the root `workspaces` globs. */
function workspaceDirs(): string[] {
  const patterns = readManifest(".").workspaces ?? [];
  return patterns
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) return [pattern];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(ROOT, parent), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${parent}/${e.name}`);
    })
    .sort();
}

const SHIPPED = [
  "apps/control-plane",
  "apps/site",
  "apps/web",
  "apps/worker",
  "packages/compiler",
  "packages/db",
  "packages/design-tokens",
  "packages/shared",
];

const config = JSON.parse(
  readFileSync(join(ROOT, ".changeset", "config.json"), "utf8"),
) as {
  changelog: unknown;
  fixed: string[][];
  baseBranch: string;
  privatePackages: { version: boolean; tag: boolean };
};

describe("changesets config", () => {
  test("every shipped workspace carries the same version", () => {
    const versions = SHIPPED.map((dir) => {
      const version = readManifest(dir).version;
      expect(version, `${dir} has no version field`).toMatch(EXACT_SEMVER);
      return version;
    });
    expect(new Set(versions).size, `versions diverged: ${versions.join(", ")}`).toBe(1);
  });

  // THE check. A narrower "tests/integration and e2e have no version" would
  // miss a FUTURE versionless workspace whose name still matches the positive
  // glob — e.g. tests/load → @invisible-string/load-tests, which lands inside
  // `@invisible-string/*` with no negation covering it.
  test("versionless workspaces are exactly the ones fixed[] negates", () => {
    const versionless = workspaceDirs()
      .map((dir) => readManifest(dir))
      .filter((m) => m.version === undefined)
      .map((m) => m.name)
      .sort();

    const negated = config.fixed[0]!
      .filter((p) => p.startsWith("!"))
      .map((p) => p.slice(1))
      .sort();

    expect(versionless).toEqual(negated);
  });

  test("fixed globs match the approved literal", () => {
    expect(config.fixed).toEqual([
      [
        "@invisible-string/*",
        "!@invisible-string/e2e",
        "!@invisible-string/integration-tests",
      ],
    ]);
  });

  test("load-bearing config values", () => {
    // privatePackages.version:false versions nothing (all workspaces are
    // private); tag:true mints eight per-package tags per release;
    // changelog:!false writes eight near-empty per-package CHANGELOG.md files.
    expect(config.privatePackages).toEqual({ version: true, tag: false });
    expect(config.changelog).toBe(false);
    expect(config.baseBranch).toBe("main");
  });

  test("@changesets/cli is pinned exactly", () => {
    const pin = readManifest(".").devDependencies?.["@changesets/cli"];
    expect(pin, "@changesets/cli missing from root devDependencies").toBeDefined();
    expect(pin).toMatch(EXACT_SEMVER);
  });
});
