import { describe, expect, test } from "bun:test";
import type { ChangesetEntry } from "./changesets";
import { insertSection, renderSection } from "./changelog";

const entry = (
  bumps: ChangesetEntry["bumps"],
  summary: string,
  file = "x.md",
): ChangesetEntry => ({ file, bumps, summary });

describe("renderSection", () => {
  test("groups by section and labels the scope", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry({ "@invisible-string/web": "minor" }, "Replace the markdown renderer with Streamdown."),
      entry({ "@invisible-string/worker": "patch" }, "Normalize `WORKER_ID` to lowercase."),
    ]);
    expect(out).toBe(
      `## v0.3.0 — 2026-08-08

### Features
- **web** — Replace the markdown renderer with Streamdown.

### Fixes & maintenance
- **worker** — Normalize \`WORKER_ID\` to lowercase.
`,
    );
  });

  // While on 0.x a breaking change ships as a `minor` (semver §4), so the bump
  // type cannot select the section — the marker does.
  test("the **Breaking:** marker wins over the bump type, and is stripped", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry(
        { "@invisible-string/control-plane": "minor" },
        "**Breaking:** eve session API v2; republish to migrate.",
      ),
    ]);
    expect(out).toContain("### Breaking changes");
    expect(out).toContain("- **control-plane** — eve session API v2; republish to migrate.");
    expect(out).not.toContain("**Breaking:** eve");
    expect(out).not.toContain("### Features");
  });

  test("a major bump also lands under Breaking changes", () => {
    const out = renderSection("1.0.0", "2026-08-08", [
      entry({ "@invisible-string/shared": "major" }, "Declare 1.0."),
    ]);
    expect(out).toContain("### Breaking changes");
  });

  test("multiple packages join with a comma", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry(
        { "@invisible-string/control-plane": "minor", "@invisible-string/worker": "minor" },
        "Shared change.",
      ),
    ]);
    expect(out).toContain("- **control-plane, worker** — Shared change.");
  });

  test("empty sections are omitted", () => {
    const out = renderSection("0.3.0", "2026-08-08", [
      entry({ "@invisible-string/web": "patch" }, "A fix."),
    ]);
    expect(out).not.toContain("### Features");
    expect(out).not.toContain("### Breaking changes");
  });
});

describe("insertSection", () => {
  test("inserts above the first ## heading, below the preamble", () => {
    const existing = `# Changelog

Preamble prose.

## v0.2.0 — 2026-07-21

Old stuff.
`;
    const out = insertSection(existing, "## v0.3.0 — 2026-08-08\n\n### Features\n- **web** — New.\n");
    expect(out).toBe(
      `# Changelog

Preamble prose.

## v0.3.0 — 2026-08-08

### Features
- **web** — New.

## v0.2.0 — 2026-07-21

Old stuff.
`,
    );
  });

  test("appends when the file has no ## heading yet", () => {
    const out = insertSection("# Changelog\n\nPreamble.\n", "## v0.3.0 — 2026-08-08\n");
    expect(out).toBe("# Changelog\n\nPreamble.\n\n## v0.3.0 — 2026-08-08\n");
  });

  // Regression: `indexOf(...) + 1` returns 0 both for "no heading" and for
  // "heading at offset 0", which previously routed a preamble-less file to the
  // append-at-end branch. That silently inverts the file, and scripts/release/
  // decide.ts reads the FIRST `## ` as the newest release.
  test("inserts at the top when the file has no preamble", () => {
    const out = insertSection(
      "## v0.2.0 — 2026-07-21\n\nOld stuff.\n",
      "## v0.3.0 — 2026-08-08\n\n### Features\n- **web** — New.\n",
    );
    expect(out.indexOf("v0.3.0")).toBeLessThan(out.indexOf("v0.2.0"));
    expect(out.startsWith("## v0.3.0 — 2026-08-08\n")).toBe(true);
  });

  test("writes a clean file when the changelog does not exist yet", () => {
    const out = insertSection("", "## v0.3.0 — 2026-08-08\n");
    expect(out).toBe("## v0.3.0 — 2026-08-08\n");
  });
});
