# Tiptap prompt editors — Design (2026-08-08)

Supersedes the CodeMirror 6 editor decision in `docs/superpowers/specs/2026-07-02-invisible-string-design.md` (§Product decisions, "Builder": *"CodeMirror 6 instructions with `@` autocomplete"*). Everything else in that spec still binds.

---

## 1. Decision

Every prompt-authoring surface in `apps/web` moves from a **CodeMirror 6 markdown source editor** to a **Tiptap 3 WYSIWYG editor**. `@references` become atomic chips. The chat and copilot composers move too.

**The stored value does not change.** It stays a plain markdown string. Tiptap is a view layer over it — no schema change, no migration, no `COMPILER_VERSION` bump, no golden-fixture regeneration.

### Why the storage format is non-negotiable

`packages/compiler/src/instructions.ts:30` writes `definition.persona` verbatim into `agent/instructions.md`, and `packages/compiler/src/hash.ts:67` folds that string into the content hash that keys the build cache, the per-version world database, and the platform-JWT audience. `parseReferences` (`packages/shared/src/workflow-config.ts:252`) is a purely lexical, **character-offset** grammar with five independent consumers: the compiler, the dispatcher (`packages/shared/src/render.ts:84`), both copilot validators, and the editor. Copilot writes are whole-document string replacements previewed by a **line-based** diff (`apps/web/src/lib/copilot/diff.ts`).

A markdown round trip that changes one byte therefore silently rewrites a user's live agent prompt *and* re-keys its build identity.

---

## 2. Surfaces

| Tier | Surface | Chrome |
|---|---|---|
| Document | Agent **Persona** (`agents/PersonaSection.tsx`) | glass toolbar + Rich/Markdown toggle |
| Document | Workflow **Instructions** (`builder/InstructionsEditor.tsx`) | + `@reference` chips & suggestions |
| Document | Skill **Instructions** (`context/SkillEditor.tsx`) | glass toolbar + toggle, read-only for members |
| Composer | Chat **Composer** (`chat/Composer.tsx`) | none — Enter sends, Shift+Enter newlines |
| Composer | **Copilot dock** input (`copilot/CopilotDock.tsx`) | none |

User chat bubbles (`chat/RunMessage.tsx`) now render through `<Markdown>`; they were `whitespace-pre-wrap` plain text, which would have echoed literal `**asterisks**` back at the author.

**Deliberately excluded.** Agent and skill **descriptions** stay plain `Input`/`Textarea`: they are routing metadata rendered raw in `AgentRail`, the agents grid, `SkillList` and the compiled context appendix, so markdown there leaks asterisks into list views. **Test-run inputs** (`builder/TestRunPopover.tsx`) stay plain: they simulate an *external* trigger payload — a Slack message, a webhook JSON body, an end-user form submission — and rendering them rich would misrepresent what a real trigger delivers.

---

## 3. The faithful markdown bridge

`@tiptap/markdown` is a markdown **normalizer**, not a fidelity-preserving round-tripper. Measured against prompt-shaped input, stock configuration passed **6 of 16** cases:

| Input | Stock output |
|---|---|
| `<output>\nJSON only.\n</output>` | `JSON only.` — tags **deleted** |
| `<instructions>` | `&lt;instructions&gt;` — entity-encoded |
| `Use {{user_name}}` | `Use {{user\_name}}` |
| `Use [INSERT NAME]` | `Use \[INSERT NAME\]` |
| a GFM pipe table | `""` — **deleted** |

All four failure modes are disqualifying for system prompts, which are full of XML-ish tags, template placeholders and bracketed slots. `apps/web/src/lib/editor/markdown.ts` fixes them in three parts:

