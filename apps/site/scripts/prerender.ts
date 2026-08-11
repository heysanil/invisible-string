/**
 * Prerender every route to a static HTML file.
 *
 * Runs after both Vite builds: reads the client build's index.html as a
 * template, asks the server bundle to render each route, and writes the
 * result plus a per-page <head> into dist/.
 *
 * The page list is DERIVED from the server bundle's `docEntries` — the same
 * glob that drives the sidebar — so it cannot drift from the content tree.
 *
 * Runs under Bun, outside Vite, which is why everything it imports from src/
 * is glob-free and environment-free (see the header of src/lib/seo.ts).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { renderLlmsTxt } from "../src/lib/llms";
import {
  docSeo,
  landingSeo,
  normalizeSiteUrl,
  notFoundSeo,
  type PageSeo,
  renderHeadHtml,
  type SeoContext,
} from "../src/lib/seo";
import type { DocFrontmatter } from "../src/lib/sidebar";
import { renderRobots, renderSitemap } from "../src/lib/sitemap";

interface SsrBundle {
  renderPage(path: string): Promise<string>;
  docEntries: Array<{ slug: string; frontmatter: DocFrontmatter }>;
}

interface Page {
  /** Path within dist/, e.g. "docs/concepts/agents/index.html". */
  out: string;
  /** Route to render. */
  route: string;
  seo: PageSeo;
}

const APP_ROOT = resolve(import.meta.dir, "..");
const DIST = join(APP_ROOT, "dist");
const SSR_ENTRY = join(APP_ROOT, ".ssr/entry-server.js");
const TEMPLATE_FILE = join(DIST, "index.html");
const LLMS_TEMPLATE = join(APP_ROOT, "scripts/llms-template.md");

const SEO_MARKER = "<!--seo-->";
const ROOT_MARKER = '<div id="root"></div>';

/**
 * Below this, a "rendered" page is really an empty shell.
 *
 * Measured against `appHtml`, NOT the finished `html`: the template plus a
 * page's JSON-LD head is already 2.2–3.8 kB on its own, so a threshold
 * applied to the whole document is satisfied by a completely empty `#root`
 * and can never fire. The smallest real page (404) renders 4337 bytes, so
 * this sits ~4× below the floor — loose on purpose, since it exists to catch
 * catastrophe, and `renderPage` already rejects genuinely empty output.
 */
const MIN_APP_BYTES = 1000;

/**
 * Every page's markup must OPEN with React's completed-Suspense-boundary
 * marker. `PrerenderRootSuspense` (src/router.tsx) wraps the whole app so the
 * emitted HTML carries the boundary the browser renders, and `hydrateRoot`
 * matches a `<Suspense>` against exactly this comment pair.
 *
 * This is deliberately HALF a guard, and the half matters: it catches the
 * SERVER side going out of shape — `InnerWrap` dropped, or moved inside the
 * `isServer` branch by a router upgrade, or something rendering ahead of it.
 * It CANNOT see the client side. If a future `@tanstack/react-router` changes
 * what the browser wraps `Matches` in, this check still passes and hydration
 * still silently breaks; only a real browser catches that.
 *
 * One related hazard it also cannot see: `router-core/isServer/server.js` is
 * `process.env.NODE_ENV === "test" ? undefined : true`, so a build run under
 * `NODE_ENV=test` makes `Matches` emit its own boundary IN ADDITION to
 * `PrerenderRootSuspense` — a doubled boundary that still starts with this
 * marker and still fails to hydrate. Don't build the site with NODE_ENV=test.
 */
const ROOT_BOUNDARY = "<!--$-->";

/**
 * Markers React leaves behind when a page's content is streamed, swapped in by
 * JavaScript, or replaced by a fallback after a render error. Byte-length and
 * `<h1>` checks do NOT catch these: the shell renders fine and only the
 * suspended subtree is missing, so both pass while the page ships empty. A
 * page carrying any of these has content a crawler will never see, which
 * defeats the entire point of prerendering.
 *
 * ANCHORED to React's emitted form rather than matched as loose substrings.
 * Bare `Loading…`, `div hidden` or `$RC(` are all things a doc page could
 * legitimately say — prose, a code sample, an HTML snippet — and a false
 * positive here fails the build with a message blaming React for the author's
 * paragraph. Nothing in the tree collides today; anchoring keeps it that way.
 * The two comment markers need no anchor: React escapes `<` in rendered text,
 * so they cannot appear except as real markers.
 */
const FORBIDDEN_ARTIFACTS: ReadonlyArray<[marker: string, why: string]> = [
  ["<!--$?-->", "an unresolved streaming Suspense boundary"],
  ["<!--$!-->", "an errored Suspense boundary — its fallback shipped instead"],
  ['<div hidden id="S:', "React's hidden parking div for a streamed segment"],
  ['$RC("B:', "React's Fizz swap-script runtime"],
  [
    'class="text-sm text-ink-3">Loading…<',
    "the docs route's Suspense fallback (routes/docs.$.tsx)",
  ],
];

const problems: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

