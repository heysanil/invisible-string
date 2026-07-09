// DOM test — register happy-dom before anything reads `document`.
import { ensureDomForThisFile } from "../test/setup";

import { describe, expect, test } from "bun:test";

import { extractToc } from "../lib/toc";

ensureDomForThisFile();

function containerFrom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("extractToc", () => {
  test("collects h2 and h3 with ids, recording depth and text", () => {
    const container = containerFrom(`
      <h1 id="title">Title</h1>
      <h2 id="what-it-is">What it is</h2>
      <p>body</p>
      <h3 id="trigger">Trigger</h3>
      <h3 id="context">Context</h3>
      <h2 id="next">Where to go next</h2>
    `);

    const toc = extractToc(container);

    expect(toc).toEqual([
      { id: "what-it-is", text: "What it is", depth: 2 },
      { id: "trigger", text: "Trigger", depth: 3 },
      { id: "context", text: "Context", depth: 3 },
      { id: "next", text: "Where to go next", depth: 2 },
    ]);
  });

  test("preserves document order", () => {
    const container = containerFrom(`
      <h2 id="a">A</h2>
      <h3 id="b">B</h3>
      <h2 id="c">C</h2>
    `);
    expect(extractToc(container).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  test("ignores headings without ids and h1/h4+", () => {
    const container = containerFrom(`
      <h1 id="h1">Page</h1>
      <h2>no id — skipped</h2>
      <h2 id="kept">Kept</h2>
      <h4 id="too-deep">Too deep</h4>
    `);
    expect(extractToc(container).map((e) => e.id)).toEqual(["kept"]);
  });

  test("trims heading whitespace", () => {
    const container = containerFrom(`<h2 id="s">   Spaced   </h2>`);
    expect(extractToc(container)[0]?.text).toBe("Spaced");
  });

  test("empty container yields an empty toc", () => {
    expect(extractToc(containerFrom(""))).toEqual([]);
  });
});
