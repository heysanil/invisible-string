/**
 * The `@reference` chip must be invisible to everything downstream.
 *
 * A chip is a VIEW of a text span: the stored markdown still contains the
 * literal characters `@trigger.email`, and `parseReferences` (shared with the
 * compiler and the dispatcher) is what reads them back. So the load-bearing
 * property here is not "chips render" — it is that markdown → hydrate →
 * serialize returns the input byte for byte, and that hydration recognises
 * exactly the spans `parseReferences` does, no more and no fewer.
 */
import { ensureDomForThisFile } from "../test/setup";

import { expect, test } from "bun:test";
import { Editor, type JSONContent } from "@tiptap/core";
import { parseReferences, type TriggerConfig } from "@invisible-string/shared";

import {
  referenceOptions,
  referenceProblem,
  type ReferenceSources,
} from "../lib/builder/references";
import { hydrateReferences } from "../lib/editor/hydrate";
import { documentExtensions } from "../lib/editor/profiles";
import {
  allowsReferenceAfter,
  filterReferenceOptions,
  insertReference,
  REFERENCE_NODE_NAME,
  Reference,
} from "../lib/editor/reference";
import {
  referenceNodeProblem,
  setReferenceSources,
} from "../lib/editor/reference-status";

ensureDomForThisFile();

// ── Fixtures ────────────────────────────────────────────────────────────────

const formTrigger: TriggerConfig = {
  type: "form",
  fields: [
    { key: "email", label: "Email", type: "text", required: true },
    { key: "topic", label: "Topic", type: "text", required: false },
  ],
};

const sources: ReferenceSources = {
  trigger: formTrigger,
  steps: [
    { slug: "search", name: "Search Slack", kind: "tool", outputHints: ["result", "text"] },
    { slug: "summarize", name: null, kind: "infer", outputHints: ["text"] },
  ],
  stateKeys: ["cursor"],
  item: true,
  connections: [
    { name: "Linear", description: "Issue tracker" },
    { name: "Google Drive" },
  ],
  skills: [{ name: "Release Notes", description: "Draft notes" }],
};

/** Every trigger shape that contributes `@trigger.*` options. */
const ALL_SOURCE_SHAPES: ReferenceSources[] = [
  sources,
  { ...sources, trigger: { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } } },
  { ...sources, trigger: { type: "webhook" } },
];

// ── Harness ─────────────────────────────────────────────────────────────────

function referenceEditor(): Editor {
  return new Editor({
    extensions: [...documentExtensions(), Reference],
    content: "",
  });
}

/** The markdown manager the editor itself serializes with. */
function manager(editor: Editor) {
  const markdown = editor.markdown;
  if (!markdown) throw new Error("the markdown manager is not installed");
  return markdown;
}

/** markdown → parse → hydrate → document. What loading a draft does. */
function load(editor: Editor, markdown: string): void {
  editor.commands.setContent(hydrateReferences(manager(editor).parse(markdown)));
}

/** A full load + serialize cycle. Trailing blank lines are not meaningful. */
function roundTrip(editor: Editor, markdown: string): string {
  load(editor, markdown);
  return editor.getMarkdown().replace(/\n+$/, "");
}

/** Every `raw` in the live document, in order. */
function chips(editor: Editor): string[] {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === REFERENCE_NODE_NAME) found.push(String(node.attrs.raw));
    return true;
  });
  return found;
}

// ── Serialization is the wire format ────────────────────────────────────────

test("a reference node serializes to exactly its raw text", () => {
  const editor = referenceEditor();
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: REFERENCE_NODE_NAME, attrs: { raw: "@trigger.email", kind: "trigger" } },
        ],
      },
    ],
  });
  expect(editor.getMarkdown().replace(/\n+$/, "")).toBe("@trigger.email");
  expect(editor.getText()).toBe("@trigger.email");
});

test("every referenceOptions label round-trips byte for byte", () => {
  const editor = referenceEditor();
  for (const shape of ALL_SOURCE_SHAPES) {
    for (const option of referenceOptions(shape)) {
      const markdown = `Read ${option.label} before replying.`;
      expect(roundTrip(editor, markdown)).toBe(markdown);
      // Guard against a vacuous pass: the label must really have become a chip.
      expect(chips(editor)).toEqual([option.label]);
    }
  }
});

test("a realistic instructions document survives unchanged", () => {
  const markdown = [
    "## Triage",
    "",
    "When a request arrives:",
    "",
    "1. Read @trigger.email and @trigger.topic.",
    "2. Search @linear for an existing issue; check @google-drive for prior art.",
    "3. Follow @skill.release-notes when the request is about a release.",
    "",
    "> Never invent an issue id.",
    "",
    "Reply with `@trigger.email` quoted literally in the footer:",
    "",
    "```md",
    "From: @trigger.email",
    "```",
    "",
    "<output>",
    "One paragraph, no preamble.",
    "</output>",
  ].join("\n");

  const editor = referenceEditor();
  expect(roundTrip(editor, markdown)).toBe(markdown);
  expect(chips(editor)).toEqual([
    "@trigger.email",
    "@trigger.topic",
    "@linear",
    "@google-drive",
    "@skill.release-notes",
  ]);
});

