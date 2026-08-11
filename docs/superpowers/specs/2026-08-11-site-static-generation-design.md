# Static generation for `apps/site` — Design (2026-08-11)

Picks up the work `docs/superpowers/specs/2026-07-09-site-cloudflare-workers-deploy-design.md` §"Out of scope" deferred (*"Prerendering/SEO work beyond the status-code fix"*), and **supersedes that spec's §"not_found_handling"** decision: SPA fallback was the right answer for a client-rendered shell and is the wrong answer once every route is a real file (§7).

The 2026-07-08 landing/docs spec still binds for everything about content, IA, and E1 styling. Nothing in this spec changes what a page looks like — only what a crawler receives before JavaScript runs.

---

## 1. Decision

`apps/site` prerenders every route to a static HTML file at build time, with a complete, page-specific `<head>`, and keeps hydrating into the same SPA afterwards. The deploy model does not change: still an assets-only Cloudflare Worker, still no compute.

Three problems are being fixed, and only the first is the one people usually mean by "SSG":

1. **Content arrives only after JS.** Every route today ships `<div id="root"></div>`. Google renders JS, but slowly and not unconditionally; most other crawlers — Bing's fallbacks, social unfurlers, AI crawlers — do not.
2. **All 29 pages claim to be the homepage.** `index.html` hardcodes one `<title>`, one description, and `<link rel="canonical" href="%VITE_SITE_URL%/">` (`apps/site/index.html:6-31`). Every docs page serves that head verbatim, so each of the 28 docs pages tells search engines it is a duplicate of `/`. This is worse than the render problem: it is an active instruction to discard the docs.
3. **There is no sitemap and no structured data.** `public/robots.txt` is two lines and names no sitemap.

No new runtime dependency. No change to `docs.ts`, the sidebar derivation, the MDX pipeline, or any component's markup.

---

## 2. Why `prerender()` and not `renderToString()`

Doc bodies are loaded lazily — `getDocLoader(slug)` returns a dynamic import that `docs.$.tsx:37` hands to `React.lazy`:

```ts
const MdxDoc = useMemo(() => (loader ? lazy(loader) : null), [loader]);
```

`renderToString` throws on a component that suspends ("A component suspended while responding to synchronous input"). React 19's **`prerender()` from `react-dom/static`** exists for exactly this case: it waits for every Suspense boundary to settle and resolves with complete HTML.

This one API choice is what makes the whole design cheap. The alternative — resolving MDX eagerly for SSR — would mean a second, non-lazy glob in `docs.ts` and a divergence between what the server renders and what the client loads. With `prerender()`, `docs.ts` is untouched.

The mirror-image concern on the client is already handled by React: `hydrateRoot` does **not** discard server HTML inside a Suspense boundary whose lazy component hasn't loaded yet. Selective hydration retains the markup and hydrates when the chunk arrives, so there is no content flash on first paint.

---

## 3. Build pipeline

```
tsc --noEmit
vite build                                          # client → dist/ (incl. the dist/index.html template)
vite build --ssr src/entry-server.tsx --outDir .ssr
bun scripts/prerender.ts                            # .ssr + dist/index.html → dist/**
```

`.ssr/` is a sibling of `dist/`, not a child, and is gitignored. Anything under `dist/` is uploaded to Cloudflare; the SSR bundle must never be.

`scripts/prerender.ts` imports the SSR bundle and reads its re-exported `docEntries`, so **the page list is derived, never hand-maintained**. A new `.mdx` file is prerendered, sitemapped, and added to `llms.txt` on the next build with no registry edit — the same property `apps/site/README.md` already claims for the sidebar.

### `src/router.tsx` (new)

`createSiteRouter(history?)` becomes the single router factory, imported by both `main.tsx` and `entry-server.tsx`. Client and server cannot drift into different `basepath` or preload settings, which is the usual source of hydration mismatches in a hand-rolled SSG.

The server passes `createMemoryHistory({ initialEntries: [path] })` and `defaultPreload: false`; the client keeps `defaultPreload: "intent"`.

`main.tsx` switches `createRoot` → `hydrateRoot`.

---

## 4. The head: one model, two renderers

`src/lib/seo.ts` is **pure TypeScript** — no `import.meta.glob`, no `.mdx` import, no route import. This is deliberate and load-bearing: `apps/site/README.md`'s "no MDX in tests" constraint means anything a test needs to exercise must be glob-free, exactly as `lib/sidebar.ts` and `lib/toc.ts` already are.

