import { describe, expect, test } from "bun:test";

import {
  buildSidebar,
  type DocFrontmatter,
  docNeighbours,
  flattenSidebar,
  type SidebarSection,
} from "../lib/sidebar";

function fm(title: string, section: string, order: number): DocFrontmatter {
  return { title, section, order };
}

describe("buildSidebar", () => {
  test("groups by section and orders items by order", () => {
    const sections = buildSidebar([
      ["gs/quickstart", fm("Quickstart", "Getting started", 2)],
      ["gs/overview", fm("Overview", "Getting started", 1)],
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.section).toBe("Getting started");
    expect(sections[0]?.items.map((i) => i.slug)).toEqual([
      "gs/overview",
      "gs/quickstart",
    ]);
  });

  test("orders sections by smallest item order", () => {
    const sections = buildSidebar([
      ["platform/arch", fm("Architecture", "Platform", 10)],
      ["gs/overview", fm("Overview", "Getting started", 1)],
    ]);
    expect(sections.map((s) => s.section)).toEqual([
      "Getting started",
      "Platform",
    ]);
  });

  test("preserves a deliberate multi-section order via order offsets", () => {
    // Mirrors the real content scheme: section base orders 10/20/30/40 keep the
    // sections in authored sequence regardless of alphabetics.
    const sections = buildSidebar([
      ["platform/security", fm("Security", "Platform", 42)],
      ["building/builder", fm("The builder", "Building", 30)],
      ["gs/overview", fm("Overview", "Getting started", 10)],
      ["concepts/pillars", fm("The four pillars", "Concepts", 20)],
    ]);
    expect(sections.map((s) => s.section)).toEqual([
      "Getting started",
      "Concepts",
      "Building",
      "Platform",
    ]);
  });

  test("breaks item ties by title", () => {
    const sections = buildSidebar([
      ["a/b", fm("Beta", "S", 1)],
      ["a/a", fm("Alpha", "S", 1)],
    ]);
    expect(sections[0]?.items.map((i) => i.title)).toEqual(["Alpha", "Beta"]);
  });

  test("empty input yields no sections", () => {
    expect(buildSidebar([])).toEqual([]);
  });
});

describe("flattenSidebar", () => {
  const sections: SidebarSection[] = buildSidebar([
    ["gs/overview", fm("Overview", "Getting started", 10)],
    ["gs/quickstart", fm("Quickstart", "Getting started", 11)],
    ["concepts/pillars", fm("The four pillars", "Concepts", 20)],
  ]);

  test("flattens in reading order and carries the section", () => {
    const flat = flattenSidebar(sections);
    expect(flat.map((d) => d.slug)).toEqual([
      "gs/overview",
      "gs/quickstart",
      "concepts/pillars",
    ]);
    expect(flat[2]?.section).toBe("Concepts");
  });

  test("empty sections flatten to nothing", () => {
    expect(flattenSidebar([])).toEqual([]);
  });
});

describe("docNeighbours", () => {
  const flat = flattenSidebar(
    buildSidebar([
      ["a", fm("A", "S", 10)],
      ["b", fm("B", "S", 11)],
      ["c", fm("C", "S", 12)],
    ]),
  );

  test("returns both neighbours in the middle", () => {
    const { prev, next } = docNeighbours(flat, "b");
    expect(prev?.slug).toBe("a");
    expect(next?.slug).toBe("c");
  });

  test("first page has no prev, last page has no next", () => {
    expect(docNeighbours(flat, "a").prev).toBeNull();
    expect(docNeighbours(flat, "a").next?.slug).toBe("b");
    expect(docNeighbours(flat, "c").next).toBeNull();
    expect(docNeighbours(flat, "c").prev?.slug).toBe("b");
  });

  test("unknown slug yields no neighbours", () => {
    expect(docNeighbours(flat, "missing")).toEqual({ prev: null, next: null });
  });
});