1. **`promptMarked()`** — a private `marked` instance whose `html` tokenizer emits a literal *text* token, plus a `rawTable` block extension doing the same for pipe tables and a `url` override doing the same for GFM autolinks. Returning `undefined` from a marked tokenizer does **not** disable it (only `false` falls through to the default) — it consumes the span and emits nothing, which is precisely how stock configuration loses `<output>` blocks. The autolink override is the parser half of a two-sided problem: Tiptap's `autolink: false` only stops the editor's own input rule, so without it a bare `support@acme.com` in a prompt serializes back as `[support@acme.com](mailto:support@acme.com)`.
2. **`FaithfulMarkdownManager`** — the base class runs every non-code text node through `escapeMarkdownSyntax(encodeHtmlEntities(text))`, both private with no configuration hook. Overriding the single method that calls them is the only available seam. It must install in an extension's **`onBeforeCreate`**, not `onCreate` — Tiptap defers `onCreate`, so the first `getMarkdown()` would still hit the stock manager.
3. **Verify-and-fallback** — dropping all escaping would let text typed as literal `*stars*` re-parse as emphasis on reload. `getMarkdown()` serializes faithfully, re-parses, and keeps the result only when the **visible text** is unchanged; otherwise it returns the stock escaped output. Byte-fidelity when safe, correctness when not.

The comparison is on visible text, not document JSON, because `editor.getJSON()` is schema-normalized (inlines wrapped in blocks) while `manager.parse()` returns raw JSONContent that may not be — a structural comparison never matches. Text equality is also the property that matters: it survives block-wrapping differences and diverges exactly when unescaped punctuation would be re-read as markup.

**Result: 29/29 round-trip corpus tests pass** (`apps/web/src/__tests__/editor-markdown.test.ts`). That corpus is the load-bearing guard of this whole design — it fails loudly if a `@tiptap/markdown` bump moves the seam.

### Accepted residuals

- Tables are preserved as **literal pipe text**, not editable table nodes. Zero byte loss, no new dependency, and a model reads them identically.
- `&lt;tag&gt;` decodes to `<tag>` on round trip. Benign for a prompt — arguably an improvement — but it is a byte change.
- Setext headings normalize to ATX, `*` bullets to `-`, and runs of blank lines collapse. Cosmetic, and only on documents the user actually edits.
- Escaping still applies to the rare document where unescaped output would be unstable.

---

## 4. Performance: markdown is derived on a debounce

Serialize+verify is super-linear — **~1 ms** at 1 k chars, **~9 ms** at 6 k, **~170 ms** at 28 k — because the faithful serializer re-parses its own output. Running that per keystroke would stall typing in a long persona.

So `RichTextEditor` **debounces `onChange`** (180 ms idle) and exposes a synchronous `flush()` on its ref. This is the one place the new editor's contract differs from `CodeMirrorMarkdown`, which fired per keystroke. Callers needing the value immediately — publish, test-run, mode switch, Enter-to-send — call `flush()`. Character counters and diagnostics run on the debounced value.

---

## 5. `@references` as atomic chips

A Tiptap node (`reference`, `inline`, `atom`) with attrs `{ raw, kind }` whose `renderMarkdown` returns `node.attrs.raw` verbatim — that is what guarantees the wire format. On load, a pure `hydrateReferences` transform splits text nodes on `parseReferences` matches, **skipping code blocks and the `code` mark** so refs inside code stay literal, matching what serializes back out. Live `ReferenceSources` sit in ProseMirror plugin state updated by a transaction meta, mirroring the `StateField`/`StateEffect` pattern the CodeMirror implementation used — the editor is never torn down when sources change.

`apps/web/src/lib/builder/references.ts` (`referenceOptions`, `referenceProblem`, `slugifyName`, `unresolvedReferences`) is editor-agnostic and carries over unchanged.

The chip node also forbids marks (`marks: ""`). `@tiptap/markdown` serializes a mark spanning a non-text node by **closing it before the node and reopening after**, so a bold chip would turn `**a @x b**` into `**a** @x **b**` — a byte change. Hydration therefore leaves refs inside formatted text as literal characters: still lexically a reference to the compiler, just without a chip.

**Known divergences,** both benign because the safety net sits downstream: a `@ref` inside inline code or inside formatted text gets no chip and no unresolved underline, though `parseReferences` server-side still counts it. Document-level diagnostics (`lib/builder/diagnostics.ts`, which run over the serialized markdown) remain the source of truth for warnings, so nothing slips past publish.

---

## 6. Dependencies

