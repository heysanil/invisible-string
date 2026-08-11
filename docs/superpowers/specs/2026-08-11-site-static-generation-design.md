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

React 19's **`prerender()` from `react-dom/static`** exists for exactly this case: it waits for every Suspense boundary to settle and resolves with complete HTML.

*Corrected during implementation:* this section originally predicted that `renderToString` would **throw** on a suspending component. It does not — and that is worse. Verified directly: neither `renderToString` nor `renderToStaticMarkup` throws, rejects, or waits; both resolve with the boundary's **fallback**. A build on either would have shipped `Loading…` as the body of all 28 docs pages with nothing failing anywhere. `prerender()` is the only API that genuinely waits.

This one API choice is what makes the whole design cheap. The alternative — resolving MDX eagerly for SSR — would mean a second, non-lazy glob in `docs.ts` and a divergence between what the server renders and what the client loads. With `prerender()`, `docs.ts` is untouched.

The mirror-image concern on the client is already handled by React: `hydrateRoot` does **not** discard server HTML inside a Suspense boundary whose lazy component hasn't loaded yet. Selective hydration retains the markup and hydrates when the chunk arrives, so there is no content flash on first paint.

That is true of the *lazy body*, but hydration as a whole was **not** a drop-in — see §3.

`prerender()`'s completeness guarantee also turns out to be about content, not *placement*: a boundary that suspends even once during the render pass is emitted in React's streaming form (`<!--$?-->` + fallback, real content parked in `<div hidden id="S:N">`, a `$RC(...)` swap script), even though it has already resolved. `src/lib/suspense-inline.ts` (`inlineResolvedSuspense`) collapses that back to flat HTML, splicing the segment in as `<!--$-->…<!--/$-->`. Without it every docs page would ship its fallback as its body to any client that does not run JS — the exact failure this design exists to prevent, wearing a passing byte count.

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

`createSiteRouter(options?)` becomes the single router factory, imported by both `main.tsx` and `entry-server.tsx`. Client and server cannot drift into different `basepath` or preload settings, which is the usual source of hydration mismatches in a hand-rolled SSG.

The server passes `createMemoryHistory({ initialEntries: [path] })` and `defaultPreload: false`; the client keeps `defaultPreload: "intent"`.

`main.tsx` switches `createRoot` → `hydrateRoot`. **That was not a drop-in**, and the two things that make it work are non-obvious enough to be worth the spec's space:

- **The prerender must emit the root `<Suspense>` boundary the browser renders.** `Matches` picks its root wrapper off `isServer`, which is not a runtime check but a module constant chosen by package export condition (`@tanstack/router-core/isServer`) — `true` under the `node`/`bun` condition `vite build --ssr` resolves with. So the server emitted no boundary, the browser insisted on one, and React refused the hydration outright and threw every prerendered byte away. `createSiteRouter({ prerendering: true })` supplies it through the router's public `InnerWrap` seam (`PrerenderRootSuspense`, `fallback={null}` to match the client's unset `defaultPendingComponent`), and the prerender script asserts every page's markup opens with `<!--$-->`.
- **`main.tsx` hydrates behind `router.load()`, inside a `Promise.race` with a 10 s timeout.** A fresh router has no matches synchronously and `MatchesInner` reads them off the store during render, so hydrating immediately renders nothing under the root boundary while the HTML holds the whole page. The race exists because a load that never settles would otherwise leave the page permanently un-hydrated and *silent* — inert markup, no error, no fallback. Hydrating regardless degrades at worst to "React discards the markup and client-renders", which is a working site.

**Rejected, verified broken, recorded so nobody retries it:** setting `router.ssr = {...}` — what TanStack Start's `hydrate()` does — makes the *browser* skip the boundary instead. It silences the mismatch and leaves the app dead: the route chunk is never fetched, `DocPage` never renders, and nothing appears in the console. Resolving the SSR build with `browser` conditions (`ssr.noExternal` + `ssr.resolve.conditions`) gets `isServer === false` honestly and then dies in `RouterCore`'s constructor on `window is not defined`.

---

## 4. The head: one model, two renderers

`src/lib/seo.ts` is **pure TypeScript** — no `import.meta.glob`, no `.mdx` import, no route import. This is deliberate and load-bearing: `apps/site/README.md`'s "no MDX in tests" constraint means anything a test needs to exercise must be glob-free, exactly as `lib/sidebar.ts` and `lib/toc.ts` already are.

