# apps/site — landing + docs

Standalone static site: the public landing page (`/`) and an E1-styled docs
shell (`/docs/*`), built with Vite + React + TanStack Router and deployed to
**GitHub Pages**. It shares nothing at runtime with `apps/web` — no server, no
auth, no compose service — only the E1 design tokens (`packages/design-tokens`)
are shared, on purpose (AGENTS.md rule 5).

## Commands

```sh
bun run --cwd apps/site dev        # dev server (:5173 by default — pick a free port)
bun run --cwd apps/site build      # tsc --noEmit && vite build && cp dist/index.html dist/404.html
bun run --cwd apps/site preview    # serve the production build locally
bun run --cwd apps/site typecheck  # tsc --noEmit only
bun run --cwd apps/site test       # bun test (pure-logic specs only, see below)
```

No infra is required — no Postgres, no Docker, no `.env`. This app is **not**
part of `bun run dev` at the repo root; run it standalone.

`og.html` (at the app root, outside `public/` so it's never deployed) is the
source for the social card `public/og.png` — regenerate the PNG with a
1200×630 device-scale-1 browser screenshot of it after changing the headline
or subline.

## Build-time environment

These are set by CI (`.github/workflows/site.yml`) and never belong in a local
`.env` — see the note in the root `.env.example`.

| Variable | Set by | Purpose |
|---|---|---|
| `SITE_BASE` | `actions/configure-pages` (`base_path`) | Vite `base` + router `basepath`, normalized to `/` (root) or `/<repo>/` (project pages). Defaults to `/` for local dev. |
| `VITE_SITE_URL` | `actions/configure-pages` (`base_url`) | Canonical/OG/Twitter URL substituted into `index.html`. Defaults to `http://localhost:5173` locally so the substitution never breaks a local build. |
| `VITE_APP_URL` | unset by default | If set, the nav renders an "Open the app" CTA linking at it (e.g. the production SPA origin). Leave unset to hide the CTA. |

`configure-pages`'s outputs flip automatically once a custom domain is added
in Settings → Pages — no workflow edit needed either way.

## GitHub Pages setup (one-time)

1. Repo Settings → Pages → **Source: GitHub Actions**.
2. Push to `main` touching `apps/site/**`, `packages/design-tokens/**`, or the
   workflow file (or run the workflow manually via `workflow_dispatch`).
3. Custom domain: configure it in Settings → Pages, not by committing a
   `CNAME` file — GitHub manages that for you and `configure-pages` picks up
   the change automatically.
4. **Private repos need a paid GitHub plan** to serve Pages at all — public
   repos get Pages for free. Non-blocking for this repo's default (public)
   configuration, but worth knowing before flipping visibility.

## SPA-fallback / 404 tradeoff

The build script copies `dist/index.html` to `dist/404.html` so GitHub Pages
serves the SPA shell for any unmatched path (client-side routing works for
deep links like `/docs/concepts/pillars`). The tradeoff: GitHub Pages responds
with an actual HTTP **404 status** on those requests even though the body is
the app shell — fine for humans (the router immediately renders the right
page) but means crawlers/tools that check status codes literally will see
"not found" for deep links. Acceptable for a docs site with no server-rendered
pages; revisit only if SEO on deep docs URLs becomes a priority (would need
prerendering, not a Pages-native fix).

## MDX authoring

Docs content lives under `src/content/docs/**/*.mdx`. Each file needs
frontmatter:

```md
---
title: My Page
section: Getting started
order: 2
---
```

- `section` groups pages in the sidebar; `order` sorts within a section
  (ties break on `title`).
- The sidebar and prev/next pagination are derived entirely from this
  frontmatter (`src/lib/sidebar.ts`) — there's no separate nav config to keep
  in sync.
- Headings get `id`s via `rehype-slug`; the right-rail "On this page" TOC
  (`src/lib/toc.ts`) reads those ids back out of the rendered DOM.
- Slugs are the file path under `src/content/docs/`, minus the `.mdx`
  extension (e.g. `getting-started/overview.mdx` → `/docs/getting-started/overview`).
- New pages need no registry edit — `src/lib/docs.ts`'s `import.meta.glob`
  picks them up automatically on next build/dev-reload.
- Every stub gets a real title and 1–2 real intro paragraphs, even if the rest
  of the page is a designed "under construction" block — never ship a blank
  page.

## Design tokens

Shared tokens (`@invisible-string/design-tokens/tokens.css`) are law, exactly
as in `apps/web` — extend, never fork. Site-only extensions (the display type
scale, section spacing, anything landing/docs-specific) live in
`src/styles/site.css` and must never redefine a token the shared file already
owns.

## Future work

- **Docs search**: the docs shell ships without search on purpose — a dead
  search box is worse than none. Adding it (client-side index over the MDX
  frontmatter/body, or a hosted index) is deferred.
- **MDX code-splitting is a deliberate no-op**: `src/lib/docs.ts` eagerly
  globs frontmatter from the same modules it lazy-imports, so Rollup keeps
  every doc body in one chunk (`INEFFECTIVE_DYNAMIC_IMPORT` warnings at
  build). At ~14 short pages the single chunk is smaller than the plumbing
  to split it; revisit (frontmatter as a separate virtual module) if the
  docs grow into long-form content.

## Testing constraint: no MDX in tests

`bun test` cannot run Vite plugins, so nothing under `src/test/` or any
`*.test.ts(x)` file may import an `.mdx` file, a route file, or anything that
touches `import.meta.glob`. The MDX-dependent logic is deliberately split into
pure TypeScript (`src/lib/sidebar.ts`'s `buildSidebar`, `src/lib/toc.ts`'s
`extractToc`) that tests exercise directly with plain data/DOM fixtures.
Build-time correctness (does the MDX pipeline actually compile) is covered by
`vite build` in CI (`ci.yml`'s unit job + `site.yml`), not by `bun test`.
