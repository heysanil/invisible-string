# @invisible-string/design-tokens

Source of truth for the E1 design system tokens (design spec §E1: monochrome ink × liquid glass).

Consumed by `apps/web` via `@import "@invisible-string/design-tokens/tokens.css"`. Never fork or copy this file — extend it here so every app stays in sync. App-specific extensions live in each app's own CSS.

## Layout of `tokens.css`

`:root` (raw tokens) → `@layer base` (element defaults) → `@layer components` (glass surfaces, wash, interaction polish, tooltip, overlays, small primitives, chat surface, the Tiptap editor block, rendered markdown, scroll regions) → an **unlayered** resilience section (`@supports not (backdrop-filter)`, `prefers-reduced-transparency`, `prefers-reduced-motion`).

The resilience section is deliberately unlayered so it outranks every layered rule. Any new translucent surface must be added to those blocks so it degrades to `--surface-solid`.

### Interaction polish and the streaming caret

Two rules here are inherited by the whole product from a single place, and both have invariants that no browser will report:

- **`.lift` is the hover affordance for all 87 call sites.** Hover *swells* (`scale(1.01)`), it does not rise — the `translateY(-1px)` version was retired by `docs/superpowers/specs/2026-08-11-lifecycle-chat-and-copilot-polish-design.md` (D10). Retune it here, never per call site. The unlayered `prefers-reduced-motion: reduce` block sets `transform: none` on the hover and active states: the duration clamp beside it only makes a transition **instant**, so without that reset the element would still resize under the cursor.
- **`.stream-caret`'s negative end margin is the fix, not a nudge.** The caret is an inline-block, i.e. an atomic inline, so a line may break *before* it and drop it onto a line of its own at the right edge of a full line (Chrome: 13 of 301 widths for the site's own streaming strings). `margin-right: calc(-1 * (var(--caret-w) + var(--caret-gap)))` cancels its inline advance, so it never lengthens a line and the break is never taken — the ink paints into the container's padding instead. Keep the three values in sync; `white-space: nowrap` is not an alternative, since the break opportunity belongs to the element containing the text, not to the pseudo-element.

`apps/web` re-states the same caret invariant over Streamdown's own glyph in its `index.css` (a zero-width `::after` whose margins cancel). Guard for both, plus `.lift`: `tests/integration/e1-css-invariants.test.ts`.

### The editor block

`.tt-*` styles the Tiptap prompt editors (`apps/web/src/components/editor`): the focus ring lives on the wrapper (`.tt-host:focus-within`), `@ref` chips are ink-on-`--chip` mono pills with an amber wavy underline when unresolved, and floating surfaces (`.tt-suggest`, `.tt-ref-tooltip`) are solid by default and glass under `@supports (backdrop-filter)`. It replaced the `.cm-*` CodeMirror block — see `docs/superpowers/specs/2026-08-08-tiptap-editors-design.md`.

Two things about `.tt-*` are load-bearing and easy to undo by accident:

- **`.tt-host` is the scrollport.** It owns `display: flex` / `overflow: auto`, and that is the only reason `.tt-toolbar`'s `position: sticky` works. Giving `.tt-content` its own `overflow` creates a second scroll container and silently unsticks the toolbar.
- **The document grammar is rebuilt by hand.** Tailwind's preflight strips heading sizes, list markers and block margins, so every one of them is restated under `.tt-host .tiptap` — including `li > p { margin: 0 }`, without which ProseMirror's paragraph-inside-list-item double-spaces every bullet. Heading weight and tracking still come from the base layer's `h1`–`h4` rule.