async function emit(relPath: string, contents: string): Promise<void> {
  const file = join(DIST, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function main(): Promise<void> {
  const ctx: SeoContext = {
    siteUrl: normalizeSiteUrl(process.env.VITE_SITE_URL),
    // Fail-safe: ONLY the production deploy sets this. Preview versions, local
    // previews and manual uploads all emit noindex + Disallow: / so they
    // cannot compete with production in search results.
    indexable: process.env.SITE_INDEXABLE === "1",
  };

  const bundle = (await import(SSR_ENTRY)) as SsrBundle;
  const { docEntries, renderPage } = bundle;
  const template = await readFile(TEMPLATE_FILE, "utf8");

  if (!template.includes(SEO_MARKER) || !template.includes(ROOT_MARKER)) {
    throw new Error(
      `dist/index.html is missing ${SEO_MARKER} or ${ROOT_MARKER}, so every injection below would silently no-op.\n` +
        `  Most likely: this script was run on its own. It reads dist/index.html as its template AND overwrites it, so a second run in a row finds a rendered page with nothing left to substitute — re-run \`bun run build\` (or at least \`build:client\`) first.\n` +
        `  Otherwise the client build has changed shape and index.html no longer carries both markers.`,
    );
  }

  // Frontmatter guard, before any rendering: a missing description would
  // otherwise ship as an empty meta tag on a live page.
  for (const entry of docEntries) {
    for (const field of ["title", "section", "description"] as const) {
      const value = entry.frontmatter[field];
      if (typeof value !== "string" || value.trim() === "") {
        fail(`${entry.slug}.mdx: frontmatter "${field}" is missing or empty`);
      }
    }
  }
  if (problems.length > 0) report();

  // CLOSED list: the landing page, one page per doc entry, and the 404. It is
  // built from `docEntries` and accepts no arbitrary path, so what lands in
  // dist/ is exactly the site's real page set — in particular, `/docs` must
  // NEVER appear here. `renderPage("/docs")` succeeds (it follows the route
  // redirect and returns markup byte-identical to /docs/getting-started/
  // overview), which makes adding it look harmless, but `/docs` has no page of
  // its own: public/_redirects 301s it to the overview, so no file should
  // exist at that path.
  //
  // To be clear about what the hazard is NOT: the file would not shadow the
  // redirect. Cloudflare's static-asset redirects take PRECEDENCE over assets
  // — "Redirects are always followed, regardless of whether or not an asset
  // matches the incoming request" (developers.cloudflare.com/workers/
  // static-assets/redirects/). It would be a second copy of the overview's
  // HTML uploaded on every deploy at a URL the site deliberately does not
  // serve — dead weight that one `_redirects` or `html_handling` change turns
  // into the live duplicate the 301 exists to prevent.
  const pages: Page[] = [
    { out: "index.html", route: "/", seo: landingSeo(ctx) },
    ...docEntries.map((entry) => ({
      out: `docs/${entry.slug}/index.html`,
      route: `/docs/${entry.slug}`,
      seo: docSeo(entry.slug, entry.frontmatter, ctx),
    })),
    // Rendering an unmatched route drives the root route's notFoundComponent.
    { out: "404.html", route: "/__prerender_not_found__", seo: notFoundSeo(ctx) },
  ];

  // Sequential: 30 pages, and a shared module registry makes concurrency here
  // a false economy.
  for (const page of pages) {
    const appHtml = await renderPage(page.route);
    // Callback replacements, deliberately: `String.replace` expands `$&`,
    // `$1`, "$`" and `$'` inside a replacement STRING even when the pattern is
    // a plain string, so a description or a doc body containing one would
    // silently corrupt the emitted <head> or <body> with no error anywhere. A
    // function replacement is inserted verbatim. Don't "simplify" these back.
    const html = template
      .replace(SEO_MARKER, () => renderHeadHtml(page.seo))
      .replace(ROOT_MARKER, () => `<div id="root">${appHtml}</div>`);

    if (appHtml.length < MIN_APP_BYTES) {
      fail(`${page.out}: rendered only ${appHtml.length} bytes into #root — an empty shell`);
    }
    if (!appHtml.startsWith(ROOT_BOUNDARY)) {
      fail(
        `${page.out}: markup does not open with ${ROOT_BOUNDARY} — the root Suspense boundary is missing or displaced, so no browser can hydrate this page (see PrerenderRootSuspense in src/router.tsx)`,
      );
    }
    if (!html.includes("<h1")) {
      fail(`${page.out}: no <h1> in the output — the route rendered nothing`);
    }
    if (html.includes(SEO_MARKER)) {
      fail(`${page.out}: the ${SEO_MARKER} marker survived`);
    }
    if (html.includes("%VITE_SITE_URL%")) {
      fail(`${page.out}: an unsubstituted %VITE_SITE_URL% placeholder survived`);
    }
    for (const [marker, why] of FORBIDDEN_ARTIFACTS) {
      if (html.includes(marker)) {
        fail(`${page.out}: contains ${marker} — ${why}; its content is not really in the file`);
      }
    }

    await emit(page.out, html);
  }

  const canonicals = new Set<string>();
  for (const page of pages) {
    if (!page.seo.canonical) continue;
    if (canonicals.has(page.seo.canonical)) {
      fail(`duplicate canonical ${page.seo.canonical} — two pages claim the same URL`);
    }
    canonicals.add(page.seo.canonical);
  }

  const expected = docEntries.length + 2;
  if (pages.length !== expected) {
    fail(`emitted ${pages.length} pages, expected ${expected}`);
  }

  await emit("sitemap.xml", renderSitemap(pages.map((p) => p.seo)));
  await emit("robots.txt", renderRobots(ctx));
  await emit(
    "llms.txt",
    renderLlmsTxt(
      await readFile(LLMS_TEMPLATE, "utf8"),
      docEntries.map((e) => [e.slug, e.frontmatter] as [string, DocFrontmatter]),
    ),
  );

  if (problems.length > 0) report();

  console.log(
    `prerendered ${pages.length} pages → dist/  (site ${ctx.siteUrl}, ${
      ctx.indexable ? "indexable" : "noindex"
    })`,
  );
}

function report(): never {
  console.error(`\nprerender failed:\n${problems.map((p) => `  · ${p}`).join("\n")}\n`);
  process.exit(1);
}

// `.catch` rather than a bare top-level `await main()`: an unhandled rejection
// here would print a stack and still exit 0 under some runners, which would let
// a broken build deploy. This guarantees a non-zero exit.
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
