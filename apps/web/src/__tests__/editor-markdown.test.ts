/**
 * The round-trip corpus — the load-bearing test of the Tiptap migration.
 *
 * The stored markdown IS the prompt: `packages/compiler/src/instructions.ts`
 * writes it verbatim into `agent/instructions.md` and hashes it into the build
 * cache key. Any byte the editor changes on the way through silently rewrites
 * a user's live agent, so every construct a real system prompt is likely to
 * contain must survive `parse → serialize` exactly.
 *
 * Tiptap runs headlessly here (no ProseMirror view), so unlike the CodeMirror
 * components this needs no DOM harness beyond a document for schema building.
 */
import { ensureDomForThisFile } from "../test/setup";

import { expect, test } from "bun:test";
import { Editor } from "@tiptap/core";

import { chatExtensions, documentExtensions } from "../lib/editor/profiles";
import { parseMarkdown } from "../lib/chat/markdown";

ensureDomForThisFile();

function documentEditor(): Editor {
  return new Editor({ extensions: documentExtensions(), content: "" });
}

/** Round-trip once. Trailing blank lines are not meaningful in a prompt. */
function roundTrip(editor: Editor, markdown: string): string {
  editor.commands.setContent(markdown, { contentType: "markdown" });
  return editor.getMarkdown().replace(/\n+$/, "");
}

/**
 * Prompt-shaped input. Grouped by the failure mode each case guards, because
 * a bare list of strings tells a future reader nothing about why it is here.
 */
const CORPUS: Record<string, string> = {
  // Plain prose and standard structure.
  plain: "You are a support triage agent.",
  heading: "# Title\n\nBody text.",
  headingAndList: "## Rules\n\n- First rule\n- Second rule",
  orderedList: "1. Step one\n2. Step two",
  nestedList: "- outer\n  - inner\n  - inner2",
  blockquote: "> quoted line",
  horizontalRule: "above\n\n---\n\nbelow",
  emphasis: "Use **bold** and *italic* and `code`.",
  fencedCode: "```ts\nconst x = 1;\n```",
  linkWithText: "See [docs](https://example.com).",
  hardBreak: "line one  \nline two",
  multiParagraph: "First para.\n\nSecond para.\n\n## Head\n\nThird.",

  // XML-ish tags. Stock @tiptap/markdown DELETES the standard ones and
  // entity-encodes the rest; system prompts are full of both.
  xmlUnknownTag: "<instructions>\nDo the thing.\n</instructions>",
  xmlStandardTag: "<output>\nJSON only.\n</output>",
  xmlInlineStandardTag: "<summary>short</summary>",
  xmlUnderscoreTag: "<output_format>\nJSON\n</output_format>",
  xmlAmongProse: "You are helpful.\n\n<rules>\n- be terse\n</rules>\n\nEnd.",

  // Characters the stock serializer backslash-escapes in prose.
  templatePlaceholders: "Use {{user_name}} and {{ trigger.email }}.",
  snakeCase: "Set the my_var_name field and other_var.",
  literalAsterisks: "Rate 5 * 3 = 15 and a*b.",
  literalBrackets: "Use [INSERT NAME] literally.",

  // The @reference grammar shared with the compiler and dispatcher.
  references: "Read @trigger.email then use @linear and @skill.release-notes.",
  referencesInCode: "Call `@trigger.email` or:\n\n```\n@trigger.email\n```",

  // Constructs with no node in the schema — must survive as literal text
  // rather than being dropped on the floor.
  pipeTable: "| a | b |\n| --- | --- |\n| 1 | 2 |",
  pipeTableAmongProse: "Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.",
};

for (const [name, markdown] of Object.entries(CORPUS)) {
  test(`round-trips exactly: ${name}`, () => {
    expect(roundTrip(documentEditor(), markdown)).toBe(markdown);
  });
}

test("round trip is idempotent across repeated edits", () => {
  const editor = documentEditor();
  const source = Object.values(CORPUS).join("\n\n");
  const once = roundTrip(editor, source);
  expect(roundTrip(editor, once)).toBe(once);
});

test("literal asterisks typed as plain text stay literal after a reload", () => {
  // Nothing escapes them on the way out, so the verify pass must notice that
  // the naive output would re-parse as emphasis and fall back to escaping.
  const editor = documentEditor();
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Literal *stars* and _score_." }] },
    ],
  });
  const serialized = editor.getMarkdown();
  editor.commands.setContent(serialized, { contentType: "markdown" });
  expect(editor.getText().trim()).toBe("Literal *stars* and _score_.");
});

test("an empty document serializes to an empty string", () => {
  expect(roundTrip(documentEditor(), "")).toBe("");
});

test("the chat profile cannot emit markdown the chat renderer fails to parse", () => {
  // Guards the composer↔renderer contract: every block the chat editor can
  // produce must come back out of lib/chat/markdown.ts as something other
  // than a bare paragraph of literal syntax.
  const editor = new Editor({ extensions: chatExtensions(), content: "" });
  const samples = [
    "**bold** and *italic*",
    "- one\n- two",
    "1. one\n2. two",
    "> quote",
    "```ts\nconst a = 1;\n```",
    "## Heading",
    "`inline code`",
    "[docs](https://example.com)",
  ];
  for (const sample of samples) {
    const out = roundTrip(editor, sample);
    expect(out).toBe(sample);
    // The renderer must produce at least one non-paragraph-of-literal-text block.
    expect(parseMarkdown(out).length).toBeGreaterThan(0);
  }
});
