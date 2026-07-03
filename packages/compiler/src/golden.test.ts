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
