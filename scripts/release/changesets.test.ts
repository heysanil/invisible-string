import { describe, expect, test } from "bun:test";
import { parseChangeset, validateChangesets } from "./changesets";
import type { Workspace } from "./workspaces";

const WORKSPACES: Workspace[] = [
  { name: "@invisible-string/web", dir: "apps/web", version: "0.2.0" },
  { name: "@invisible-string/shared", dir: "packages/shared", version: "0.2.0" },
  { name: "@invisible-string/e2e", dir: "e2e" },
];

describe("parseChangeset", () => {
  test("reads bumps and summary", () => {
    const entry = parseChangeset(
      "brave-pandas-smile.md",
      `---
"@invisible-string/web": minor
"@invisible-string/shared": patch
---

Replace the markdown renderer with Streamdown.
`,
    );
    expect(entry.file).toBe("brave-pandas-smile.md");
    expect(entry.bumps).toEqual({
      "@invisible-string/web": "minor",
      "@invisible-string/shared": "patch",
    });
    expect(entry.summary).toBe("Replace the markdown renderer with Streamdown.");
  });

  test("joins a multi-line summary into one line", () => {
    const entry = parseChangeset(
      "x.md",
      `---
"@invisible-string/web": patch
---

First line
second line.
`,
    );
    expect(entry.summary).toBe("First line second line.");
  });

  test("accepts unquoted package keys", () => {
    const entry = parseChangeset("x.md", `---\n@invisible-string/web: minor\n---\n\nHi.\n`);
    expect(entry.bumps).toEqual({ "@invisible-string/web": "minor" });
  });

  test("rejects a file with no frontmatter", () => {
    expect(() => parseChangeset("bad.md", "just prose\n")).toThrow(/frontmatter/);
  });

  test("rejects an unknown bump type", () => {
    expect(() =>
      parseChangeset("bad.md", `---\n"@invisible-string/web": huge\n---\n\nHi.\n`),
    ).toThrow(/huge/);
  });
});

describe("validateChangesets", () => {
  test("accepts a changeset naming only versioned workspaces", () => {
    const entry = parseChangeset("ok.md", `---\n"@invisible-string/web": minor\n---\n\nHi.\n`);
    expect(validateChangesets([entry], WORKSPACES)).toEqual([]);
  });

  // Naming a versionless workspace produces a SILENT ZOMBIE under changesets:
  // exit 0, file never consumed, nothing bumped, forever. See spec §3 finding 7.
  test("rejects a changeset naming a versionless workspace", () => {
    const entry = parseChangeset("bad.md", `---\n"@invisible-string/e2e": patch\n---\n\nHi.\n`);
    const errors = validateChangesets([entry], WORKSPACES);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad.md");
    expect(errors[0]).toContain("@invisible-string/e2e");
  });

  test("rejects a changeset naming a package that is not a workspace", () => {
    const entry = parseChangeset("typo.md", `---\n"@invisible-string/webb": minor\n---\n\nHi.\n`);
    const errors = validateChangesets([entry], WORKSPACES);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("typo.md");
    expect(errors[0]).toContain("@invisible-string/webb");
  });

  test("reports every offending entry, not just the first", () => {
    const a = parseChangeset("a.md", `---\n"@invisible-string/e2e": patch\n---\n\nHi.\n`);
    const b = parseChangeset("b.md", `---\n"@invisible-string/nope": patch\n---\n\nHi.\n`);
    expect(validateChangesets([a, b], WORKSPACES)).toHaveLength(2);
  });
});
