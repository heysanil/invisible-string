/**
 * The `@reference` node — atomic chips for `@trigger.*`, `@skill.*` and
 * `@<connection>` in the workflow-instructions editor.
 *
 * THE CHIP IS A VIEW OF PLAIN TEXT, NEVER A NEW SYNTAX
 * ----------------------------------------------------
 * The stored value is a markdown string containing the literal characters
 * `@trigger.email`, and `parseReferences` (packages/shared) is what the
 * compiler (packages/compiler/src/instructions.ts) and the dispatcher
 * (packages/shared/src/render.ts) read it back with. So `renderMarkdown` emits
 * `attrs.raw` verbatim and hydrate.ts rebuilds the chips from that same
 * grammar on the way in — the bytes on the wire are exactly what a plain-text
 * editor would have produced.
 *
 * WHY AN ATOM
 * -----------
 * A reference is one indivisible token: `@trigger.email` resolves or it does
 * not, and half of it means nothing. As a text run the user can backspace it
 * into `@trigger.emai` — a ref that now only fails at publish. As an atom it
 * selects and deletes whole.
 *
 * TWO CONSTRAINTS TO KNOW BEFORE EXTENDING THIS
 * ---------------------------------------------
 * 1. The schema forbids marks on the node (`marks: ""`). @tiptap/markdown
 *    serializes a mark around a non-text node by CLOSING it before the node
 *    and reopening after, so a bold chip turns `**a @x b**` into
 *    `**a** @x **b**`. hydrate.ts therefore leaves refs inside formatted text
 *    as literal text — still lexically a reference to the compiler, just
 *    without a chip.
 * 2. The suggestion menu only opens where an inserted chip would actually
 *    parse back as a reference — see `allowsReferenceAfter` and `allow`.
 */
