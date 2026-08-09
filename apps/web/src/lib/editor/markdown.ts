/**
 * Faithful markdown ↔ ProseMirror bridge for the prompt editors.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The stored value of a persona / instructions document IS the prompt: the
 * compiler writes `definition.persona` verbatim into `agent/instructions.md`
 * (packages/compiler/src/instructions.ts) and hashes it into the build cache
 * key, the world-DB name and the platform-JWT audience. A markdown round trip
 * that changes bytes therefore silently rewrites a user's live agent.
 *
 * Stock `@tiptap/markdown` is a markdown *normalizer*, not a fidelity-
 * preserving round-tripper. Measured against prompt-shaped input it:
 *   - DELETES standard HTML tags — `<output>…</output>` → `` (gone)
 *   - entity-encodes unknown ones — `<instructions>` → `&lt;instructions&gt;`
 *   - backslash-escapes every `\ ` ` * _ [ ] ~` in prose, so `{{user_name}}`
 *     becomes `{{user\_name}}` and `[INSERT NAME]` becomes `\[INSERT NAME\]`
 *   - DELETES tables outright (no table node in the schema)
 * All four are unacceptable for system prompts, which are full of XML-ish
 * tags, template placeholders and bracketed slots.
 *
 * THE FIX, IN THREE PARTS
 * -----------------------
 * 1. `promptMarked()` — a private `marked` instance whose `html` tokenizer
 *    emits a literal *text* token, so angle brackets are never HTML.
 * 2. `FaithfulMarkdownManager` — overrides the manager's text encoder so
 *    literal characters survive: no entity encoding, no blanket escaping.
 * 3. Verify-and-fallback — dropping all escaping would let text typed as
 *    literal `*stars*` re-parse as emphasis on reload. So `getMarkdown()`
 *    serializes faithfully, re-parses the result, and only keeps it when the
 *    document is unchanged; otherwise it returns the stock (escaped) output.
 *    Byte-fidelity when it is safe, correctness when it is not.
 *
 * COST: serialize+verify is super-linear (~1 ms at 1 k chars, ~9 ms at 6 k,
 * ~170 ms at 28 k). Callers MUST NOT serialize on every keystroke — see
 * `useMarkdownValue` in ../../components/editor/RichTextEditor.tsx, which
 * derives markdown on an idle debounce and exposes a synchronous `flush()`.
 */
import { Extension } from "@tiptap/core";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Marked } from "marked";

/**
 * Block-level HTML: `<` at the start of a line through the next blank line.
 * Mirrors marked's own `html` block rule closely enough to claim the same
 * span, which is the point — we want to claim it *before* marked can turn it
 * into an HTML token.
 */
const BLOCK_HTML = /^ {0,3}<[\s\S]+?(?:\n{2,}|\n*$)/;

/**
 * What GFM autolinking would claim: a bare URL or a bare email address.
 * Prompts are full of both ("escalate to support@acme.com"), and autolinking
 * rewrites them into `[text](href)` on serialize — a byte change to text the
 * author never touched. Disabling Tiptap's `autolink` only stops the editor's
 * own input rule; this is the parser half.
 */