As shipped:

```ts
interface SeoContext {
  siteUrl: string;       // absolute origin, no trailing slash
  indexable: boolean;    // SITE_INDEXABLE === "1"; required, never optional
}

interface PageSeo {
  path: string;          // "/docs/concepts/agents"
  title: string;         // full <title> text
  description: string;
  canonical: string | null;  // null ⇒ must not be advertised (the 404)
  ogImage: string;       // absolute
  ogType: "website" | "article";
  robots: "index,follow" | "noindex,nofollow";
  jsonLd: object[];
}

landingSeo(ctx): PageSeo
docSeo(slug, frontmatter, ctx): PageSeo
notFoundSeo(ctx): PageSeo
seoForPath(pathname, docs, ctx): PageSeo   // → the client, resolving a route

renderHeadHtml(seo): string          // → the prerender script, server side
applyHead(seo, document): void       // → the client, on route change
```

Two shapes differ from this section's original sketch, both deliberately. `canonical` is nullable rather than always-present, because a 404 must not claim to be the canonical version of anything — and `renderSitemap` reuses exactly that null to exclude it (§6). And indexability is a resolved `robots` **string** on the page rather than a `noindex` boolean, so the one place that decides it is `robotsFor(ctx, forceNoindex)`: the 404 is `noindex` on its own account, every page is `noindex` in a non-production build, and no consumer re-derives the rule.

One model, two renderers. The prerender script emits the head as a string; the client mutates `document.head` on SPA navigation.

### Why not `HeadContent`

`@tanstack/react-router@1.170` does export `HeadContent`, `Scripts`, and `useTags` — per-route `head()` no longer requires TanStack Start. It is still the wrong tool here.

The static template must carry a `<title>` (that is the entire point of the exercise). If `HeadContent` then renders another one after hydration, the document has two `<title>` elements; browsers and crawlers take the first, which means the head stays pinned to whatever page was prerendered and never updates. Working around that means either not emitting a static title (defeats the purpose) or having the prerender script surgically relocate React-hoisted tags out of the root div and into `<head>` — fragile, and dependent on React's stream-hoisting behavior for a fragment render rather than a full-document render.

Instead: **the `<head>` never participates in hydration at all.** React renders only into `#root`. `renderHeadHtml` owns the static head; `applyHead` — roughly 25 imperative lines — owns updates. Zero mismatch surface in the head by construction, and it is testable against happy-dom without any Vite plugin.

A side benefit: `applyHead` runs in dev too, so `bun run --cwd apps/site dev` shows correct per-page titles even though nothing is prerendered there. Prerendering becomes purely additive for crawlers rather than a second, divergent source of truth.

### Template mechanics

`index.html` is reduced to charset, viewport, theme-color, favicon, the `<noscript>` block from §9, and a `<!--seo-->` marker.

The three `%VITE_SITE_URL%` substitutions are deleted, since `seo.ts` now owns every absolute URL. `VITE_SITE_URL` itself stays — but its local-dev default moves out of `vite.config.ts` (which mutated `process.env` at config-evaluation time purely to keep the HTML substitution from breaking) and into `seo.ts`, as **shipped**:

```ts
export const DEFAULT_SITE_URL = "http://localhost:5173";

/** Trim, default, and strip a trailing slash so path joins never double up. */
export function normalizeSiteUrl(raw: string | undefined): string;
```

`seo.ts` reads no environment itself — **each entry point passes its own source**: `import.meta.env.VITE_SITE_URL` in `components/HeadSync.tsx`, `process.env.VITE_SITE_URL` in `scripts/prerender.ts`, both through `normalizeSiteUrl`. A bare `import.meta.env` reference inside `seo.ts` would have pinned the module to Vite; keeping it environment-free is exactly what lets the same file run under Vite, under `bun test`, and under a bare Bun script.

The default matters because `applyHead` runs in the browser and needs the same base URL the prerender script used. Leaving it in `vite.config.ts` would define it for the HTML-substitution path only, and `import.meta.env.VITE_SITE_URL` would be `undefined` in any build where CI did not set it — producing `undefined/docs/...` canonicals on the client. One default, in the module that consumes it.

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
| unmatched, outside `/docs` | `dist/404.html` — root `notFoundComponent`, `noindex` |
| unmatched, under `/docs/*` | `dist/docs/404.html` — the docs **shell** with `DocNotFound`, `noindex` |
| `/docs` | *not prerendered* — a 301 (§7) |