```ts
interface PageSeo {
  path: string;          // "/docs/concepts/agents"
  title: string;         // full <title> text
  description: string;
  canonical: string;     // absolute
  ogImage: string;       // absolute
  ogType: "website" | "article";
  jsonLd: object[];
  noindex: boolean;
}

landingSeo(siteUrl): PageSeo
docSeo(slug, frontmatter, siteUrl): PageSeo
notFoundSeo(siteUrl): PageSeo

renderHeadHtml(seo): string          // → the prerender script, server side
applyHead(seo, document): void       // → the client, on route change
```

One model, two renderers. The prerender script emits the head as a string; the client mutates `document.head` on SPA navigation.

### Why not `HeadContent`

`@tanstack/react-router@1.170` does export `HeadContent`, `Scripts`, and `useTags` — per-route `head()` no longer requires TanStack Start. It is still the wrong tool here.

The static template must carry a `<title>` (that is the entire point of the exercise). If `HeadContent` then renders another one after hydration, the document has two `<title>` elements; browsers and crawlers take the first, which means the head stays pinned to whatever page was prerendered and never updates. Working around that means either not emitting a static title (defeats the purpose) or having the prerender script surgically relocate React-hoisted tags out of the root div and into `<head>` — fragile, and dependent on React's stream-hoisting behavior for a fragment render rather than a full-document render.

Instead: **the `<head>` never participates in hydration at all.** React renders only into `#root`. `renderHeadHtml` owns the static head; `applyHead` — roughly 25 imperative lines — owns updates. Zero mismatch surface in the head by construction, and it is testable against happy-dom without any Vite plugin.

A side benefit: `applyHead` runs in dev too, so `bun run --cwd apps/site dev` shows correct per-page titles even though nothing is prerendered there. Prerendering becomes purely additive for crawlers rather than a second, divergent source of truth.

### Template mechanics

`index.html` is reduced to charset, viewport, theme-color, favicon, the `<noscript>` block from §9, and a `<!--seo-->` marker.

The three `%VITE_SITE_URL%` substitutions are deleted, since `seo.ts` now owns every absolute URL. `VITE_SITE_URL` itself stays — but its local-dev default moves out of `vite.config.ts:29-31` (which mutates `process.env` at config-evaluation time purely to keep the HTML substitution from breaking) and into `seo.ts`:

```ts
const SITE_URL = import.meta.env.VITE_SITE_URL ?? "http://localhost:5173";
```

That matters because `applyHead` runs in the browser and needs the same base URL the prerender script used. Leaving the default in `vite.config.ts` would define it for the HTML-substitution path only, and `import.meta.env.VITE_SITE_URL` would be `undefined` in any build where CI did not set it — producing `undefined/docs/...` canonicals on the client. One default, in the module that consumes it.

