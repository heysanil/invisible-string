/**
 * Golden-file snapshots: every fixture's FULL emitted project is committed
 * under packages/compiler/fixtures/<name>/ and byte-compared here. They are
 * the review surface for template changes — regenerate with
 *
 *   UPDATE_GOLDEN=1 bun test packages/compiler/src/golden.test.ts
 *
 * then inspect the diff and BUMP COMPILER_VERSION (src/version.ts).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { compile } from "./compile";
import { ALL_FIXTURES } from "./test-fixtures";
import { COMPILER_VERSION } from "./version";

const FIXTURES_DIR = resolve(import.meta.dir, "..", "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    out.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

describe("golden files", () => {
  for (const fixture of ALL_FIXTURES) {
    test(fixture.name, () => {
      const { files } = compile(fixture.definition, fixture.deps);
      const goldenDir = join(FIXTURES_DIR, fixture.name);

      if (UPDATE) {
        rmSync(goldenDir, { force: true, recursive: true });
        for (const [path, content] of files) {
          const target = join(goldenDir, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      }

      const goldenPaths = listFiles(goldenDir);
      expect(goldenPaths).toEqual([...files.keys()].sort());
      for (const path of goldenPaths) {
        const golden = readFileSync(join(goldenDir, path), "utf8");
        expect(files.get(path), `content mismatch: ${fixture.name}/${path}`).toBe(golden);
      }
    });
  }
});

// ── COMPILER_VERSION bump guard ─────────────────────────────────────────────
//
// The version-bump discipline is MECHANICAL, not prose: a digest over every
// fixture's emitted bytes is committed alongside the COMPILER_VERSION that
// produced it. Any template change (digest drift) without a version bump
// fails — including under UPDATE_GOLDEN=1, which refuses to rewrite the
// digest until version.ts is bumped in the same commit. Without this, an
// edited template would cache-hit stale artifacts in workflow_builds for
// identical workflow configs (the exact invisible staleness the hash exists
// to prevent).

const DIGEST_PATH = join(FIXTURES_DIR, ".golden-digest.json");

interface GoldenDigestRecord {
  compilerVersion: string;
  digest: string;
}

function computeEmittedDigest(): string {
  const hash = createHash("sha256");
  for (const fixture of ALL_FIXTURES) {
    const { files } = compile(fixture.definition, fixture.deps);
    for (const path of [...files.keys()].sort()) {
      hash.update(`${fixture.name}\0${path}\0`);
      hash.update(files.get(path)!);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

describe("COMPILER_VERSION bump guard", () => {
  test("emitted-template digest is pinned to the current COMPILER_VERSION", () => {
    const digest = computeEmittedDigest();

    if (UPDATE) {
      if (existsSync(DIGEST_PATH)) {
        const previous = JSON.parse(
          readFileSync(DIGEST_PATH, "utf8"),
        ) as GoldenDigestRecord;
        if (previous.digest !== digest && previous.compilerVersion === COMPILER_VERSION) {
          throw new Error(
            "emitted templates changed but COMPILER_VERSION was not bumped — " +
              "bump packages/compiler/src/version.ts (see its bump policy), then rerun UPDATE_GOLDEN=1",
          );
        }
      }
      writeFileSync(
        DIGEST_PATH,
        `${JSON.stringify({ compilerVersion: COMPILER_VERSION, digest } satisfies GoldenDigestRecord, null, 2)}\n`,
      );
    }

    expect(
      existsSync(DIGEST_PATH),
      "fixtures/.golden-digest.json is missing — run UPDATE_GOLDEN=1 bun test src/golden.test.ts",
    ).toBeTrue();
    const recorded = JSON.parse(readFileSync(DIGEST_PATH, "utf8")) as GoldenDigestRecord;
    expect(
      recorded.digest,
      "emitted templates changed — bump COMPILER_VERSION and regenerate goldens with UPDATE_GOLDEN=1",
    ).toBe(digest);
    expect(
      recorded.compilerVersion,
      "COMPILER_VERSION changed without regenerating fixtures/.golden-digest.json — rerun UPDATE_GOLDEN=1",
    ).toBe(COMPILER_VERSION);
  });
});
