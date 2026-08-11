import { describe, expect, test } from "bun:test";

import { landingSeo, notFoundSeo, type PageSeo, type SeoContext } from "../lib/seo";
import { renderRobots, renderSitemap } from "../lib/sitemap";

const ctx: SeoContext = { siteUrl: "https://example.com", indexable: true };
const previewCtx: SeoContext = { siteUrl: "https://example.com", indexable: false };

function page(canonical: string | null): PageSeo {
  return { ...landingSeo(ctx), canonical };
}

describe("renderSitemap", () => {
  test("emits one absolute loc per page", () => {
    const xml = renderSitemap([
      page("https://example.com/"),
      page("https://example.com/docs/concepts/agents"),
    ]);
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/docs/concepts/agents</loc>");
    expect(xml.match(/<loc>/g)).toHaveLength(2);
  });

  test("excludes pages with no canonical — which is exactly the 404", () => {
    const xml = renderSitemap([page("https://example.com/"), notFoundSeo(ctx)]);
    expect(xml.match(/<loc>/g)).toHaveLength(1);
  });

  test("emits no lastmod (a build-time date on every page is worse than none)", () => {
    expect(renderSitemap([page("https://example.com/")])).not.toContain("lastmod");
  });

  test("deduplicates repeated canonicals", () => {
    const xml = renderSitemap([page("https://example.com/"), page("https://example.com/")]);
    expect(xml.match(/<loc>/g)).toHaveLength(1);
  });

  test("XML-escapes ampersands in a URL", () => {
    const xml = renderSitemap([page("https://example.com/a?x=1&y=2")]);
    expect(xml).toContain("<loc>https://example.com/a?x=1&amp;y=2</loc>");
  });

  test("declares the sitemap namespace and XML prolog", () => {
    const xml = renderSitemap([page("https://example.com/")]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  });
});

describe("renderRobots", () => {
  test("allows everything and names the sitemap for an indexable build", () => {
    const txt = renderRobots(ctx);
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Sitemap: https://example.com/sitemap.xml");
    expect(txt).not.toContain("Disallow: /");
  });

  test("disallows everything for a preview build", () => {
    const txt = renderRobots(previewCtx);
    expect(txt).toContain("Disallow: /");
    expect(txt).not.toContain("Sitemap:");
  });
});