**Correction to this section as originally written** (caught in the final whole-branch review, measured against `workerd` via `wrangler dev --local`, and fixed before merge):

The spec said `html_handling` stays at its default `auto-trailing-slash` and that "every existing URL is unchanged". Both were wrong. `auto-trailing-slash` serves a folder index only **with** the slash: `/docs/concepts/agents` **307s** to `/docs/concepts/agents/`, and only the slashed form returns 200. That is the no-trailing-slash form — the only form the site advertises, in every `<link rel="canonical">`, `og:url`, sitemap `<loc>`, internal `<Link>` and `llms.txt` line — so as specced, all 28 doc pages answered their own canonical URL with a redirect. It was also a regression against `main`, where SPA fallback answered them 200.

The shipped setting is **`html_handling: "drop-trailing-slash"`**, which inverts it: `/docs/concepts/agents` is 200, and the trailing-slash form 307s to it. Emitted paths, advertised URLs and this setting are one decision spread across three files; changing any one requires changing all three.

Two 404 documents, likewise a review correction. `not_found_handling: "404-page"` serves the **nearest** `404.html`, and the client router renders a different tree depending on where the miss landed — `/nope` matches nothing (root not-found), `/docs/bogus` matches the `docs.$` splat (the docs shell). A single root-level 404 under `/docs/*` therefore hydrated the docs shell against root-404 markup and was rejected outright (`Minified React error #418`), discarding every prerendered byte on a whole URL class. Relatedly, `DocNotFound` now renders the requested path only **after mount**: one file serves an unbounded URL set, so the slug it was built with is never the slug the browser is on, and rendering it in the first pass is a guaranteed text mismatch (also measured as a real `#418`).

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
- **404** (both documents) — `noindex`, no JSON-LD, `canonical: null`.

One shared `og.png` for every page. Per-page OG images are out of scope (§11).

### `sitemap.xml`

One `<url>` per prerendered page that **has a canonical**, absolute `<loc>` — which excludes the two 404 documents and nothing else (`notFoundSeo` sets `canonical: null`, and `renderSitemap` keys off precisely that null rather than a separate flag, so the two facts cannot diverge; adding the second 404 in the final review therefore needed no sitemap change at all).

Keying off the canonical rather than an indexability flag is what keeps the sitemap correct in a `noindex` preview build: there every page is `noindex`, and a flag-driven filter would emit an empty `<urlset>`. The sitemap stays well-formed and complete; `robots.txt`'s `Disallow: /` is what actually holds crawlers off a preview.

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

"Nearest" is load-bearing rather than incidental, which this section originally missed: it is what lets `dist/docs/404.html` cover `/docs/*` while `dist/404.html` covers everything else, and what makes two documents necessary in the first place (§5).

### `public/_redirects`

```
/docs   /docs/getting-started/overview  301
/docs/  /docs/getting-started/overview  301
```

The slashed form is a final-review addition: `html_handling` normalizes slashes only for paths that resolve to an **asset**, and `/docs` resolves to no file at all, so without the second rule `/docs/` falls through to the 404.

`docs.index.tsx` currently throws a client-side `redirect()` in `beforeLoad`. A crawler that does not run JS sees `/docs` return 200 with the app shell; one that does sees the overview's content at the `/docs` URL. Either way `/docs` competes with `/docs/getting-started/overview`. A 301 consolidates the signal at the edge. The route file stays for in-app navigation.

`_redirects` and `_headers` are natively supported by Workers static assets and must sit at the root of the asset directory — `public/` → `dist/` satisfies that.

### `public/_headers`

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