test("round-tripping a loaded document is idempotent", () => {
  const editor = referenceEditor();
  const source = "Use @linear and @trigger.email.\n\nThen @skill.release-notes.";
  const once = roundTrip(editor, source);
  expect(roundTrip(editor, once)).toBe(once);
});

// ── Code is literal ─────────────────────────────────────────────────────────

test("refs in fenced code and inline code stay literal text", () => {
  const markdown = "Call `@trigger.email` or:\n\n```\n@trigger.email\n```";
  const editor = referenceEditor();
  expect(roundTrip(editor, markdown)).toBe(markdown);
  expect(chips(editor)).toEqual([]);
});

test("refs inside emphasis stay literal text rather than lose their markers", () => {
  // A chip cannot carry a mark (see lib/editor/reference.ts) — serializing one
  // inside bold would move the `**` around it. Literal text is the safe read.
  const markdown = "Always check **@linear** first.";
  const editor = referenceEditor();
  expect(roundTrip(editor, markdown)).toBe(markdown);
  expect(chips(editor)).toEqual([]);
  // Still a reference as far as the compiler is concerned.
  expect(parseReferences(markdown).map((ref) => ref.raw)).toEqual(["@linear"]);
});

test("the schema refuses a chip where its text would be literal", () => {
  const { nodes } = referenceEditor().schema;
  const reference = nodes[REFERENCE_NODE_NAME];
  expect(reference).toBeDefined();
  expect(nodes.paragraph?.contentMatch.matchType(reference!)).toBeTruthy();
  expect(nodes.codeBlock?.contentMatch.matchType(reference!)).toBeFalsy();
});

test("a chip cannot pick up a mark", () => {
  // `marks: ""` is why hydration can leave refs inside emphasis as plain text
  // instead of producing a chip whose `**` would move (see reference.ts).
  const editor = referenceEditor();
  load(editor, "Use @linear here.");
  editor.commands.selectAll();
  editor.commands.toggleBold();

  expect(chips(editor)).toEqual(["@linear"]);
  expect(editor.getText()).toBe("Use @linear here.");
  // Bolding ACROSS a chip still shifts where the delimiters sit — the
  // serializer closes a mark before a non-text node and reopens it after, and
  // no node config can change that. The token itself is untouched, so the ref
  // still resolves; only the emphasis span moves by a space.
  expect(editor.getMarkdown().replace(/\n+$/, "")).toBe("**Use **@linear** here.**");
});

// ── Hydration recognises exactly what the grammar recognises ────────────────

const PROSE: Record<string, string> = {
  emailAddress: "Mail sanil@example.com for access.",
  doubleAt: "Use @@x as an escape.",
  digitFirst: "Standup is @5pm sharp.",
  bareAt: "Cost is 3 @ $4.",
  trailingDot: "Read @trigger.email. Then stop.",
  dottedConnection: "Open @linear.issues in the browser.",
  hyphenated: "Attach @skill.release-notes to the run.",
  parenthesised: "See (@linear) for context.",
  adjacentPunctuation: "Ping @linear, then @google-drive; finally @trigger.topic!",
  stepRef: "Read @steps.search.result.messages before writing.",
  stateAndItem: "Compare @item.ts against @state.cursor.",
  nowTruncates: "Stamp @now.date on it.",
};

for (const [name, markdown] of Object.entries(PROSE)) {
  test(`hydration matches parseReferences: ${name}`, () => {
    const editor = referenceEditor();
    expect(roundTrip(editor, markdown)).toBe(markdown);
    expect(chips(editor)).toEqual(parseReferences(markdown).map((ref) => ref.raw));
  });
}

test("hydration splits a text node without disturbing its neighbours", () => {
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "ping @linear now" }],
      },
    ],
  };
  const paragraph = hydrateReferences(doc).content?.[0];
  expect(paragraph?.content).toEqual([
    { type: "text", text: "ping " },
    { type: REFERENCE_NODE_NAME, attrs: { raw: "@linear", kind: "connection" } },
    { type: "text", text: " now" },
  ]);
});

test("hydration honours the lookbehind across an adjacent text node", () => {
  // `manager.parse` may emit text nodes a normalized document would merge; the
  // `@` here is preceded by a word character, so it is not a reference.
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "sanil" },
          { type: "text", text: "@example.com" },
        ],
      },
    ],
  };
  expect(hydrateReferences(doc).content?.[0]?.content).toEqual([
    { type: "text", text: "sanil" },
    { type: "text", text: "@example.com" },
  ]);
});

