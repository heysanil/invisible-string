import { describe, expect, test } from "bun:test";

import type { DocFrontmatter } from "../lib/sidebar";
import {
  DEFAULT_SITE_URL,
  docSeo,
  escapeHtml,
  landingSeo,
  normalizeSiteUrl,
  notFoundSeo,
  renderHeadHtml,
  type SeoContext,
  seoForPath,
} from "../lib/seo";

const ctx: SeoContext = { siteUrl: "https://example.com", indexable: true };
const previewCtx: SeoContext = { siteUrl: "https://example.com", indexable: false };

const agents: DocFrontmatter = {
  title: "Agents",
  section: "Concepts",
  order: 20,
  description: "An Agent is a role you define.",
};

describe("normalizeSiteUrl", () => {
  test("defaults to the dev origin when unset or blank", () => {
    expect(normalizeSiteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(normalizeSiteUrl("   ")).toBe(DEFAULT_SITE_URL);
  });

  test("strips a trailing slash so joins never double up", () => {
    expect(normalizeSiteUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeSiteUrl("https://example.com")).toBe("https://example.com");
  });
});

describe("docSeo", () => {
  test("builds a page-specific title, description and canonical", () => {
    const seo = docSeo("concepts/agents", agents, ctx);
    expect(seo.title).toBe("Agents — invisible-string docs");
    expect(seo.description).toBe("An Agent is a role you define.");
    expect(seo.canonical).toBe("https://example.com/docs/concepts/agents");
    expect(seo.ogType).toBe("article");
    expect(seo.robots).toBe("index,follow");
  });

  test("carries TechArticle and BreadcrumbList structured data", () => {
    const types = docSeo("concepts/agents", agents, ctx).jsonLd.map(
      (node) => (node as { "@type": string })["@type"],
    );
    expect(types).toEqual(["TechArticle", "BreadcrumbList"]);
  });

  test("goes noindex when the build is not indexable", () => {
    expect(docSeo("concepts/agents", agents, previewCtx).robots).toBe("noindex,nofollow");
  });
});

describe("landingSeo", () => {
  test("canonicals the site root and declares SoftwareApplication", () => {
    const seo = landingSeo(ctx);
    expect(seo.canonical).toBe("https://example.com/");
    expect(seo.ogType).toBe("website");
    expect(seo.jsonLd.map((n) => (n as { "@type": string })["@type"])).toEqual([
      "SoftwareApplication",
      "Organization",
    ]);
  });
});

describe("notFoundSeo", () => {
  test("is always noindex and has no canonical, even in a production build", () => {
    const seo = notFoundSeo(ctx);
    expect(seo.robots).toBe("noindex,nofollow");
    expect(seo.canonical).toBeNull();
  });
});

describe("seoForPath", () => {
  const docs = new Map<string, DocFrontmatter>([["concepts/agents", agents]]);

  test("resolves the landing page", () => {
    expect(seoForPath("/", docs, ctx).canonical).toBe("https://example.com/");
  });

  test("resolves a doc page, tolerating a trailing slash", () => {
    expect(seoForPath("/docs/concepts/agents", docs, ctx).title).toBe(
      "Agents — invisible-string docs",
    );
    expect(seoForPath("/docs/concepts/agents/", docs, ctx).title).toBe(
      "Agents — invisible-string docs",
    );
  });

  test("resolves bare /docs to the overview target rather than not-found", () => {
    const withOverview = new Map(docs);
    withOverview.set("getting-started/overview", {
      title: "Overview",
      section: "Getting started",
      order: 10,
      description: "What invisible-string is.",
    });
    expect(seoForPath("/docs", withOverview, ctx).title).toBe(
      "Overview — invisible-string docs",
    );
  });

  test("falls back to not-found for an unknown slug", () => {
    expect(seoForPath("/docs/nope", docs, ctx).canonical).toBeNull();
  });
});

describe("escapeHtml", () => {
  test("escapes the four characters that can break an attribute", () => {
    expect(escapeHtml(`a & b < c > d "e"`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot;",
    );
  });
});

describe("renderHeadHtml", () => {
  const seo = docSeo("concepts/agents", agents, ctx);

  test("emits exactly one title, description, robots and canonical", () => {
    const html = renderHeadHtml(seo);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain("<title>Agents — invisible-string docs</title>");
    expect(html).toContain('<meta name="robots" content="index,follow" />');
    expect(html).toContain(
      '<link rel="canonical" href="https://example.com/docs/concepts/agents" />',
    );
  });

  test("omits the canonical and og:url when there is none", () => {
    const html = renderHeadHtml(notFoundSeo(ctx));
    expect(html).not.toContain("rel=\"canonical\"");
    expect(html).not.toContain("og:url");
  });

  test("escapes metadata so a quote cannot break out of an attribute", () => {
    const quoted: DocFrontmatter = { ...agents, description: 'He said "no" & left' };
    const html = renderHeadHtml(docSeo("concepts/agents", quoted, ctx));
    expect(html).toContain(
      '<meta name="description" content="He said &quot;no&quot; &amp; left" />',
    );
  });

  test("escapes < inside JSON-LD so a payload cannot close the script tag", () => {
    const hostile: DocFrontmatter = { ...agents, description: "</script><script>x" };
    const html = renderHeadHtml(docSeo("concepts/agents", hostile, ctx));
    expect(html).not.toContain("</script><script>x");
    expect(html).toContain("\\u003c/script");
  });

  test("every JSON-LD block is valid parseable JSON", () => {
    const html = renderHeadHtml(seo);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)];
    expect(blocks).toHaveLength(2);
    for (const [, json] of blocks) {
      expect(() => JSON.parse(json!.replace(/\\u003c/g, "<"))).not.toThrow();
    }
  });
});
