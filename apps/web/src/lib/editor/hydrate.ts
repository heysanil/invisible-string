/**
 * Turn the `@references` in a freshly parsed markdown document into chips.
 *
 * Parsing markdown gives plain text — `@trigger.email` is just eleven
 * characters to `marked`. This walks the resulting JSON and replaces each span
 * that `parseReferences` recognises with a `reference` node, which serializes
 * straight back to those same characters (lib/editor/reference.ts). Run it
 * between `manager.parse(markdown)` and `setContent(json)`; it is a pure
 * function, so the round trip is testable without an editor.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE
 * ---------------------------------
 * - `codeBlock` subtrees and text carrying the `code` mark. A ref in a fence
 *   is documentation about a ref, and the backticks must survive verbatim.
 * - Text carrying ANY other mark. @tiptap/markdown closes a mark before a
 *   non-text node and reopens it after, so a chip inside `**…**` would rewrite
 *   `**a @x b**` as `**a** @x **b**` — a different prompt for a change the
 *   author never made. Those refs stay literal text; `parseReferences` is
 *   purely lexical, so the compiler still resolves them, they just get no chip.
 */
import { parseReferences } from "@invisible-string/shared";
import type { JSONContent } from "@tiptap/core";

import { REFERENCE_NODE_NAME } from "./reference";

/** StarterKit's fenced-code node. Its content is literal by definition. */
const CODE_BLOCK_NODE_NAME = "codeBlock";

export function hydrateReferences(doc: JSONContent): JSONContent {
  return hydrateNode(doc);
}

function hydrateNode(node: JSONContent): JSONContent {
  if (node.type === CODE_BLOCK_NODE_NAME) return node;
  if (!Array.isArray(node.content)) return node;
  return { ...node, content: hydrateChildren(node.content) };
}

function hydrateChildren(children: JSONContent[]): JSONContent[] {
  const hydrated: JSONContent[] = [];
  // The grammar's lookbehind reaches one character back, which may sit in the
  // previous sibling — `manager.parse` is free to emit adjacent text nodes
  // that a schema-normalized document would have merged.
  let previousChar = "";

  for (const child of children) {
    if (typeof child.text === "string") {
      const marked = Array.isArray(child.marks) && child.marks.length > 0;
      hydrated.push(...(marked ? [child] : splitOnReferences(child, previousChar)));
      previousChar = child.text.slice(-1);
      continue;
    }
    hydrated.push(hydrateNode(child));
    previousChar =
      child.type === REFERENCE_NODE_NAME ? rawOf(child).slice(-1) : "";
  }

  return hydrated;
}

/**
 * Split one text node on its references, keeping the surrounding slices (and
 * their marks) intact. `previousChar` is prepended only to give the lookbehind
 * its context; matches that start inside it belong to the previous node.
 */
function splitOnReferences(
  node: JSONContent,
  previousChar: string,
): JSONContent[] {
  const text = node.text ?? "";
  const pieces: JSONContent[] = [];
  let cursor = 0;

  for (const ref of parseReferences(previousChar + text)) {
    const start = ref.start - previousChar.length;
    if (start < cursor) continue;
    if (start > cursor) pieces.push({ ...node, text: text.slice(cursor, start) });
    pieces.push({
      type: REFERENCE_NODE_NAME,
      attrs: { raw: ref.raw, kind: ref.kind },
    });
    cursor = ref.end - previousChar.length;
  }

  if (pieces.length === 0) return [node];
  if (cursor < text.length) pieces.push({ ...node, text: text.slice(cursor) });
  return pieces;
}

function rawOf(node: JSONContent): string {
  const raw = node.attrs?.raw;
  return typeof raw === "string" ? raw : "";
}
