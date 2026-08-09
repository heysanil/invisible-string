import { describe, expect, test } from "bun:test";
import { decide, extractLatestSection } from "./decide";

describe("decide", () => {
  test("no tag yet → tag and release", () => {
    expect(decide("0.3.0", { kind: "absent" })).toEqual({ action: "tag-and-release" });
  });

  test("tag at HEAD with a matching version → ensure the release exists", () => {
    expect(
      decide("0.3.0", { kind: "present", versionAtTag: "0.3.0", pointsAtHead: true }),
    ).toEqual({ action: "ensure-release" });
  });

  test("tag on an older commit with a matching version → no-op", () => {
    const decision = decide("0.3.0", {
      kind: "present",
      versionAtTag: "0.3.0",
      pointsAtHead: false,
    });
    expect(decision.action).toBe("noop");
  });

  // The transition window: every existing tag (v0.1.3..v0.2.0) predates the
  // `version` field, so `git show <tag>:packages/shared/package.json` succeeds
  // but has no version key. Seeded at 0.2.0, EVERY push to main hits this
  // until the first Version PR merges. Without this branch it exits 1.
  test("tag predating version fields → no-op, never an error", () => {
    const decision = decide("0.2.0", {
      kind: "present",
      versionAtTag: undefined,
      pointsAtHead: false,
    });
    expect(decision.action).toBe("noop");
    expect(decision).toMatchObject({ reason: expect.stringContaining("predates") });
  });

  test("tag marking a different version → hard fail", () => {
    const decision = decide("0.3.1", {
      kind: "present",
      versionAtTag: "0.3.0",
      pointsAtHead: false,
    });
    expect(decision.action).toBe("fail");
    expect(decision).toMatchObject({ message: expect.stringContaining("0.3.1") });
  });
});

describe("extractLatestSection", () => {
  const changelog = `# Changelog

Preamble.

## v0.3.0 — 2026-08-08

### Features
- **web** — New.

## v0.2.0 — 2026-07-21

Older.
`;

  test("returns the first ## section only", () => {
    const section = extractLatestSection(changelog);
    expect(section?.heading).toBe("v0.3.0 — 2026-08-08");
    expect(section?.body).toBe("### Features\n- **web** — New.");
  });

  test("returns undefined when there is no ## heading", () => {
    expect(extractLatestSection("# Changelog\n\nPreamble.\n")).toBeUndefined();
  });

  test("handles a single section running to EOF", () => {
    const section = extractLatestSection("# C\n\n## v0.3.0 — 2026-08-08\n\nOnly.\n");
    expect(section?.heading).toBe("v0.3.0 — 2026-08-08");
    expect(section?.body).toBe("Only.");
  });
});