Added to `apps/web`, **pinned exactly** — Tiptap's peer ranges are exact and the repo mandates exact pins: `@tiptap/{react,core,pm,starter-kit,markdown,extensions,extension-mention,suggestion}@3.29.2`, plus `marked@17.0.6` (promoted from transitive because we construct our own instance; if a future Tiptap bump moves to `marked@18`, two copies would coexist and `Markdown.configure({ marked })` would receive the wrong one — the corpus test catches it).

Removed: all six `@codemirror/*` packages and the `.cm-*` token block. No new workspace, so `infra/docker/*.Dockerfile` is untouched.

**Bundle:** the Tiptap chunk is 447 kB / **140 kB gzip**, replacing a CodeMirror chunk of 539 kB / **186 kB gzip** — the agent, workflow and skill routes get ~46 kB gzip lighter.

The chat route is the exception: it never loaded CodeMirror, so a static import there would have put 140 kB gzip on the critical path of the app's landing surface. Its composer therefore loads the editor through `components/editor/LazyComposerEditor.tsx`, the same `Suspense` pattern `builder/InstructionsPanel.tsx` already used. **Splitting the component alone measured as no improvement** — `CHAT_EXTENSIONS` statically pulls StarterKit, ProseMirror and the markdown bridge, so the profile had to move behind the same dynamic import (hence `ComposerEditor.tsx`). The boundary is invisible to callers: `LazyComposerEditor` hands out a stable proxy handle on first render so `flush()` returns `""` rather than `undefined` before the chunk resolves, and a `focus()` arriving during the fallback is queued and replayed on attach. Verified by `_app.chat-*.js` carrying no reference to the editor chunk, and the chunk being absent from `index.html`'s modulepreload list.

---

## 7. Styling

**The `@` menu is portaled to `document.body` and positioned `fixed`.** `.tt-host` is `overflow: auto` — deliberately, because it is the scrollport that makes `.tt-toolbar`'s `position: sticky` work — so a popup rendered inside the editor DOM is clipped at the editor's bottom edge, exactly where the caret usually sits. `.tt-suggest`'s `z-index: 90` (above panels at 40–50 and the overlay scrim at 80, below toasts at 100) assumes that placement. The cost is that `fixed` does not follow a scrolling ancestor, so the menu re-places on capture-phase `scroll` and on `resize` while open. This is the one place the editor deviates from `ui/Popover`, which stays inline precisely because it has no clipping scrollport to escape.

Editor chrome lives in `packages/design-tokens/tokens.css` as a `.tt-*` block replacing the `.cm-*` block — the README forbids forking styles into components. It carries over the `:focus-within` outline pattern, `--chip` reference pills, the `--warn-ink` wavy underline for unresolved refs, and the glass `@supports (backdrop-filter)` treatment for the suggestion dropdown, plus the existing `prefers-reduced-transparency` / `prefers-reduced-motion` fallbacks.

---

## 8. Testing

Tiptap runs headlessly under happy-dom in `bun test` — unlike CodeMirror, which the repo excludes from DOM tests as flaky — so the corpus constructs real `Editor` instances. Pure logic (markdown bridge, reference hydration and serialization) is tested directly.

**Merged with the Streamdown renderer (#10).** That change deleted the in-house `lib/chat/markdown.ts` parser, which this design had originally capped the chat profile against — Streamdown parses full GFM, so the cap is gone and the two profiles now differ only in `@reference` chips. Two consequences for tests: Streamdown suspends while Shiki loads, so anything asserting on rendered markdown must `await`; and it renders emphasis as a styled `span` rather than `<strong>`, so assertions state the outcome (the author never sees raw `**`) instead of pinning a tag. The author's own bubble still renders through the same component, inverted for the ink surface by `.md-on-ink` redefining the ink scale for the subtree — which works unchanged against Streamdown because it colors with the same token-backed utilities.

E2E drives the editors by `getByRole("textbox", { name })`, so `editorProps.attributes` sets `aria-label`, `aria-multiline` and `role` explicitly on the ProseMirror element; the accessible names `"Persona"`, `"Instructions editor"` and `"Skill instructions (markdown)"` are preserved exactly.
