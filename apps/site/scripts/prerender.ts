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
/** Below this, a "rendered" page is really an empty shell. */
const MIN_PAGE_BYTES = 2000;

/**
 * Markers React leaves behind when a page's content is streamed, swapped in by
 * JavaScript, or replaced by a fallback after a render error. Byte-length and
 * `<h1>` checks do NOT catch these: the shell renders fine and only the
 * suspended subtree is missing, so both pass while the page ships empty. A
 * page carrying any of these has content a crawler will never see, which
 * defeats the entire point of prerendering.
 */
const FORBIDDEN_ARTIFACTS: ReadonlyArray<[marker: string, why: string]> = [
  ["<!--$?-->", "an unresolved streaming Suspense boundary"],
  ["<!--$!-->", "an errored Suspense boundary — its fallback shipped instead"],
  ["div hidden", "React's hidden parking div for a streamed segment"],
  ["$RC(", "React's Fizz swap-script runtime"],
  ["Loading…", "the docs route's Suspense fallback (routes/docs.$.tsx)"],
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
      `dist/index.html is missing ${SEO_MARKER} or ${ROOT_MARKER} — the client build has changed shape and every injection would silently no-op`,
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

  // CLOSED list: the landing page, one page per doc entry, and the 404. Never
  // build it from an arbitrary path — in particular, `/docs` must NEVER appear
  // here. `renderPage("/docs")` succeeds (it follows the route redirect and
  // returns markup byte-identical to /docs/getting-started/overview), so
  // adding it would write dist/docs/index.html — and a Cloudflare assets-only
  // Worker serves a matching asset BEFORE it evaluates redirect rules, so that
  // file would shadow the /docs → overview 301 and reintroduce exactly the
  // duplicate-content problem the redirect exists to prevent.
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

    if (html.length < MIN_PAGE_BYTES) {
      fail(`${page.out}: only ${html.length} bytes — the render produced an empty shell`);
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
