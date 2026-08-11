import { describe, expect, test } from "bun:test";

import { LLMS_DOCS_MARKER, renderLlmsTxt } from "../lib/llms";
import type { DocFrontmatter } from "../lib/sidebar";

const template = `# invisible-string\n\n## Docs\n\n${LLMS_DOCS_MARKER}\n\n## Source\n\n- [GitHub](https://github.com/heysanil/invisible-string)\n`;

function fm(
  title: string,
  section: string,
  order: number,
  description: string,
): DocFrontmatter {
  return { title, section, order, description };
}

const entries: Array<[string, DocFrontmatter]> = [
  ["concepts/agents", fm("Agents", "Concepts", 20, "A role you define.")],
  ["getting-started/overview", fm("Overview", "Getting started", 10, "What it is.")],
  ["getting-started/quickstart", fm("Quickstart", "Getting started", 20, "Build one.")],
];

describe("renderLlmsTxt", () => {
  test("lists every doc, grouped and ordered like the sidebar", () => {
    const out = renderLlmsTxt(template, entries);
    const docLines = out.split("\n").filter((line) => line.startsWith("- ["));
    expect(docLines).toEqual([
      "- [Overview](/docs/getting-started/overview): What it is.",
      "- [Quickstart](/docs/getting-started/quickstart): Build one.",
      "- [Agents](/docs/concepts/agents): A role you define.",
      "- [GitHub](https://github.com/heysanil/invisible-string)",
    ]);
  });

  test("emits a heading per section", () => {
    const out = renderLlmsTxt(template, entries);
    expect(out).toContain("### Getting started");
    expect(out).toContain("### Concepts");
  });

  test("preserves the template's own sections", () => {
    const out = renderLlmsTxt(template, entries);
    expect(out.startsWith("# invisible-string")).toBe(true);
    expect(out).toContain("## Source");
  });

  test("consumes the marker", () => {
    expect(renderLlmsTxt(template, entries)).not.toContain(LLMS_DOCS_MARKER);
  });

  test("throws when the template has no marker, rather than silently dropping the docs", () => {
    expect(() => renderLlmsTxt("# no marker here\n", entries)).toThrow(
      /marker/i,
    );
  });
});