test("hydration is a no-op on a document with no references", () => {
  const editor = referenceEditor();
  const markdown = "# Title\n\n- one\n- two";
  expect(roundTrip(editor, markdown)).toBe(markdown);
  expect(chips(editor)).toEqual([]);
});

// ── Resolved vs unresolved ──────────────────────────────────────────────────

test("referenceNodeProblem agrees with referenceProblem for every option", () => {
  for (const shape of ALL_SOURCE_SHAPES) {
    for (const option of referenceOptions(shape)) {
      const ref = parseReferences(option.label)[0];
      expect(ref).toBeDefined();
      expect(referenceNodeProblem(option.label, shape)).toBe(
        referenceProblem(ref!, shape),
      );
    }
  }
});

test("referenceNodeProblem flags what the sources cannot resolve", () => {
  expect(referenceNodeProblem("@linear", sources)).toBeNull();
  expect(referenceNodeProblem("@trigger.email", sources)).toBeNull();
  expect(referenceNodeProblem("@skill.release-notes", sources)).toBeNull();
  expect(referenceNodeProblem("@steps.search.text", sources)).toBeNull();
  expect(referenceNodeProblem("@state.cursor", sources)).toBeNull();
  expect(referenceNodeProblem("@item", sources)).toBeNull();
  expect(referenceNodeProblem("@now", sources)).toBeNull();
  expect(referenceNodeProblem("@notion", sources)).toContain("notion");
  expect(referenceNodeProblem("@trigger.nope", sources)).toContain("nope");
  expect(referenceNodeProblem("@skill.missing", sources)).toContain("missing");
  expect(referenceNodeProblem("@steps.missing", sources)).toContain("missing");
  expect(referenceNodeProblem("@state.gone", sources)).toContain("gone");
  expect(referenceNodeProblem("@item", { ...sources, item: false })).toContain(
    "for_each",
  );
});

test("unresolved STEP refs get the same amber treatment as connections", () => {
  const editor = referenceEditor();
  load(editor, "Use @steps.search.text and @steps.missing here.");
  setReferenceSources(editor, sources);

  const classOf = (raw: string): string | undefined =>
    editor.view.dom
      .querySelector(`[data-reference="${raw}"]`)
      ?.getAttribute("class") ?? undefined;

  expect(classOf("@steps.search.text")).toContain("tt-ref-resolved");
  expect(classOf("@steps.missing")).toContain("tt-ref-unresolved");
  expect(
    editor.view.dom
      .querySelector('[data-reference="@steps.missing"]')
      ?.getAttribute("title"),
  ).toBe(referenceNodeProblem("@steps.missing", sources));
});

test("step/state/item/now chips carry their parsed kind", () => {
  const editor = referenceEditor();
  load(editor, "Take @steps.search.result, @state.cursor, @item and @now.");
  const kinds: Record<string, string> = {};
  editor.state.doc.descendants((node) => {
    if (node.type.name === REFERENCE_NODE_NAME) {
      kinds[String(node.attrs.raw)] = String(node.attrs.kind);
    }
    return true;
  });
  expect(kinds).toEqual({
    "@steps.search.result": "step",
    "@state.cursor": "state",
    "@item": "item",
    "@now": "now",
  });
});

test("the status plugin classifies every chip in the rendered document", () => {
  const editor = referenceEditor();
  load(editor, "Use @linear, @notion, @trigger.email and @trigger.nope.");
  setReferenceSources(editor, sources);

  const classOf = (raw: string): string | undefined =>
    editor.view.dom
      .querySelector(`[data-reference="${raw}"]`)
      ?.getAttribute("class") ?? undefined;

  expect(classOf("@linear")).toContain("tt-ref-resolved");
  expect(classOf("@trigger.email")).toContain("tt-ref-resolved");
  expect(classOf("@notion")).toContain("tt-ref-unresolved");
  expect(classOf("@trigger.nope")).toContain("tt-ref-unresolved");
  expect(
    editor.view.dom.querySelector('[data-reference="@notion"]')?.getAttribute("title"),
  ).toBe(referenceNodeProblem("@notion", sources));
});

test("pushing new sources re-classifies without rebuilding the document", () => {
  const editor = referenceEditor();
  load(editor, "Use @notion.");
  setReferenceSources(editor, sources);
  const before = editor.state.doc.toJSON();
  expect(
    editor.view.dom.querySelector('[data-reference="@notion"]')?.getAttribute("class"),
  ).toContain("tt-ref-unresolved");

  setReferenceSources(editor, { ...sources, connections: [{ name: "Notion" }] });
  expect(
    editor.view.dom.querySelector('[data-reference="@notion"]')?.getAttribute("class"),
  ).toContain("tt-ref-resolved");
  expect(editor.state.doc.toJSON()).toEqual(before);
});

