/**
 * `sitemap.xml` and `robots.txt`, both generated at build time because both
 * embed the absolute site URL, which is only known then.
 *
 * Pure — same rationale as lib/seo.ts: importable from `bun test` and from
 * `scripts/prerender.ts` alike.
 */
import type { PageSeo, SeoContext } from "./seo";

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * One `<url>` per page that has a canonical. A null canonical means the page
 * must not be advertised — today that is exactly the 404, and keying off the
 * canonical rather than a separate flag keeps the two facts from diverging.
 *
 * No `<lastmod>`: CI clones at depth 1, so per-file git dates are unavailable
 * and every entry would carry the build timestamp. Google discounts `lastmod`
 * it finds unreliable across the whole sitemap, so a uniform wrong date is
 * worse than none. Adding it means `fetch-depth: 0` first.
 */
export function renderSitemap(pages: PageSeo[]): string {
  const seen = new Set<string>();
  const locs: string[] = [];

  for (const page of pages) {
    if (!page.canonical || seen.has(page.canonical)) continue;
    seen.add(page.canonical);
    locs.push(`  <url><loc>${escapeXml(page.canonical)}</loc></url>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * A non-indexable build (anything but the production deploy) disallows
 * everything. Preview versions publish a complete copy of the site at a
 * workers.dev URL; without this they compete with production in search.
 */
export function renderRobots(ctx: SeoContext): string {
  if (!ctx.indexable) {
    return ["User-agent: *", "Disallow: /", ""].join("\n");
  }
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${ctx.siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
}
