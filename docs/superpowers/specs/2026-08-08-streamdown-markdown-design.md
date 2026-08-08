# Streamdown markdown rendering — design

**Date:** 2026-08-08
**Status:** Approved design, pending implementation plan
**Scope:** `apps/web` chat + copilot markdown rendering

Replace the hand-rolled markdown parser in `apps/web` with
[Streamdown](https://streamdown.ai), a streaming-oriented React markdown
renderer. `apps/site` is **out of scope** — it compiles authored `.mdx` at build
time via `@mdx-js/rollup`, a different pipeline that Streamdown does not serve.

---

## 1. Motivation

`apps/web/src/lib/chat/markdown.ts` is a 172-line regex parser producing a typed
AST (`MdBlock` / `MdInline`), rendered by `components/chat/Markdown.tsx`. It
supports headings (h1–h4), paragraphs, fenced code, flat lists, blockquotes,
horizontal rules, and inline code/strong/em/link.

It does **not** support tables, GFM task lists, nested lists, images,
strikethrough, autolinks, footnotes, syntax highlighting, or math. Agents emit
all of these; today they are dropped or mangled.

Four goals, all weighted equally:

1. **Richer markdown coverage** — tables and nested lists above all.
2. **Syntax-highlighted code** — Shiki, replacing the flat monospace block.
3. **Better streaming behavior** — "remend" handling of incomplete markdown, so
   a half-arrived `**bold` or table does not flash raw syntax mid-stream.
4. **Stop maintaining a parser** — the regex parser is a standing liability.

---

## 2. Dependencies

Added to `apps/web/package.json`:

| Package | Version | Loading |
|---|---|---|
| `streamdown` | `^2.5.0` | static |
| `@streamdown/code` | `^1.1.1` | static |
| `@streamdown/mermaid` | `^1.0.2` | **dynamic** — see §5 |

React 19 and Tailwind v4 are already present; there is no framework work.

`@streamdown/code` statically imports `shiki` and `shiki/engine/javascript`. It
uses `createJavaScriptRegexEngine`, so there is **no oniguruma WASM asset**.
Shiki's core is eager; per-language grammars and themes are lazy `import()`
thunks, so Vite emits ~200+ small chunks and fetches only the languages that
appear in agent output. Expect a measurably slower `bun run --cwd apps/web
build`, which affects the CI `unit` lane.

No `streamdown/styles.css` import — that stylesheet contains only the
`animated`-mode keyframes, which this design does not use.

---

## 3. Token bridge (`apps/web/src/index.css`)

Streamdown's markup is written against shadcn semantic tokens. Verified counts
in `streamdown/dist`: `text-muted-foreground` ×21, `bg-muted` ×19,
`border-border` ×15, `bg-background` ×15, `text-foreground` ×14, `text-primary`
×3, `bg-primary` ×2, `text-primary-foreground` ×1, `border-muted-foreground` ×1.
**None exist in this theme.** A sweep for `secondary`/`accent`/`ring`/`popover`/
`card`/`destructive` found zero occurrences, so the list below is complete.

Tailwind v4 compiles `text-muted-foreground` to `color: var(--color-muted-foreground)`.
Undefined, that is invalid at computed-value time and falls back to `inherit`
for color — so the failure is **silent and partial**: prose looks roughly fine
while borders vanish and code-block chrome goes flat.

```css
@source "../../../node_modules/streamdown/dist/*.js";

@theme inline {
  /* Streamdown's markup is written against shadcn semantic tokens. Alias them
     onto the E1 ink scale so it inherits the design system instead of
     resolving to undefined custom properties. Do NOT delete these as
     "unused" — nothing in this repo references them by name. */
  --color-foreground:         var(--ink);
  --color-muted-foreground:   var(--ink-3);
  --color-background:         var(--surface-solid);
  --color-muted:              var(--chip);
  --color-border:             var(--hairline);
  --color-primary:            var(--ink);
  --color-primary-foreground: #ffffff;
}
```

Only `streamdown/dist` needs an `@source` entry — both plugin dists are pure
logic with zero Tailwind classes.

**The `@source` path is unverified.** It assumes Bun hoists to the root
`node_modules`. Peer ranges are clean (`react ^18||^19`), so hoisting should
hold, but confirm after `bun install` and adjust the depth if the packages land
in `apps/web/node_modules`.

The app is light-only — zero `dark:` usages in `apps/web` — so Streamdown's
three `dark:` variants are inert and no dark palette work is needed.

---

## 4. `components/chat/Markdown.tsx`

Public API gains one prop; both call sites stay trivial.

```tsx
export interface MarkdownProps {
  text: string;
  className?: string;
  /** Drives the streaming caret and suppresses copy controls mid-stream. */
  streaming?: boolean;
}
```

### 4.1 Module-scope constants — required, not stylistic

Streamdown's outer memo comparator compares `shikiTheme`, `plugins`, and
`linkSafety` **by identity**; its inner `Block` memo compares `components`
values key-by-key by identity. Inline object/array literals mean the memo never
bails, and a fresh `shikiTheme` array recreates the context value — so **every
code block re-highlights on every streamed token**. That defeats the per-block
rendering that is the main reason to adopt Streamdown.

Every non-scalar prop must be hoisted to module scope: `SHIKI_THEMES`,
`CONTROLS`, `LINK_SAFETY`, `COMPONENTS`, `MERMAID_OPTIONS`. Component overrides
must be module-level function declarations, never inline arrows.

### 4.2 Configuration

| Prop | Value | Why |
|---|---|---|
| `mode` | `"streaming"` | remend handling of incomplete markdown |
| `isAnimating` | `streaming` | caret + suppresses copy controls mid-stream |
| `caret` | `"block"` | see §6 |
| `shikiTheme` | `["min-light", "min-dark"]` | §4.4; dark half inert |
| `plugins` | `{ code }`, mermaid merged in when loaded | §5 |
| `lineNumbers` | `false` | defaults **true**; current blocks have none |
| `linkSafety` | `{ enabled: false }` | §4.5 |
| `controls` | copy-only, see below | matches today's affordance |

```ts
const CONTROLS = {
  code:  { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: false, fullscreen: false, panZoom: false },
} as const;
```

`controls.table.fullscreen` and all four `controls.mermaid.*` default **true**.
Fullscreen is a portal modal and panZoom is a grab/zoom surface — neither is E1
styled, so both are off until someone designs them.

The container needs explicit spacing: Streamdown's wrapper is `space-y-4`,
against the current `my-1.5` rhythm. Streamdown uses `tailwind-merge`, so a
`className` of `"space-y-2 text-sm text-ink [overflow-wrap:anywhere]"` wins.

### 4.3 Component overrides — exactly four keys

**`inlineCode` — never `code`.** Streamdown's default `code` component is the
whole dispatcher: it branches on a `data-block` prop, and the block branch does
language detection, custom renderers, **the mermaid dispatch**, and the Shiki
`CodeBlock`. Overriding `code` destroys fenced code, Shiki, and mermaid at once.
`Components` exposes a dedicated `inlineCode` key (`index.d.ts:62`) that
receives only inline code.

**Never override `pre`.** Its default is
`({children}) => cloneElement(children, {"data-block": "true"})` — it exists
solely to stamp the marker driving the inline/block dispatch. Any `pre` override
that omits the `cloneElement` makes every fenced block render as inline code.

| Key | Behavior |
|---|---|
| `inlineCode` | `.mono-chip` — the E1 signature treatment |
| `a` | E1 underline decoration, `target="_blank" rel="noreferrer noopener"` |
| `h1`–`h6` | `<p role="heading" aria-level={min(n + 2, 6)}>` |
| mermaid `errorComponent` | via `MERMAID_OPTIONS`; the default card is hardcoded `bg-red-50 text-red-700`, an E1 rule-5 violation |

The heading override **preserves an existing deliberate a11y decision**
(`Markdown.tsx:104-116`). Agent replies are untrusted content injected into a
page with its own heading outline; a real `<h1>` from an agent would hijack the
document structure and break screen-reader landmark navigation. The old parser
stopped at `####`, but Streamdown parses h5/h6, so the offset must be **capped
at 6** — `aria-level` of 7 or 8 is legal ARIA but inconsistent.

The custom `a` must defensively handle two hrefs the default anchor
special-cases: `href === "streamdown:incomplete-link"` (remend's mid-stream
marker, which sets `data-incomplete`) and `undefined`. Neither should render a
dead link.

### 4.4 Shiki theme

`min-light` — near-monochrome, mostly grays with one or two heavily desaturated
accents. Syntax highlighting is inherently colorful, which sits in tension with
E1 rule 5 ("color only as meaning"); `min-light` preserves that restraint while
still differentiating tokens, which is the point of adding highlighting. The
`[ThemeInput, ThemeInput]` tuple requires a dark half — `min-dark`, inert here.

### 4.5 Link safety

`linkSafety` defaults to `{ enabled: true }`, under which the default anchor
renders external links as a **`<button>`** that opens a confirmation modal. The
custom `a` override replaces that component and so disables the feature
implicitly. Pass `linkSafety={{ enabled: false }}` **explicitly** so behavior
does not silently flip if the override is ever removed.

---

## 5. Mermaid — lazy, not static

`@streamdown/mermaid/dist/index.js` line 1 is `import n from 'mermaid'` —
**static**, pulling the multi-MB library in. `Markdown.tsx` is reachable from
`RunMessage` → the chat route → the app entry, so a static plugin import lands
mermaid in the entry chunk.

(For the record: `streamdown` core does **not** import mermaid — verified,
`grep -c "from 'mermaid'"` → 0. Its internal `import('./mermaid-*.js')` is a
60-byte re-export of streamdown's own `Mermaid` component, not the library.)

Ship `plugins = { code }` at entry and load the mermaid plugin via dynamic
`import("@streamdown/mermaid")` into state, merging it into a memoized `plugins`
object once resolved. Vite splits mermaid into its own chunk, fetched only when
needed. Streamdown's `Mermaid` component recovers when the plugin arrives late —
its effect deps include the plugin read from context, so it re-renders out of
the "plugin unavailable" state.

The trigger for the dynamic import is an implementation detail left open:
either on first mount of a `Markdown` instance, or gated on detecting a
` ```mermaid ` fence in `text`. The latter is cheaper and preferred if it does
not complicate the render path.

---

## 6. Caret

Streamdown's caret is a **static text glyph** injected as
`[&>*:last-child]:after:content-[var(--streamdown-caret)]`, with the var set as
an inline style on the wrapper. It does **not** blink. Today's `.stream-caret`
is a blinking 7×13px ink block (`tokens.css:318-334`) — losing the blink is a
visible E1 motion change.

Decision: use Streamdown's `caret="block"` for its correct inline placement (at
the true end of streamed text, rather than a block-level `::after` trailing the
whole reply), then restore the blink with app CSS in `apps/web/src/index.css`
keyed off the Streamdown wrapper.

Two behaviors to know: the caret is **suppressed while the last block is an
incomplete code fence**, and the caret classes are Tailwind arbitrary variants
living in `streamdown/dist` — so without the `@source` entry the caret silently
never appears.

**`.stream-caret` and `@keyframes caret-blink` stay in `tokens.css`.**
`apps/site` uses the class at `landing/Copilot.tsx:55` and
`landing/AgentVignette.tsx:138`, and imports the same tokens file. Only the two
`apps/web` call sites stop using it.

---

## 7. Call sites

| File | Change |
|---|---|
| `chat/RunMessage.tsx:97` | drop the `cn(...streaming && "stream-caret")` wrapper; pass `streaming={run.reply?.streaming}` to `<Markdown>` |
| `copilot/CopilotDock.tsx:391` | same; keep the `mr-2` wrapper and the `className="text-[13px]"` (survives twMerge) |

---

## 8. Deletions

- `apps/web/src/lib/chat/markdown.ts` (172 lines) — imported only by
  `Markdown.tsx`, verified repo-wide.
- `apps/web/src/__tests__/markdown.test.ts` (43 lines) — tests the deleted parser.

---

## 9. Tests

**Three** files mount the renderer under happy-dom, all in scope:
`chat-thread.test.tsx`, `copilot-dock.test.tsx`, `integrations-ui.test.tsx`
(`:19`, `:159`).

Environment notes:

- Streaming mode pushes block-state updates through `useTransition`, so
  synchronous `getByText` on reply text may need `findByText`.
- Mermaid rendering is gated on `IntersectionObserver` + `requestIdleCallback`;
  under happy-dom diagrams simply will not render. **Do not assert on them.**
- Shiki resolves asynchronously and returns `null` on first call, rendering
  plain code until tokens arrive.

New `__tests__/markdown-render.test.tsx`, selecting on the `data-streamdown="…"`
attributes present on virtually every element (`inline-code`, `heading-N`,
`table`, `link`, `mermaid`, `code-block`):

- tables, task lists, nested lists, strikethrough render
- inline code carries `.mono-chip`
- headings are `role="heading"` at the offset level, capped at 6
- links carry `rel="noreferrer noopener"`
- caret present only while `streaming` — **the fixture must not end mid-fence**

Caret test hook: there is no data attribute. Assert the wrapper's inline style
contains `--streamdown-caret`, which is present iff `caret && isAnimating &&`
the last block is not an open fence. `chat-thread.test.tsx:277`'s `.stream-caret`
assertion moves to this.

`e2e/specs/a11y.e2e.ts` axe-scans `/chat`. No e2e spec asserts markdown DOM, but
the new control surfaces (code-block header buttons, table copy dropdown) enter
the axe tree once a seeded reply renders, and some have only `title=` for an
accessible name. Run the e2e lane and budget for aria fixes.

---

## 10. Recorded posture changes

Deliberate, accepted, and recorded here so they are decisions rather than
accidents.

**Raw HTML: structurally impossible → sanitizer-filtered.** The old parser's
closed AST union meant HTML could not reach the DOM by construction. Streamdown
parses real HTML and filters it with `rehype-harden` + `rehype-sanitize`.
Security now depends on a dependency's allowlist rather than on our type system.

**Images now render.** The old parser had no `![...]` support at all. Sanitize's
default schema permits http/https `<img>` and harden is configured
`allowedImagePrefixes: ["*"]`. Agent replies are influenced by untrusted
webhook/Slack/tool payloads, so a prompt-injected image URL becomes a tracking
pixel that leaks viewer IP and load timing to an arbitrary host from inside the
authenticated app. **Accepted** — agents producing charts and screenshots is
worth more than the beacon risk. Revisit with `disallowedElements={["img"]}` or
an origin-scoped `urlTransform` if abuse appears.

**GFM autolinks** make bare URLs clickable, and `tel:` hrefs are newly permitted
(Streamdown extends the sanitize schema).

`javascript:` links remain stripped — `defaultUrlTransform` plus sanitize
preserve the old `SAFE_LINK` behavior.

---

## 11. Documentation (same commit)

`AGENTS.md` gains two entries under *Constraints that will bite you*:

1. The `@source "…/streamdown/dist/*.js"` requirement — without it Streamdown
   renders unstyled and the caret never appears, **silently**.
2. The shadcn→E1 token bridge — seven `@theme inline` tokens that nothing in
   this repo references by name and that must not be deleted as "unused".

Rule 5's E1 note should mention that `apps/web` markdown chrome is Streamdown's,
themed through the bridge rather than forked.

---

## 12. Open items for the implementation plan

1. `@source` path depth under Bun workspace hoisting — verify after `bun install`.
2. The dynamic-import trigger for the mermaid plugin (§5).
3. Bundle-size delta from `bun run --cwd apps/web build`, and the build-time
   increase from ~200+ shiki chunks in the CI `unit` lane.
4. Whether the E1 blink CSS (§6) can key off a stable Streamdown wrapper
   selector, or needs a wrapper element of our own.