For each page the prerender script takes the **built** `dist/index.html` (which already carries Vite's hashed `<script type="module">` and `<link rel="stylesheet">`) and performs two replacements:

```
<!--seo-->                →  renderHeadHtml(seo)
<div id="root"></div>     →  <div id="root">{appHtml}</div>
```

Asset URLs are absolute (`base` is `/`), so the same template works at every directory depth.

---

## 5. What gets emitted

| Route | Output |
|---|---|
| `/` | `dist/index.html` |
| `/docs/<slug>` × 28 | `dist/docs/<slug>/index.html` |
| unmatched | `dist/404.html` — root `notFoundComponent`, `noindex` |
| `/docs` | *not prerendered* — a 301 (§7) |

`html_handling` stays at its default `auto-trailing-slash`, so `dist/docs/concepts/agents/index.html` serves at `/docs/concepts/agents`. **Every existing URL is unchanged**; nothing that is currently linked or indexed moves.

Also emitted: `dist/sitemap.xml`, `dist/robots.txt`, `dist/llms.txt` (§6).

---

## 6. Metadata

### Docs frontmatter gains `description`

```md
---
title: Agents
section: Concepts
order: 1
description: Persona, model, and context — and how publishing turns a draft into an immutable version.
---
```

Required, on all 28 pages, hand-written. `public/llms.txt` already contains hand-written one-liners for 12 of them; those seed the work. A build guard (§9) fails the build when a doc omits it, so a new page cannot ship description-less.

Auto-deriving from the first paragraph was considered and rejected: the derived text reads as truncated prose rather than as a reason to click, and the "hand-tune it later" step never happens.

### Per-page head

- **Landing** — current title and description, canonical `/`, OG/Twitter as today, JSON-LD `SoftwareApplication` + `Organization`.
- **Docs page** — `<Title> — invisible-string docs`, frontmatter description, own canonical, `og:type=article`, JSON-LD `TechArticle` + `BreadcrumbList` (Docs → Section → Page).
- **404** — `noindex`, no JSON-LD.

One shared `og.png` for every page. Per-page OG images are out of scope (§11).

### `sitemap.xml`

One `<url>` per prerendered page, absolute `<loc>`, `noindex` pages excluded.

**No `<lastmod>`.** `site.yml` uses `actions/checkout@v4` at its default depth of 1, so per-file git dates are unavailable and every entry would report the build timestamp. A uniformly-wrong `lastmod` is worse than an absent one — Google discounts `lastmod` it finds unreliable, across the whole sitemap. Adding it later means setting `fetch-depth: 0` and reading `git log -1 --format=%cI -- <file>`; noted as future work in the README.

### `robots.txt` and `llms.txt` become generated

Both move out of `public/` and are emitted by the prerender script.

- `robots.txt` gains `Sitemap: <siteUrl>/sitemap.xml`, which it cannot carry as a static file because the URL is build-time.
- `llms.txt`'s `## Docs` section is generated from frontmatter — every page, grouped by `section`, ordered by `order` — while its header, summary paragraph, and `## Source` section stay templated in `scripts/llms-template.md`. Today the hand-maintained list covers 12 of 28 pages and has no mechanism to stay current.

---

## 7. Cloudflare configuration

### `not_found_handling`: `"single-page-application"` → `"404-page"`

The 2026-07-09 spec chose SPA fallback to fix a real problem: GitHub Pages served deep links with an HTTP 404 status, and Cloudflare's SPA mode serves the shell at 200. That reasoning was correct for a client-rendered shell, where the shell *is* the page.

Once every route is a real file, the same setting inverts: `/docs/concpets/agents`, `/dcos`, and every scanner probe now return the **homepage** at HTTP 200. That is a soft-404 — an unbounded set of URLs serving identical content with a success status, which is the canonical duplicate-content trap. `"404-page"` serves the nearest `404.html` with a genuine 404 status, and real deep links keep returning 200 because they are real files.

### `public/_redirects`

```
/docs  /docs/getting-started/overview  301
```

`docs.index.tsx` currently throws a client-side `redirect()` in `beforeLoad`. A crawler that does not run JS sees `/docs` return 200 with the app shell; one that does sees the overview's content at the `/docs` URL. Either way `/docs` competes with `/docs/getting-started/overview`. A 301 consolidates the signal at the edge. The route file stays for in-app navigation.

`_redirects` and `_headers` are natively supported by Workers static assets and must sit at the root of the asset directory — `public/` → `dist/` satisfies that.

### `public/_headers`

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

`vite.config.ts:39-42` applies these to the dev server and `vite preview` only, and its comment claims "GitHub Pages fronts the static build with its own headers" — stale since the Cloudflare migration. Workers adds neither. This restores dev/prod parity. No `X-Frame-Options`, matching the existing rationale: this is a public marketing site, framing is fine.

---

## 8. Preview deploys stop competing with production

New build-time flag **`SITE_INDEXABLE`**, set to `1` in `site.yml`'s `deploy` job and nowhere else. Any other value, including unset — the default — means:

- every page gets `<meta name="robots" content="noindex">`
- `robots.txt` is emitted as `User-agent: *` / `Disallow: /`

`preview_urls: true` publishes a complete copy of the site at `<branch>-invisible-string-site.<subdomain>.workers.dev` on every PR. The 2026-07-09 spec already mitigates this deliberately — preview builds keep the production `VITE_SITE_URL`, so their canonical points at prod. That is a *hint*, though, and it becomes materially weaker once previews serve full prerendered content rather than an empty shell. `noindex` is a directive.

The flag is fail-safe by default: only the production deploy opts in, so a new workflow, a local `vite preview`, or a manual `wrangler versions upload` cannot accidentally publish an indexable duplicate.

---

## 9. Risks, with named fallbacks

### `motion` renders `opacity: 0` into the static HTML

`Reveal` (`components/landing/parts.tsx:38-44`) sets `initial={{ opacity: 0, y }}`, which SSR emits as an inline `style`. Every landing section therefore ships hidden until JS runs and IntersectionObserver fires. Googlebot renders JS so this is largely cosmetic, but a non-JS crawler receives text it has been told is invisible.

Fix: `Reveal` gains `data-reveal`, and `index.html` carries

```html
<noscript><style>[data-reveal]{opacity:1!important;transform:none!important}</style></noscript>
```

`!important` beats the inline style. Docs pages are unaffected — `.doc-prose` has no motion wrapper, so the SEO-valuable long-form content was never at risk.

### `ThreadCanvas` hydration mismatch

`useReducedMotion()` (`components/landing/ThreadCanvas.tsx:31`) resolves `false` on the server and possibly `true` on the client, which changes `pathLength` from a spring to the literal `1`. `motion` normally absorbs this, but if React logs a hydration mismatch, the fallback is to gate the component behind a mounted flag. It is `pointer-events: none` decoration behind the content and contributes nothing to indexable text, so not rendering it server-side costs nothing.

### Bundle size is unchanged, and still a known issue

Prerendering does not fix the `INEFFECTIVE_DYNAMIC_IMPORT` single-chunk problem documented in `apps/site/README.md` — hydration still needs the MDX body JS, and it still all lives in one chunk. Prerendering does make it matter less for *first paint*, since content is now in the HTML. Out of scope; the README note stands.

---

## 10. Verification

### Unit tests (`bun test`, glob-free, no MDX)

- `seo.test.ts` — `landingSeo`/`docSeo`/`notFoundSeo` shapes; HTML escaping of titles and descriptions containing `&`, `<`, `"`; canonical joining across leading/trailing slashes; `noindex` honored; every `jsonLd` entry survives `JSON.parse(JSON.stringify(...))`.
- `sitemap.test.ts` — absolute `<loc>`s, XML escaping, `noindex` pages excluded, no duplicate URLs.
- `head-apply.test.ts` — `applyHead` against happy-dom: sets `<title>`, updates rather than appends `meta[name=description]` and `link[rel=canonical]` on repeat calls.

### Build-time guards in `scripts/prerender.ts`

These fail `vite build`, so they run in both `ci.yml`'s `unit` job and `site.yml` with no new CI job:

- every doc frontmatter has a non-empty `title`, `section`, and `description`
- the emitted page count matches `docEntries.length + 2`
- every emitted file exceeds a minimum byte length and contains `<h1` — catches a silently-empty render, the characteristic SSG failure
- no output contains a surviving `%VITE_SITE_URL%` or an unreplaced `<!--seo-->`
- canonicals are unique across all pages — catches a slug collision

### Post-merge

```sh
curl -sI https://invisiblestring.io/docs/concepts/agents | head -1        # 200
curl -sI https://invisiblestring.io/docs/nonexistent-page | head -1       # 404
curl -sI https://invisiblestring.io/docs | grep -i '^location'            # /docs/getting-started/overview
curl -s  https://invisiblestring.io/docs/concepts/agents | grep -o '<title>[^<]*'
curl -s  https://invisiblestring.io/sitemap.xml | grep -c '<loc>'         # 29
```

---

## 11. Out of scope

- **Docs search** — still deferred, for the reason `apps/site/README.md` gives: a dead search box is worse than none.
- **Per-page OG images** — one shared `og.png`.
- **MDX code-splitting** — unchanged (§9).
- **`<lastmod>` in the sitemap** — blocked on `fetch-depth: 0` (§6).

---

## 12. Documentation to update in the same commit

| Document | Change |
|---|---|
| `apps/site/README.md` | Build pipeline (four steps, `.ssr/`), the `description` frontmatter requirement, the seo.ts model and why not `HeadContent`, generated `robots.txt`/`llms.txt`/`sitemap.xml`, `_redirects`/`_headers`, `SITE_INDEXABLE` in the env table, and the SPA-fallback section rewritten as 404-page. Remove the stale GitHub Pages headers claim. |
| `AGENTS.md` | The `apps/site` architecture line — "static landing + docs SPA" → prerendered-then-hydrated (assets-only Worker unchanged) — and the CI section's `site.yml` paragraph, which describes that workflow's env and deploy steps and now must mention `SITE_INDEXABLE=1` on the deploy job only. |
| `.env.example` | `SITE_INDEXABLE` alongside the existing site build-time vars note. |
| `.changeset/` | One `@invisible-string/site` `minor` entry, one line. |
