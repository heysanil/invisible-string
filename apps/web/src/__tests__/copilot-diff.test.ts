/** Line-diff renderer correctness (LCS) + context collapsing. */
import { describe, expect, test } from "bun:test";

import { collapseContext, diffLines } from "../lib/copilot/diff";

describe("diffLines", () => {
  test("identical inputs are all 'same'", () => {
    const rows = diffLines("a\nb", "a\nb");
    expect(rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  test("pure addition and pure removal", () => {
    expect(diffLines("", "x")).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "x" },
    ]);
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  test("replacement produces del+add around common context", () => {
    const rows = diffLines("one\ntwo\nthree", "one\n2\nthree");
    expect(rows).toEqual([
      { kind: "same", text: "one" },
      { kind: "del", text: "two" },
      { kind: "add", text: "2" },
      { kind: "same", text: "three" },
    ]);
  });

  test("keeps the longest common subsequence stable", () => {
    const rows = diffLines("a\nb\nc\nd", "b\nx\nd");
    const kept = rows.filter((r) => r.kind === "same").map((r) => r.text);
    expect(kept).toEqual(["b", "d"]);
    // Round-trip: dels reconstruct 'before', adds+sames reconstruct 'after'.
    const before = rows
      .filter((r) => r.kind !== "add")
      .map((r) => r.text)
      .join("\n");
    const after = rows
      .filter((r) => r.kind !== "del")
      .map((r) => r.text)
      .join("\n");
    expect(before).toBe("a\nb\nc\nd");
    expect(after).toBe("b\nx\nd");
  });
});

describe("collapseContext", () => {
  test("collapses long unchanged runs into gaps", () => {
    const rows = diffLines(
      ["1", "2", "3", "4", "5", "6", "7", "8", "old"].join("\n"),
      ["1", "2", "3", "4", "5", "6", "7", "8", "new"].join("\n"),
    );
    const out = collapseContext(rows, 2);
    expect(out[0]).toEqual({ kind: "gap", count: 6 });
    expect(out.slice(1)).toEqual([
      { kind: "same", text: "7" },
      { kind: "same", text: "8" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });

  test("no gaps when everything is near a change", () => {
    const out = collapseContext(diffLines("a", "b"), 2);
    expect(out.every((row) => row.kind !== "gap")).toBe(true);
  });
});
