import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readWorkspaces } from "./workspaces";

const ROOT = join(import.meta.dir, "..", "..");

describe("readWorkspaces", () => {
  test("expands the root workspace globs", () => {
    const names = readWorkspaces(ROOT).map((w) => w.name).sort();
    expect(names).toContain("@invisible-string/web");
    expect(names).toContain("@invisible-string/e2e");
    expect(names).toContain("@invisible-string/integration-tests");
    expect(names.length).toBe(10);
  });

  test("reports which workspaces carry a version", () => {
    const byName = new Map(readWorkspaces(ROOT).map((w) => [w.name, w]));
    expect(byName.get("@invisible-string/web")?.version).toBeDefined();
    expect(byName.get("@invisible-string/e2e")?.version).toBeUndefined();
  });
});