const AUTOLINK_LIKE =
  /^(?:(?:https?:\/\/|www\.)[^\s<]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/** A GFM pipe table: header row, delimiter row, then zero or more body rows. */
const GFM_TABLE = /^ {0,3}\|?[^\n]*\|[^\n]*\n {0,3}\|? *:?-+:?[ :|-]*\n(?:[^\n]*\|[^\n]*(?:\n|$))*/;

/**
 * A `marked` instance that never produces HTML tokens.
 *
 * Returning `undefined` from a tokenizer override does NOT fall through to
 * marked's default (per marked's docs, only `false` does that) — it consumes
 * the input and emits nothing, which is how the stock setup loses `<output>`
 * blocks. We therefore return an explicit *text* token carrying the raw
 * source, so the angle brackets survive as literal characters.
 *
 * `text` drops the trailing blank line that `raw` must keep: `raw` has to
 * match the consumed span exactly or marked mis-advances, while the block
 * separator re-adds paragraph spacing during serialization.
 */
export function promptMarked(): Marked {
  const instance = new Marked();
  instance.use({
    tokenizer: {
      html(src: string) {
        const match = BLOCK_HTML.exec(src);
        if (!match) return false as never;
        return {
          type: "text",
          raw: match[0],
          text: match[0].replace(/\n+$/, ""),
        } as never;
      },
      // GFM autolink. Same treatment: claim the span as literal text so a
      // bare URL or email survives serialization unchanged. Explicit
      // `[label](href)` links still tokenize normally — only the implicit
      // rewrite is suppressed.
      url(src: string) {
        const match = AUTOLINK_LIKE.exec(src);
        if (!match) return false as never;
        return { type: "text", raw: match[0], text: match[0] } as never;
      },
    },
    // Same reason as `html`, but tables need a custom extension rather than a
    // tokenizer override: returning `false` from an override resumes marked's
    // default (which is exactly what we are trying to avoid), while `extensions`
    // are consulted *before* the built-in block rules. There is no table node
    // in the schema, so a tokenized table renders to nothing and the rows are
    // lost. A model reads a pipe table as text either way, so keeping the
    // source verbatim costs nothing.
    extensions: [
      {
        name: "rawTable",
        level: "block",
        start(src: string) {
          return src.match(/^ {0,3}\|/m)?.index;
        },
        tokenizer(src: string) {
          const match = GFM_TABLE.exec(src);
          if (!match) return undefined;
          return {
            type: "text",
            raw: match[0],
            text: match[0].replace(/\n+$/, ""),
          } as never;
        },
      },
    ],
  });
  return instance;
}

/**
 * Shared across every editor: building a `Marked` is not free, `use()` must
 * run exactly once per instance (repeated registration compounds), and the
 * parse path is synchronous so there is no cross-editor interleaving.
 */
const sharedMarked = promptMarked();

/**
 * A manager that leaves literal text alone.
 *
 * The base class runs every non-code text node through
 * `escapeMarkdownSyntax(encodeHtmlEntities(text))`. Both steps are private to
 * the class with no configuration hook, so overriding the one method that
 * calls them is the only available seam. The unescaped output is only ever
 * *used* when the verify pass below proves it re-parses identically.
 */
// @ts-expect-error `encodeTextForMarkdown` is private on the base class, so TS
// rejects the override (TS2415). The override is deliberate and runtime-valid —
// `private` is erased at runtime and the method is called through `this`. The
// round-trip corpus in __tests__/editor-markdown.test.ts fails loudly if a
// @tiptap/markdown bump ever renames or restructures this seam.
class FaithfulMarkdownManager extends MarkdownManager {
  encodeTextForMarkdown(text: string): string {
    return text;
  }
}

/**
 * Concatenate every text node in a JSONContent tree, depth first.
 *
 * Atom nodes that STAND FOR literal text contribute their `attrs.raw` — today
 * only the `@reference` chip (./reference.ts), whose `renderMarkdown` emits
 * that string verbatim. Such a node has no text child, so without this the
 * verify pass below would see the chip's characters appear from nowhere on
 * re-parse and fall back to the escaping serializer for the WHOLE document.
 */
function visibleText(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const record = node as {
    text?: unknown;
    content?: unknown;
    attrs?: { raw?: unknown } | null;
  };
  if (typeof record.text === "string") return record.text;
  if (typeof record.attrs?.raw === "string") return record.attrs.raw;
  if (!Array.isArray(record.content)) return "";
  return record.content.map(visibleText).join("");
}

/** The Markdown extension, wired to the prompt-safe parser. */
export const promptMarkdown = Markdown.configure({
  marked: sharedMarked as never,
});

/**
 * Installs the faithful serializer over the stock one.
 *
 * Priority is below `Markdown`'s default so this `onBeforeCreate` runs *after*
 * it and wins the `editor.markdown` / `editor.getMarkdown` assignment.
 * (`onCreate` is too late — Tiptap defers it, so the first `getMarkdown()`
 * would still hit the stock manager.)
 */
export const faithfulMarkdown = Extension.create({
  name: "faithfulMarkdown",
  priority: 50,

  onBeforeCreate() {
    const extensions = this.editor.extensionManager.baseExtensions;
    const faithful = new FaithfulMarkdownManager({
      extensions,
      marked: sharedMarked as never,
    });
    const stock = new MarkdownManager({ extensions, marked: sharedMarked as never });

    // @ts-expect-error `markdown` is assigned the same way by the base extension.
    this.editor.markdown = faithful;

    this.editor.getMarkdown = () => {
      const doc = this.editor.getJSON();
      const unescaped = faithful.serialize(doc);
      try {
        // Compare VISIBLE TEXT, not document JSON. `editor.getJSON()` is a
        // schema-normalized doc (every inline is wrapped in a block) while
        // `manager.parse()` returns raw JSONContent that may not be, so a
        // structural comparison never matches. Text equality is also the
        // property we actually care about: it stays equal when only block
        // wrapping differs, and diverges exactly when unescaped punctuation
        // would be re-read as markup — `Literal *stars*` losing its asterisks
        // to an emphasis mark. That is the one case worth escaping for.
        if (visibleText(faithful.parse(unescaped)) === visibleText(doc)) {
          return unescaped;
        }
      } catch {
        // A parse failure means we cannot prove the output is stable.
      }
      return stock.serialize(doc);
    };
  },
});
