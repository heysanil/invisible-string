# @invisible-string/design-tokens

Source of truth for the E1 design system tokens (design spec §E1: monochrome ink × liquid glass).

Consumed by `apps/web` via `@import "@invisible-string/design-tokens/tokens.css"`. Never fork or copy this file — extend it here so every app stays in sync. App-specific extensions live in each app's own CSS.

## Layout of `tokens.css`

`:root` (raw tokens) → `@layer base` (element defaults) → `@layer components` (glass surfaces, wash, interaction polish, tooltip, overlays, small primitives, chat surface, the Tiptap editor block, rendered markdown, scroll regions) → an **unlayered** resilience section (`@supports not (backdrop-filter)`, `prefers-reduced-transparency`, `prefers-reduced-motion`).

The resilience section is deliberately unlayered so it outranks every layered rule. Any new translucent surface must be added to those blocks so it degrades to `--surface-solid`.

### The editor block

`.tt-*` styles the Tiptap prompt editors (`apps/web/src/components/editor`): the focus ring lives on the wrapper (`.tt-host:focus-within`), `@ref` chips are ink-on-`--chip` mono pills with an amber wavy underline when unresolved, and floating surfaces (`.tt-suggest`, `.tt-ref-tooltip`) are solid by default and glass under `@supports (backdrop-filter)`. It replaced the `.cm-*` CodeMirror block — see `docs/superpowers/specs/2026-08-08-tiptap-editors-design.md`.

Two things about `.tt-*` are load-bearing and easy to undo by accident:

- **`.tt-host` is the scrollport.** It owns `display: flex` / `overflow: auto`, and that is the only reason `.tt-toolbar`'s `position: sticky` works. Giving `.tt-content` its own `overflow` creates a second scroll container and silently unsticks the toolbar.
- **The document grammar is rebuilt by hand.** Tailwind's preflight strips heading sizes, list markers and block margins, so every one of them is restated under `.tt-host .tiptap` — including `li > p { margin: 0 }`, without which ProseMirror's paragraph-inside-list-item double-spaces every bullet. Heading weight and tracking still come from the base layer's `h1`–`h4` rule.