// ── The `@` menu ────────────────────────────────────────────────────────────

test("the menu only opens where the grammar would accept an @", () => {
  // Character by character against the shared lookbehind — the suggestion gate
  // and `parseReferences` must not drift.
  for (let code = 32; code < 127; code += 1) {
    const character = String.fromCharCode(code);
    const grammarAccepts = parseReferences(`${character}@linear`).length === 1;
    expect([character, allowsReferenceAfter(character)]).toEqual([
      character,
      grammarAccepts,
    ]);
  }
  expect(allowsReferenceAfter("")).toBe(true);
});

/** Mid-typing state: the partial token is still plain text, never hydrated. */
function typing(text: string): Editor {
  const editor = referenceEditor();
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  return editor;
}

test("accepting a completion leaves exactly one trailing space", () => {
  const option = referenceOptions(sources).find((o) => o.label === "@linear");
  expect(option).toBeDefined();

  // "Open @lin": the paragraph opens at 0, so the "@" sits at 1 + 5.
  const editor = typing("Open @lin");
  insertReference(editor, { from: 6, to: 10 }, option!);

  expect(chips(editor)).toEqual(["@linear"]);
  // The space is real document content — the author carries on typing into it.
  expect(editor.getText()).toBe("Open @linear ");
  expect(editor.getMarkdown().replace(/\n+$/, "")).toBe("Open @linear ");
});

test("accepting a completion swallows a space the author already typed", () => {
  const option = referenceOptions(sources).find((o) => o.label === "@linear");
  const editor = typing("Open @lin now");
  insertReference(editor, { from: 6, to: 10 }, option!);

  expect(editor.getText()).toBe("Open @linear now");
  expect(editor.getMarkdown().replace(/\n+$/, "")).toBe("Open @linear now");
});

test("filtering ranks prefix matches above substring matches", () => {
  const options = referenceOptions(sources);
  expect(filterReferenceOptions(options, "").length).toBe(options.length);
  expect(filterReferenceOptions(options, "trigger.").map((o) => o.label)).toEqual([
    "@trigger.email",
    "@trigger.topic",
  ]);
  expect(filterReferenceOptions(options, "release").map((o) => o.label)).toEqual([
    "@skill.release-notes",
  ]);
  expect(filterReferenceOptions(options, "LINEAR").map((o) => o.label)).toEqual([
    "@linear",
  ]);
  expect(filterReferenceOptions(options, "zzz")).toEqual([]);
});

// ── typed references (the input rule) ────────────────────────────────────────

/**
 * Type `text` the way a person does, one character at a time through
 * ProseMirror's `handleTextInput`. `insertContent` bypasses that hook, so it
 * would never fire an input rule and the assertions below would all pass
 * vacuously.
 */
function typeInto(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (fn) =>
      (fn as (v: unknown, f: number, t: number, text: string) => boolean)(
        editor.view,
        from,
        to,
        char,
      ),
    );
    if (handled !== true) editor.commands.insertContent(char);
  }
}

function referenceRaws(editor: Editor): string[] {
  const raws: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "reference") raws.push(String(node.attrs.raw));
  });
  return raws;
}

test("a typed reference becomes a chip once whitespace terminates it", () => {
  const editor = referenceEditor();
  typeInto(editor, "Check @notes for history ");
  expect(referenceRaws(editor)).toEqual(["@notes"]);
  // The whole point: the chip is a VIEW, the bytes are unchanged.
  expect(editor.getMarkdown().trim()).toBe("Check @notes for history");
});

test("a dotted typed reference chips as one whole token", () => {
  const editor = referenceEditor();
  typeInto(editor, "Note the sender @trigger.email now ");
  expect(referenceRaws(editor)).toEqual(["@trigger.email"]);
  expect(editor.getMarkdown().trim()).toBe("Note the sender @trigger.email now");
});

test("prose that only looks like a reference never chips", () => {
  // Each of these is invisible to parseReferences, so a chip here would be a
  // reference the compiler does not agree exists.
  for (const source of ["Mail sanil@example.com ", "Ping @@twice ", "Meet @5pm "]) {
    const editor = referenceEditor();
    typeInto(editor, source);
    expect(referenceRaws(editor)).toEqual([]);
    expect(editor.getMarkdown().trim()).toBe(source.trim());
  }
});

test("a reference typed inside inline code stays literal", () => {
  const editor = referenceEditor();
  editor.commands.setContent("Call `@trigger.email` now", { contentType: "markdown" });
  expect(referenceRaws(editor)).toEqual([]);
  expect(editor.getMarkdown().trim()).toBe("Call `@trigger.email` now");
});
