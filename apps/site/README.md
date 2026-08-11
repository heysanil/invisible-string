# apps/site — landing + docs

Standalone static site: the public landing page (`/`) and an E1-styled docs
shell (`/docs/*`), built with Vite + React + TanStack Router and deployed to
**Cloudflare Workers** (an assets-only Worker — static hosting, no compute) at
<https://invisiblestring.io>. It shares nothing at runtime with `apps/web` — no
server, no auth, no compose service — only the E1 design tokens
(`packages/design-tokens`) are shared, on purpose (AGENTS.md rule 5).

Every route is **prerendered to its own static HTML file at build time and
hydrated into the same SPA afterwards**. `dist/docs/concepts/agents/index.html`
is a real file carrying the page's real content and its own
title/description/canonical/OG/JSON-LD — a crawler that runs no JavaScript
reads the whole page. React then adopts that markup (`hydrateRoot`) and client
routing takes over. See [SEO and prerendering](#seo-and-prerendering).

## Commands

```sh
bun run --cwd apps/site dev           # dev server (:5173 by default — pick a free port)
bun run --cwd apps/site build         # tsc --noEmit && build:client && build:server && prerender
bun run --cwd apps/site build:client  # vite build → dist/ (incl. the dist/index.html template)
bun run --cwd apps/site build:server  # vite build --ssr src/entry-server.tsx --outDir .ssr
bun run --cwd apps/site prerender     # bun scripts/prerender.ts — .ssr + dist/index.html → dist/**
bun run --cwd apps/site typecheck     # tsc --noEmit only
bun run --cwd apps/site test          # bun test (pure-logic specs only, see below)
```

No infra is required — no Postgres, no Docker, no `.env`. This app is **not**
part of `bun run dev` at the repo root; run it standalone.

Two things about the build steps that are easy to get wrong:

- **`.ssr/` is a sibling of `dist/`, never a child**, and is gitignored.
  Everything under `dist/` is uploaded to Cloudflare verbatim; the SSR bundle
  must never be. If you change `build:server`'s `--outDir`, keep it outside
  `dist/`.
- **`prerender` is not a re-runnable step.** It reads `dist/index.html` as its
  template *and* overwrites it, so running it twice in a row finds an already
  rendered page with no `<!--seo-->` or `<div id="root"></div>` left to
  substitute. It detects that and exits non-zero *before writing anything* (no
  corruption, and the full `build` is unaffected) — but the fix is always to
  re-run `bun run build`, or at minimum `build:client` first.

### Verify serving with `wrangler dev`, not `vite preview`

`bun run --cwd apps/site preview` still works for eyeballing styles, but it
**cannot** tell you how the deployed site serves anything, and it is wrong on
exactly the URL shape that matters (all four measured):

- `/docs/concepts/agents` — the no-trailing-slash form every canonical,
  sitemap entry and internal link uses — SPA-falls-back and returns the
  **landing page** at HTTP 200. Only `/docs/concepts/agents/` works.
- Nothing ever returns 404; `/nope` and `/docs/bogus` are the landing page at
  200 too.
- `_redirects` is inert, so `/docs` is the landing page rather than a 301.

Cloudflare differs on every one of those counts, so run the **real router**
instead — `wrangler` is pinned in the repo-root `mise.toml` and this runs
offline against `dist/`:

```sh
bun run --cwd apps/site build
cd apps/site && wrangler dev --local
```

What that serves (verified against workerd, not inferred):

| request | result |
|---|---|
| `/` | 200 |
| `/docs/concepts/agents` | 200 |
| `/docs/concepts/agents/` | 307 → `/docs/concepts/agents` |
| `/docs` and `/docs/` | 301 → `/docs/getting-started/overview` → 200 |
| `/nope` | 404 (root `dist/404.html`) |
| `/docs/bogus` | 404 (`dist/docs/404.html`) |

One operational note: `wrangler dev` watches the asset directory, so a
`rm -rf dist && bun run build` underneath a running server leaves it holding an
empty manifest and answering 404 for everything. Restart it after a clean
rebuild. It also writes an untracked `apps/site/.wrangler/` (gitignored at the
repo root).

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
| `VITE_SITE_URL` | `site.yml`, at workflow level, fixed to `https://invisiblestring.io` | Origin for every absolute URL the site emits — canonical, OG/Twitter, JSON-LD, `sitemap.xml`, `robots.txt`. Read by `src/lib/seo.ts`'s `normalizeSiteUrl` (trims, strips a trailing slash, and falls back to `DEFAULT_SITE_URL` = `http://localhost:5173`). No longer substituted into `index.html`. |
| `SITE_INDEXABLE` | `site.yml`'s **deploy job only** | `1` emits `index,follow` + a real `robots.txt`. **Anything else, including unset, emits `noindex,nofollow` on every page and `Disallow: /`.** Fail-safe by design: preview versions, local builds and manual `wrangler versions upload`s can never compete with production in search. |
| `VITE_APP_URL` | unset by default | If set, the nav renders an "Open the app" CTA linking at it (e.g. the production SPA origin). Leave unset to hide the CTA. |

`VITE_SITE_URL` is set at *workflow* level, so preview builds carry production
canonicals — a deliberate hint, backed by the `SITE_INDEXABLE` directive.

## SEO and prerendering

### The pipeline

```
tsc --noEmit
vite build                                          # client → dist/ (incl. the dist/index.html template)
vite build --ssr src/entry-server.tsx --outDir .ssr
bun scripts/prerender.ts                            # .ssr + dist/index.html → dist/**
```

`scripts/prerender.ts` imports the SSR bundle and reads its re-exported
`docEntries` — the same `import.meta.glob` that drives the sidebar — so **the
page list is derived, never hand-maintained**. A new `.mdx` file is
prerendered, sitemapped and added to `llms.txt` on the next build with no
registry edit anywhere. It emits `dist/index.html` (landing), one
`dist/docs/<slug>/index.html` per doc, **two** not-found documents
(`dist/404.html` and `dist/docs/404.html` — see [Serving
behaviour](#serving-behaviour-404s-docs-headers)), plus `sitemap.xml`,
`robots.txt` and `llms.txt`.

The page list is deliberately **closed** — `docEntries` + `/` + the two 404s,
never an arbitrary path. `/docs` in particular is not prerendered: it has no
page of its own (`public/_redirects` 301s it to the overview), so no file may
exist at that path.

### One metadata model, two renderers

`src/lib/seo.ts` is the single source of every piece of page metadata:
`landingSeo` / `docSeo` / `notFoundSeo` build a `PageSeo`, and two renderers
consume it.

- **`renderHeadHtml(seo)` → string.** Injected into the template at build time.
  This is what crawlers actually read.
- **`applyHead(seo, document)` → DOM mutation.** Runs on client-side
  navigation so the tab title, bookmarks and history are right for humans (and
  so the dev server, where nothing is prerendered, still shows real titles). It
  deliberately does **not** write the robots meta — the build owns that, or a
  preview build would un-`noindex` itself the moment a visitor clicked a link.

`seo.ts` reads no environment of its own: callers pass `siteUrl` in
(`HeadSync.tsx` from `import.meta.env.VITE_SITE_URL`, `scripts/prerender.ts`
from `process.env.VITE_SITE_URL`, both through `normalizeSiteUrl`). That is
what lets the same module run under Vite, under `bun test`, and under a bare
Bun script.

### Why `prerender()`, and why not `HeadContent`

Doc bodies are `React.lazy(() => import('…mdx'))` (`routes/docs.$.tsx`).
`renderToString` and `renderToStaticMarkup` do **not** wait for a suspended
component — both resolve with its fallback instead, silently. React 19's
`prerender()` (`react-dom/static`) is the one API that waits for every Suspense
boundary to settle, which is the only safe contract for a page whose content
must always be complete. `entry-server.tsx` additionally passes `onError` —
a component that throws inside a boundary is *recoverable* to React, so
`prerender()`'s promise still fulfills while the fallback ships.

The head deliberately never participates in hydration. `@tanstack/react-router`
does export `HeadContent`, but the static template must carry a `<title>`, and
`HeadContent` rendering a second one after hydration leaves two `<title>`
elements — browsers and crawlers take the first, so the head would stay pinned
to whatever page was prerendered. React renders only into `#root`;
`renderHeadHtml` owns the static head and `applyHead` owns updates. Zero
mismatch surface in the head, by construction.

### `src/lib/suspense-inline.ts`

`prerender()`'s guarantee is about content *completeness*, not *placement*.
A boundary that suspends even once during the render pass gets React's
streaming markup — `<!--$?-->` plus the fallback where the content belongs, the
real content parked in a `<div hidden id="S:N">`, and a `$RC(...)` swap script
— even though everything has already resolved by the time `prerender()`
returns. TanStack Router wraps routed content in `<Suspense>` unconditionally,
so **every** page hits this.

`inlineResolvedSuspense` collapses that back into flat HTML, splicing the
resolved segment in as `<!--$-->…<!--/$-->` (React's marker pair for a boundary
that completed without streaming) and stripping the Fizz runtime scripts.
Without it every docs page would ship `Loading…` as its body to any client that
does not run JS — a perfectly-shaped, entirely empty page.

### The template markers

`index.html` carries exactly two markers the prerender script substitutes:

```
<!--seo-->              →  renderHeadHtml(seo)
<div id="root"></div>   →  <div id="root">{appHtml}</div>
```

**Changing either string breaks the injection.** Both are plain-string
`.replace` calls, so a mismatch would otherwise no-op silently on every page;
the script asserts both markers exist in the template and fails loudly if not.
(Both replacements use the *callback* form of `String.replace` — a replacement
string expands `$&`, `` $` `` and friends even for a plain-string pattern, so a
description or doc body containing one would corrupt the output. Don't
"simplify" them back.)

The dev server leaves `<!--seo-->` as a bare comment; `components/HeadSync.tsx`
populates the head on mount instead.

### The landing page ships transparent (deliberate)

`dist/index.html` carries ~35 inline `opacity:0` styles, including both hero
`<h1>` spans at `opacity:0;filter:blur(7px)` — `motion` serializes each
entrance animation's `initial` state during the render pass. `dist/docs/**`
and both 404 documents carry none (measured: 35 / 0 / 0 / 0).

There is **no SEO cost**: the text is in the HTML, and `index.html`'s
`<noscript>` block forces `[data-reveal]` elements to their final state
(`opacity/transform/filter`, `!important` beating the inline style) for any
client that never animates. The human cost is that `/` shows nav, wash and
footer with a blank middle until hydration runs the reveals. That is a
tradeoff, not an oversight — the alternative is giving up the landing entrance
animations, which is a design decision rather than a build one. Docs pages,
where the SEO-valuable long-form content lives, are visible from first paint.

### Hydration was not a drop-in

Two non-obvious things make hydration work; both will look removable and are
not.

1. **The root `<Suspense>` boundary is supplied by the router config.**
   `@tanstack/react-router`'s `Matches` picks its root wrapper off `isServer`,
   which is not a runtime check — it is a module constant chosen by package
   export condition (`@tanstack/router-core/isServer`), and `vite build --ssr`
   resolves it to `true`. So the server emitted no boundary while the browser
   insists on one, and React refused the hydration outright, throwing away
   every prerendered byte. `router.tsx` supplies it through the router's public
   `InnerWrap` seam (`PrerenderRootSuspense`, prerender only), which emits
   exactly the `<!--$-->…<!--/$-->` pair the client's own boundary hydrates
   against. `scripts/prerender.ts` asserts every page's markup *opens* with
   `<!--$-->`.
2. **`main.tsx` hydrates behind `router.load()`, inside a `Promise.race` with a
   10 s timeout.** A fresh router has no matches synchronously and
   `MatchesInner` reads them off the store during render, so hydrating
   immediately renders nothing under the root boundary while the prerendered
   HTML holds the whole page — an instant mismatch. `load()` resolves the
   matches and their route chunks first. The race is there because a load that
   never settles would otherwise leave the page permanently un-hydrated and
   *silent*: inert markup, no error, no fallback. Hydrating anyway degrades to
   "React discards the markup and client-renders", which is a working site.
3. **A 404 document must match the tree the router renders where it is
   served, and must render nothing derived from the requested URL.** Both
   halves were measured as real `#418`s in Chromium; both are why there are
   two 404 files and why `DocNotFound` defers the slug past mount. See
   [Serving behaviour](#not_found_handling-404-page-and-why-there-are-two-404-documents).

**Rejected, verified broken, do not retry:** setting `router.ssr = {...}` (what
TanStack Start's `hydrate()` does) makes the *browser* skip the boundary
instead. It silences the mismatch and leaves the app dead — the route chunk is
never fetched and `DocPage` never renders, with nothing in the console.
Resolving the SSR build with `browser` conditions gets `isServer === false`
honestly and then dies in `RouterCore`'s constructor on `window is not
defined`.

### Generated `sitemap.xml`, `robots.txt`, `llms.txt`

All three are emitted by the prerender script rather than living in `public/`,
because all three embed the build-time site URL or the derived page list.

- **`sitemap.xml`** — one `<url>` per page that has a canonical, which is every
  page except the two 404s (`notFoundSeo` sets `canonical: null` on purpose, and
  `renderSitemap` keys off exactly that). No `<lastmod>` — see Future work.
- **`robots.txt`** — `Allow: /` plus `Sitemap: <siteUrl>/sitemap.xml` on the
  production deploy; `Disallow: /` on every other build.
- **`llms.txt`** — prose and `## Source` come from `scripts/llms-template.md`;
  the `## Docs` list is generated from frontmatter, grouped and ordered by the
  same `buildSidebar` the site's nav uses, so the file and the sidebar cannot
  disagree.

### Build guards

`scripts/prerender.ts` fails the build (non-zero exit, all problems reported at
once) on any of these. They run in `ci.yml`'s `unit` job and in `site.yml`, so
no new CI job was needed.

- a doc whose frontmatter is missing `title`, `section` or `description`
  (checked *before* any rendering)
- **no doc matching `DOCS_INDEX_SLUG`** (also before any rendering). That slug
  is hardcoded in three places nothing else ties together — `src/lib/seo.ts`,
  `src/routes/docs.index.tsx` and `public/_redirects` — and the two outside
  this build are silent on failure. Without the guard, renaming one `.mdx`
  file is an ordinary content edit that leaves the edge 301 pointing at a URL
  that 404s and in-app `/docs` landing on `DocNotFound`, with a green build
- a page whose `#root` markup is under 1 000 bytes — an empty shell (measured
  against the app markup, not the finished document, which the template and
  JSON-LD alone would push past any useful threshold)
- markup that does not open with `<!--$-->` (the root Suspense boundary is
  missing or displaced → nothing can hydrate)
- no `<h1>`, a surviving `<!--seo-->`, or a surviving `%VITE_SITE_URL%`
- two pages claiming the same canonical
- a page embedding the build-time sentinel path it was rendered at
  (`__prerender_not_found__`). This is the hydration contract for the two 404
  documents: each is served for an unbounded set of URLs, so anything either
  renders *from the requested path* mismatches in every browser that loads it
- **any React streaming artifact in the output**: `<!--$?-->` (unresolved
  boundary), `<!--$!-->` (errored boundary — its fallback shipped),
  `<div hidden id="S:` (the parking div), `$RC("B:` (the swap script), or the
  docs route's literal `Loading…` fallback markup

That last group is the one worth understanding. Byte-length and `<h1>` checks
cannot see it: a page can have a perfect shell, a real `<h1>` and 20 KB of
markup while its entire `<article>` body has been replaced by a Suspense
fallback. The markers are anchored to React's emitted form rather than matched
as loose substrings, so a doc page that legitimately *writes about* `div
hidden` or `$RC(` in prose or a code sample doesn't fail the build.

## Cloudflare Workers deploy

The site deploys as an **assets-only Worker** (`wrangler.jsonc` — name
`invisible-string-site`, assets from `dist/`, no server code) with a
custom-domain route for `invisiblestring.io`. CI (`site.yml`) does it all:

- **Push to `main`** touching `apps/site/**`, `packages/design-tokens/**`, or
  the workflow → build with `SITE_INDEXABLE=1` + `wrangler deploy`
  (production).
- **Pull request** touching the same paths → build **without**
  `SITE_INDEXABLE` (so the preview ships `noindex` + `Disallow: /`) +
  `wrangler versions upload --preview-alias <branch>` → the per-commit and
  per-branch preview URLs (`<alias>-invisible-string-site.<subdomain>.workers.dev`)
  are posted as a PR comment. Fork PRs skip this (no secrets).

wrangler itself is deliberately **not** a workspace dependency — the root
lockfile covers all workspaces, so it would inflate every prod Docker image's
`bun install --frozen-lockfile`. It is pinned in the repo-root `mise.toml`
(`"npm:wrangler" = "<x.y.z>"`) and installed under mise's own data dir, so
`wrangler` is on `PATH` in CI (and locally after `mise install`) without ever
touching this manifest. `cloudflare/wrangler-action` is unusable here because
its fallback `npm i wrangler` runs inside the working directory and npm chokes
on the Bun `workspace:*` protocol in `package.json`.

### One-time setup

1. Create a Cloudflare API token from the **"Edit Cloudflare Workers"**
   template on the account that owns the `invisiblestring.io` zone.
2. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Confirm the apex of `invisiblestring.io` has no conflicting DNS record
   (custom-domain creation refuses to overwrite an existing CNAME).
4. After the first successful deploy, disable GitHub Pages in repo settings
   (Settings → Pages) — the old Pages deployment is superseded.

## Serving behaviour: 404s, `/docs`, headers

### `html_handling: "drop-trailing-slash"`

**Not the default, and it must not go back to one.** `prerender.ts` emits
`dist/docs/<slug>/index.html`, while every canonical, `og:url`, sitemap
`<loc>`, internal `<Link>` and `llms.txt` line advertises the **no**-trailing-
slash form `/docs/concepts/agents`. Cloudflare's default `auto-trailing-slash`
serves a folder index only *with* the slash, so it answers all 28 advertised
doc URLs with a **307 to their trailing-slash twin** — a redirect on the
canonical form of the entire docs tree. `drop-trailing-slash` inverts it:
`/docs/concepts/agents` is 200 and the trailing-slash form 307s to it.

Emitted paths, advertised URLs, and this setting are one decision in three
files. Change any one and you must change all three.

### `not_found_handling: "404-page"`, and why there are two 404 documents

Real files serve **200** — every route is one, so deep links are unaffected.
Everything else gets a **genuine 404**, whose body is the *nearest* `404.html`
walking up the tree. That "nearest" is why the build emits two:

| miss | file served | what the client router renders there |
|---|---|---|
| `/nope` | `dist/404.html` | root `notFoundComponent` (no docs chrome) |
| `/docs/bogus` | `dist/docs/404.html` | the docs **shell** — sidebar, mobile nav, TOC rail — with `DocNotFound` in the content column |

One document cannot be both trees. Serving the root 404 under `/docs/*` means
the browser hydrates the docs shell against root-404 markup, which React
rejects outright (`Minified React error #418`), discarding every prerendered
byte — a guaranteed console error across a whole URL class. Both files keep
`notFoundSeo`'s `canonical: null`, which is exactly what keeps them out of
`sitemap.xml`, and both are `noindex`.

`DocNotFound` renders the requested path only **after mount** for the same
reason: `dist/docs/404.html` is one file serving an unbounded set of URLs, so
the slug it was built with is never the slug the browser is on, and rendering
it in the first pass is a guaranteed text mismatch. The build guards the
emitted HTML against that regression (see [Build guards](#build-guards)).

SPA fallback (`"single-page-application"`) was the correct setting *before*
prerendering: the shell was the page, and GitHub Pages' 404-status deep links
were the bug being fixed. Once every route is a real file the same setting
inverts into a soft-404 generator — `/docs/concpets/agents`, `/dcos` and every
scanner probe would return the **homepage** at 200, an unbounded set of URLs
serving identical content with a success status. That is the canonical
duplicate-content trap, so `404-page` it is.

### `public/_redirects`

```
/docs   /docs/getting-started/overview  301
/docs/  /docs/getting-started/overview  301
```

Both forms are listed because `html_handling` normalizes slashes only for
paths that resolve to an **asset**, and `/docs` resolves to no file at all —
without the second rule `/docs/` falls through to the 404.

`routes/docs.index.tsx` redirects client-side, which leaves `/docs` competing
with `/docs/getting-started/overview` for the same content (a crawler that runs
no JS sees `/docs` return 200 with a shell; one that does sees the overview's
content at the `/docs` URL). The 301 consolidates it at the edge. The route
file stays for in-app navigation.

Note that Cloudflare evaluates redirects *before* assets — "Redirects are
always followed, regardless of whether or not an asset matches the incoming
request" — so this rule is not at risk from a file appearing at `/docs`. The
reason not to prerender `/docs` is simply that it is not a page.

### `public/_headers`

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

`vite.config.ts` applies these to the dev server and `vite preview`; Workers
adds neither on its own, so production had no sniffing or referrer protection
at all until this file. No `X-Frame-Options` — this is a public marketing site
and framing is fine, unlike the authenticated SPA.

`_redirects` and `_headers` are natively supported by Workers static assets and
must sit at the root of the asset directory, which `public/` → `dist/`
satisfies.

## MDX authoring

Docs content lives under `src/content/docs/**/*.mdx`. Each file needs
frontmatter:

```md
---
title: My Page
section: Getting started
order: 2
description: One sentence a search result can stand on — what this page covers and why someone would open it.
---
```

- `section` groups pages in the sidebar; `order` sorts within a section
  (ties break on `title`).
- `description` is **required**. It becomes the page's `<meta name="description">`,
  its OG/Twitter description, its JSON-LD `description`, and its line in
  `llms.txt`. The build fails on a missing or empty value (`scripts/prerender.ts`,
  before any rendering), so a new doc cannot ship description-less. Aim for
  110–155 characters — longer is truncated in search results; the length is a
  convention, only non-emptiness is enforced.
- The sidebar and prev/next pagination are derived entirely from this
  frontmatter (`src/lib/sidebar.ts`) — there's no separate nav config to keep
  in sync.
- Headings get `id`s via `rehype-slug`; the right-rail "On this page" TOC
  (`src/lib/toc.ts`) reads those ids back out of the rendered DOM.
- Slugs are the file path under `src/content/docs/`, minus the `.mdx`
  extension (e.g. `getting-started/overview.mdx` → `/docs/getting-started/overview`).
- New pages need no registry edit — `src/lib/docs.ts`'s `import.meta.glob`
  picks them up automatically, and the prerender script derives its page list,
  sitemap entry and `llms.txt` line from the same glob.
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

- **`<lastmod>` in the sitemap**: blocked on `fetch-depth: 0`. `site.yml` uses
  `actions/checkout@v4` at its default depth of 1, so per-file git dates are
  unavailable and every entry would carry the build timestamp. Google discounts
  a `lastmod` it finds unreliable across the whole sitemap, so a uniformly
  wrong date is worse than none. Adding it means setting `fetch-depth: 0` and
  reading `git log -1 --format=%cI -- <file>`.
- **Per-page OG images**: one shared `og.png` for every page today.
- **Docs search**: the docs shell ships without search on purpose — a dead
  search box is worse than none. Adding it (client-side index over the MDX
  frontmatter/body, or a hosted index) is deferred.
- **MDX code-splitting is a deliberate no-op**: `src/lib/docs.ts` eagerly
  globs frontmatter from the same modules it lazy-imports, so Rollup keeps
  every doc body in one chunk (`INEFFECTIVE_DYNAMIC_IMPORT` warnings at
  build). At ~28 pages — most now long-form rather than short stubs — the
  single chunk is materially larger than when this was weighed; revisit
  (frontmatter as a separate virtual module) now that the docs have grown
  into long-form content. Prerendering makes it matter less for first paint
  (the content is in the HTML) but does not fix it — hydration still needs the
  MDX body JS.

## Testing constraint: no MDX in tests

`bun test` cannot run Vite plugins, so nothing under `src/test/` or any
`*.test.ts(x)` file may import an `.mdx` file, a route file, or anything that
touches `import.meta.glob`. The MDX-dependent logic is deliberately split into
pure TypeScript that tests exercise directly with plain data/DOM fixtures:
`src/lib/sidebar.ts`'s `buildSidebar`, `src/lib/toc.ts`'s `extractToc`, and —
for exactly the same reason — `src/lib/seo.ts`, `src/lib/sitemap.ts`,
`src/lib/llms.ts` and `src/lib/suspense-inline.ts`.

`seo.ts` and friends carry a second constraint on top: they must also be
importable from `scripts/prerender.ts`, which runs under **Bun, outside Vite
entirely**. That is why they read no environment of their own and take
`siteUrl` as a parameter — `import.meta.env` would not exist there.

Build-time correctness (does the MDX pipeline actually compile, does every page
really render) is covered by `vite build` + the prerender guards in CI
(`ci.yml`'s unit job + `site.yml`), not by `bun test`.
