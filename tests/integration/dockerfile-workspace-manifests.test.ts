/**
 * Dockerfile ↔ workspace-manifest drift guard.
 *
 * Every production Dockerfile runs `bun install --frozen-lockfile` against the
 * workspace manifests it COPYies in. The committed bun.lock encodes EVERY
 * workspace in the repo, so an image build that is missing even one
 * workspace's package.json fails with "lockfile had changes, but lockfile is
 * frozen" — even when the image never builds that workspace. This bit twice
 * in 2026-07 (packages/design-tokens, then apps/site): adding a workspace is
 * easy to forget in infra/docker/*. This test turns the rule into CI feedback
 * in the unit lane, instead of a failure in the much slower prod-compose lane.
 *
 * Pure filesystem parsing — no Docker, never gated.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Expand the root package.json workspaces globs (simple `<dir>/*` + literal forms). */
function workspaceDirs(): string[] {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      for (const entry of readdirSync(join(ROOT, base), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(ROOT, base, entry.name, "package.json"))) {
          dirs.push(`${base}/${entry.name}`);
        }
      }
    } else if (existsSync(join(ROOT, pattern, "package.json"))) {
      dirs.push(pattern);
    }
  }
  return dirs.sort();
}

const dockerfiles = readdirSync(join(ROOT, "infra", "docker")).filter((f) =>
  f.endsWith(".Dockerfile"),
);

describe("infra/docker Dockerfiles copy every workspace manifest before frozen install", () => {
  const expected = workspaceDirs();

  test("workspace enumeration is sane", () => {
    expect(expected.length).toBeGreaterThanOrEqual(4);
    expect(dockerfiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of dockerfiles) {
    test(file, () => {
      const content = readFileSync(join(ROOT, "infra", "docker", file), "utf8");
      // Only Dockerfiles that run a frozen workspace install need the full set.
      if (!content.includes("bun install --frozen-lockfile")) return;
      const copied = new Set(
        [...content.matchAll(/^COPY\s+(\S+)\/package\.json\s/gm)].map((m) => m[1]),
      );
      const missing = expected.filter((ws) => !copied.has(ws));
      expect(
        missing,
        `${file} is missing COPY lines for workspace manifest(s) [${missing.join(", ")}] — ` +
          `bun install --frozen-lockfile inside the image will fail ("lockfile had changes"). ` +
          `Add "COPY <ws>/package.json <ws>/" beside the other manifests.`,
      ).toEqual([]);
    });
  }
});
