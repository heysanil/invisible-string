/** Markdown parser tests: block + inline subset, streaming-safe fences. */
import { expect, test } from "bun:test";

import { parseInline, parseMarkdown } from "../lib/chat/markdown";

test("parses headings, paragraphs and lists", () => {
  const blocks = parseMarkdown("# Title\n\nHello world\n\n- one\n- two");
  expect(blocks[0]).toMatchObject({ kind: "h", level: 1 });
  expect(blocks[1]).toMatchObject({ kind: "p" });
  expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
  const list = blocks[2] as Extract<(typeof blocks)[number], { kind: "list" }>;
  expect(list.items.length).toBe(2);
});

test("parses ordered lists distinctly from unordered", () => {
  const blocks = parseMarkdown("1. first\n2. second");
  expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
});

test("fenced code preserves content and language", () => {
  const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
  expect(blocks[0]).toMatchObject({ kind: "code", lang: "ts", text: "const x = 1;" });
});

test("an unterminated fence (mid-stream) swallows the rest as code", () => {
  const blocks = parseMarkdown("```\nline one\nline two");
  expect(blocks.length).toBe(1);
  expect(blocks[0]).toMatchObject({ kind: "code", text: "line one\nline two" });
});

test("inline: code, strong, em, link", () => {
  const nodes = parseInline("a `code` **bold** *em* [x](https://e.com)");
  const kinds = nodes.map((n) => n.kind);
  expect(kinds).toContain("code");
  expect(kinds).toContain("strong");
  expect(kinds).toContain("em");
  expect(kinds).toContain("link");
});

test("inline: unsafe link protocols fall back to plain text", () => {
  const nodes = parseInline("[x](javascript:alert(1))");
  expect(nodes.every((n) => n.kind !== "link")).toBe(true);
});