`vite.config.ts`'s `securityHeaders` applies these to the dev server and `vite preview` only. Its comment used to claim "GitHub Pages fronts the static build with its own headers" — stale since the Cloudflare migration; corrected in the final review to point at `public/_headers`. Workers adds neither header on its own. This restores dev/prod parity. No `X-Frame-Options`, matching the existing rationale: this is a public marketing site, framing is fine.

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
<noscript><style>[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}</style></noscript>
```

`!important` beats the inline style. `filter` is in the shipped rule and not optional: the hero headline spans serialize as `opacity:0;filter:blur(7px);transform:translateY(18px)`, so resetting only opacity and transform would leave the largest text on the page blurred.

Measured on the shipped build: `dist/index.html` carries ~35 inline `opacity:0` styles; `dist/docs/**` and both 404 documents carry **none**. The residual human cost is that `/` shows nav, wash and footer with a blank middle until hydration runs the reveals — accepted deliberately, since the alternative is dropping the landing entrance animations. Docs pages are unaffected — `.doc-prose` has no motion wrapper, so the SEO-valuable long-form content was never at risk.

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

- every doc frontmatter has a non-empty `title`, `section`, and `description` — checked *before* any rendering
- a doc exists matching `DOCS_INDEX_SLUG` — also *before* any rendering. That slug is hardcoded in `src/lib/seo.ts`, `src/routes/docs.index.tsx` and `public/_redirects`, and the two outside the build are silent on failure, so renaming one `.mdx` file would otherwise pass every guard while the edge 301 pointed at a URL that 404s
- no page embeds the build-time sentinel path it was rendered at (`__prerender_not_found__`) — the hydration contract for the two 404 documents, each of which is served for an unbounded set of URLs
- ~~the emitted page count matches `docEntries.length + 2`~~ — **specced, built, then removed in the final review as tautological.** `pages` is *constructed* as exactly that sum, so the check could never fire; a documented guard that cannot fire is worse than none, because it is counted as coverage
- every page's `#root` markup exceeds a minimum byte length and the document contains `<h1` — catches a silently-empty render, the characteristic SSG failure. Measured against the **app markup**, not the finished document: the template plus a page's JSON-LD head is 2.2–3.8 kB on its own, so a threshold applied to the whole file is satisfied by a completely empty `#root` and can never fire
- markup **opens** with `<!--$-->` — the root Suspense boundary is present and not displaced, without which no browser can hydrate the page (§3)
- no output contains a surviving `%VITE_SITE_URL%` or an unreplaced `<!--seo-->`
- canonicals are unique across all pages — catches a slug collision
- **no output contains a React streaming artifact**: `<!--$?-->` (unresolved boundary), `<!--$!-->` (errored boundary — its fallback shipped), `<div hidden id="S:` (the parking div), `$RC("B:` (the swap script), or the docs route's literal `Loading…` fallback markup. This is the guard the byte-length and `<h1>` checks cannot substitute for: a page can carry a perfect shell, a real `<h1>` and 20 kB of markup while its entire `<article>` body is a Suspense fallback. The markers are anchored to React's emitted form rather than matched as loose substrings, so a doc page that legitimately writes *about* `div hidden` or `$RC(` doesn't fail the build

### Not `vite preview`

`vite preview` cannot verify this build's serving behaviour and will mislead anyone who tries. It SPA-falls-back, so `/docs/concepts/agents` — the no-trailing-slash form every canonical, sitemap entry and internal link uses — returns the **landing page** at HTTP 200, nothing ever returns 404, and `_redirects` is inert so `/docs` is the landing page rather than a 301 (all measured).

Cloudflare differs on every one of those counts. **Verify against the real router**, which runs offline against `dist/` and needs no deploy — `wrangler` is already pinned in the repo-root `mise.toml`:

```sh
bun run --cwd apps/site build
cd apps/site && wrangler dev --local
```

This is not optional for a change in this area: a hand-rolled static server abstracts away exactly the redirect that made the original `html_handling` decision wrong (§5). Note `wrangler dev` watches the asset directory, so `rm -rf dist && bun run build` beneath a running server leaves it serving 404 for everything until restarted.

### Post-merge

Every line below was run against `wrangler dev --local` before merge and matched. As originally written the first line asserted `# 200` where the shipped config would have printed **307** — the check was correct, the config was not (§5).

```sh
curl -sI https://invisiblestring.io/docs/concepts/agents  | head -1        # 200, NOT a 307
curl -sI https://invisiblestring.io/docs/concepts/agents/ | head -1        # 307 → the unslashed form
curl -sI https://invisiblestring.io/docs/nonexistent-page | head -1        # 404
curl -sI https://invisiblestring.io/docs  | grep -i '^location'            # /docs/getting-started/overview
curl -sI https://invisiblestring.io/docs/ | grep -i '^location'            # /docs/getting-started/overview
curl -s  https://invisiblestring.io/docs/concepts/agents | grep -o '<title>[^<]*'
curl -s  https://invisiblestring.io/sitemap.xml | grep -c '<loc>'          # 29 — the two 404s are excluded
```

Then load `/docs/nonexistent-page` in a browser with the console open: it must render the docs shell (sidebar + TOC rail) with **no** `Minified React error #418`.

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