import { parseReferences } from "@invisible-string/shared";
import { InputRule, Node, mergeAttributes, type Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";

import {
  referenceOptions,
  type ReferenceOption,
  type ReferenceOptionKind,
} from "../builder/references";
import {
  referenceSourcesFrom,
  referenceStatusPlugin,
} from "./reference-status";

/** Node name. Shared with hydrate.ts and the status plugin's decorations. */
export const REFERENCE_NODE_NAME = "reference";

/** Lets a later phase address the suggestion plugin (popup, key handling). */
export const referenceSuggestionPluginKey = new PluginKey("referenceSuggestion");

export interface ReferenceAttributes {
  /** The exact token, e.g. "@trigger.email" — what serializes to markdown. */
  raw: string;
  kind: ReferenceOptionKind;
}

export interface ReferenceExtensionOptions {
  HTMLAttributes: Record<string, unknown>;
  /**
   * Overrides merged over the defaults below. A screen supplies `render` here
   * to mount the popup; everything else (items, command, allow) already speaks
   * the reference grammar and should be left alone.
   */
  suggestion: Partial<Omit<SuggestionOptions<ReferenceOption, ReferenceOption>, "editor">>;
}

/**
 * The characters REFERENCE_PATTERN's lookbehind refuses to let an `@` follow.
 * Keep in lockstep with `(?<![A-Za-z0-9_.@-])` in packages/shared — the
 * grammar test in __tests__/editor-references.test.ts checks the two agree
 * character by character.
 */
const BLOCKED_PREFIX = /[A-Za-z0-9_.@-]/;

/** Whether an `@` typed after `character` could start a reference at all. */
export function allowsReferenceAfter(character: string): boolean {
  return character === "" || !BLOCKED_PREFIX.test(character);
}

/**
 * The `@` menu's option list: everything addressable in the current draft,
 * narrowed by what the author has typed so far. Prefix matches rank above
 * substring matches — typing "tri" should not bury `@trigger.*` under a
 * connection that merely contains the letters.
 */
export function filterReferenceOptions(
  options: readonly ReferenceOption[],
  query: string,
): ReferenceOption[] {
  const needle = query.toLowerCase();
  if (needle === "") return [...options];

  const prefixed: ReferenceOption[] = [];
  const contained: ReferenceOption[] = [];
  for (const option of options) {
    // Compare without the leading "@" — the query never includes it.
    const token = option.label.slice(1).toLowerCase();
    if (token.startsWith(needle)) prefixed.push(option);
    else if (token.includes(needle)) contained.push(option);
  }
  return [...prefixed, ...contained];
}

/** The kind attribute for a raw token, derived from the shared grammar. */
export function referenceKind(raw: string): ReferenceOptionKind {
  return parseReferences(raw)[0]?.kind ?? "connection";
}

function rawOf(attrs: Record<string, unknown>): string {
  return typeof attrs.raw === "string" ? attrs.raw : "";
}

/**
 * Replace `range` with a chip for `option`. Extracted from the suggestion's
 * `command` so the insertion — which has to get the surrounding spaces right —
 * is reachable from a test and from any later toolbar/copilot affordance.
 */
export function insertReference(
  editor: Editor,
  range: { from: number; to: number },
  option: ReferenceOption,
): void {
  // Swallow a space the author already typed after the token, so accepting a
  // completion never leaves a double space.
  const nodeAfter = editor.state.doc.resolve(range.to).nodeAfter;
  const to = nodeAfter?.text?.startsWith(" ") === true ? range.to + 1 : range.to;

  editor
    .chain()
    .focus()
    .insertContentAt({ from: range.from, to }, [
      {
        type: REFERENCE_NODE_NAME,
        attrs: { raw: option.label, kind: option.kind },
      },
      // An atom at the end of a paragraph leaves nowhere to type, and the
      // suggestion plugin only matches inside a text node — so the trailing
      // space is also what keeps the NEXT `@` addressable.
      { type: "text", text: " " },
    ])
    .run();
}

/**
 * A reference the author TYPED (rather than picked from the `@` menu), the
 * moment it is terminated by whitespace.
 *
 * Without this, only menu-inserted refs became chips: identical markdown
 * rendered as a chip after a reload but as plain text while you were writing
 * it, and the amber unresolved-underline the section legend promises never
 * appeared for typed refs. CodeMirror decorated continuously from the text, so
 * this is parity, not a new feature.
 *
 * The leading boundary class mirrors REFERENCE_PATTERN's lookbehind in
 * packages/shared — `sanil@example.com` and `@@x` must not become chips,
 * because `parseReferences` does not see references there either.
 */
const TYPED_REFERENCE =
  /(?:^|[^A-Za-z0-9_.@-])(@[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)(\s)$/;

export const Reference = Node.create<ReferenceExtensionOptions>({
  name: REFERENCE_NODE_NAME,

  addOptions() {
    return { HTMLAttributes: {}, suggestion: {} };
  },

  addInputRules() {
    return [
      new InputRule({
        find: TYPED_REFERENCE,
        // Mutates `state.tr` rather than running a chain: Tiptap's input-rule
        // runner applies exactly that transaction afterwards and treats a
        // chain's separate dispatch as "rule did not match".
        handler: ({ range, match, state }) => {
          const raw = match[1];
          const trailing = match[2];
          if (raw === undefined || trailing === undefined) return null;

          // Inside code the token stays literal — that is what hydrate.ts does
          // on load, and what serialization reproduces. A chip here would also
          // be unrepresentable: the schema forbids marks on the node.
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code === true) return null;
          const codeMark = state.schema.marks.code;
          if (
            codeMark !== undefined &&
            state.doc.rangeHasMark($from.pos, range.to, codeMark)
          ) {
            return null;
          }

          const nodeType = state.schema.nodes[REFERENCE_NODE_NAME];
          if (nodeType === undefined) return null;

          // The character being typed is NOT in the document yet — the rule
          // runs against `textBefore + input` — so `range.to` sits just after
          // the token and only `raw` is on screen. Subtracting the trailing
          // character too would swallow the space in front of the `@`.
          const from = range.to - raw.length;
          state.tr.replaceWith(from, range.to, [
            nodeType.create({ raw, kind: referenceKind(raw) }),
            state.schema.text(trailing),
          ]);
        },
      }),
    ];
  },

  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  // Dragging a chip into a code fence would produce text the compiler no
  // longer resolves, with no visible change to the author.
  draggable: false,
  // See the file header: marks around an atom do not survive serialization.
  marks: "",

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-reference") ?? "",
        renderHTML: (attributes) => ({ "data-reference": rawOf(attributes) }),
      },
      kind: {
        default: "connection",
        parseHTML: (element) =>
          element.getAttribute("data-kind") ??
          referenceKind(element.getAttribute("data-reference") ?? ""),
        renderHTML: (attributes) => ({ "data-kind": String(attributes.kind) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-reference]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { class: "tt-ref" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      rawOf(node.attrs),
    ];
  },

  /** Keeps `editor.getText()` — copilot context, e2e assertions — complete. */
  renderText({ node }) {
    return rawOf(node.attrs);
  },

  /** The whole point: byte-for-byte the token the author sees. */
  renderMarkdown(node) {
    return rawOf(node.attrs ?? {});
  },

  addProseMirrorPlugins() {
    const nodeName = this.name;

    return [
      referenceStatusPlugin({ nodeName }),
      Suggestion<ReferenceOption, ReferenceOption>({
        editor: this.editor,
        pluginKey: referenceSuggestionPluginKey,
        char: "@",
        // A reference segment cannot contain a space, so a space always ends
        // the token — same shape as the CodeMirror AT_TOKEN it replaces.
        allowSpaces: false,
        startOfLine: false,
        // The plugin can only express an allow-LIST of preceding characters;
        // the grammar has a deny-list. `allow` below does it properly.
        allowedPrefixes: null,

        items: ({ editor, query }) =>
          filterReferenceOptions(
            referenceOptions(referenceSourcesFrom(editor.state)),
            query,
          ),

        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);

          // A code fence is `text*`: the chip could not be inserted, and its
          // characters would serialize inside backticks where the compiler
          // reads them as literal prose.
          const type = state.schema.nodes[nodeName];
          if (type === undefined) return false;
          if ($from.parent.type.spec.code === true) return false;
          if (!$from.parent.type.contentMatch.matchType(type)) return false;

          // Inline `code` is a mark, so the schema would happily take a chip —
          // but the backticks around it have the same effect as a fence.
          const marks = state.storedMarks ?? $from.marks();
          if (marks.some((mark) => mark.type.name === "code")) return false;

          // `sanil@example.com` must not offer a menu: the grammar's lookbehind
          // would refuse the token, so a chip inserted here would silently
          // serialize to text nothing parses back.
          const before = state.doc.textBetween(
            Math.max(0, range.from - 1),
            range.from,
            undefined,
            (leaf) => rawOf(leaf.attrs),
          );
          return allowsReferenceAfter(before.slice(-1));
        },

        command: ({ editor, range, props }) => insertReference(editor, range, props),

        ...this.options.suggestion,
      }),
    ];
  },
});
