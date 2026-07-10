# apps/site — landing + docs

Standalone static site: the public landing page (`/`) and an E1-styled docs
shell (`/docs/*`), built with Vite + React + TanStack Router and deployed to
**Cloudflare Workers** (an assets-only Worker — static hosting, no compute) at
<https://invisiblestring.io>. It shares nothing at runtime with `apps/web` — no
server, no auth, no compose service — only the E1 design tokens
(`packages/design-tokens`) are shared, on purpose (AGENTS.md rule 5).

## Commands

```sh
bun run --cwd apps/site dev        # dev server (:5173 by default — pick a free port)
bun run --cwd apps/site build      # tsc --noEmit && vite build
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
| `SITE_BASE` | nobody (local-only) | Vite `base` + router `basepath`. Defaults to `/`; CI never sets it — the deployed site always serves at the domain root. |
| `VITE_SITE_URL` | `site.yml`, fixed to `https://invisiblestring.io` | Canonical/OG/Twitter URL substituted into `index.html`. Defaults to `http://localhost:5173` locally so the substitution never breaks a local build. |
| `VITE_APP_URL` | unset by default | If set, the nav renders an "Open the app" CTA linking at it (e.g. the production SPA origin). Leave unset to hide the CTA. |

## Cloudflare Workers deploy

The site deploys as an **assets-only Worker** (`wrangler.jsonc` — name
`invisible-string-site`, assets from `dist/`, no server code) with a
custom-domain route for `invisiblestring.io`. CI (`site.yml`) does it all:

- **Push to `main`** touching `apps/site/**`, `packages/design-tokens/**`, or
  the workflow → build + `wrangler deploy` (production).
- **Pull request** touching the same paths → build + `wrangler versions
  upload --preview-alias <branch>` → the per-commit and per-branch preview
  URLs (`<alias>-invisible-string-site.<subdomain>.workers.dev`) are posted
  as a PR comment. Fork PRs skip this (no secrets).

wrangler itself is deliberately **not** a workspace dependency — the root
lockfile covers all workspaces, so it would inflate every prod Docker image's
`bun install --frozen-lockfile`. CI pins it inline (`npx -y wrangler@<x.y.z>`);
`cloudflare/wrangler-action` is unusable here because its fallback
`npm i wrangler` runs inside the working directory and npm chokes on the Bun
`workspace:*` protocol in `package.json`.

### One-time setup

1. Create a Cloudflare API token from the **"Edit Cloudflare Workers"**
   template on the account that owns the `invisiblestring.io` zone.
2. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Confirm the apex of `invisiblestring.io` has no conflicting DNS record
   (custom-domain creation refuses to overwrite an existing CNAME).
4. After the first successful deploy, disable GitHub Pages in repo settings
   (Settings → Pages) — the old Pages deployment is superseded.

## SPA fallback

`not_found_handling: "single-page-application"` in `wrangler.jsonc` serves
the app shell with an HTTP **200** for any path that doesn't match a static
asset, so deep links like `/docs/concepts/pillars` work for humans *and*
status-code-checking crawlers. This replaces (and improves on) the old
GitHub Pages `404.html` copy hack, which served the shell with a 404 status.

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

<!-- preview-loop test: safe to remove -->
