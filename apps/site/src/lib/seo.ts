/**
 * Every piece of page metadata the site emits, in one pure module.
 *
 * Pure on purpose: no `import.meta.glob`, no `.mdx` import, no route import,
 * and no environment access — callers pass `siteUrl` in. That keeps it
 * importable from `bun test` (which cannot run Vite plugins) AND from
 * `scripts/prerender.ts` (which runs under Bun, outside Vite entirely).
 *
 * Two renderers over one model:
 *  - `renderHeadHtml` → a string, injected into the template at build time.
 *    This is what crawlers actually read.
 *  - `applyHead` → DOM mutation, for SPA navigation. Humans only; a crawler
 *    never needs it. It deliberately does NOT touch the robots meta, which is
 *    owned by the build (see `SeoContext.indexable`).
 */
import type { DocFrontmatter } from "./sidebar";

export const SITE_NAME = "invisible-string";
export const REPO_URL = "https://github.com/heysanil/invisible-string";

/** Local default so canonicals never render as `undefined/docs/…`. */
export const DEFAULT_SITE_URL = "http://localhost:5173";

const LANDING_TITLE = "invisible-string — describe the work, consider it done";
const LANDING_DESCRIPTION =
  "Build an agent with a role, a model, and the tools it needs. Chat with it directly — or put it on standing duty from Slack, forms, webhooks, or a schedule. More time for the work only you can do.";

export interface SeoContext {
  /** Absolute origin with no trailing slash — see `normalizeSiteUrl`. */
  siteUrl: string;
  /**
   * True ONLY for the production deploy (`SITE_INDEXABLE=1`). Every other
   * build — preview versions, local `vite preview`, a manual upload — emits
   * `noindex` so a duplicate of the site cannot compete with production in
   * search results. Required rather than optional so a caller that forgets it
   * fails to compile instead of silently publishing an indexable copy.
   */
  indexable: boolean;
}

export interface PageSeo {
  /** Route path, leading slash, no trailing slash (except "/"). */
  path: string;
  title: string;
  description: string;
  /** Absolute canonical URL, or null for pages that must not have one (404). */
  canonical: string | null;
  ogImage: string;
  ogType: "website" | "article";
  robots: "index,follow" | "noindex,nofollow";
  jsonLd: object[];
}

/** Trim, default, and strip a trailing slash so path joins never double up. */
export function normalizeSiteUrl(raw: string | undefined): string {
  const base = raw?.trim() ? raw.trim() : DEFAULT_SITE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function absolute(ctx: SeoContext, path: string): string {
  return `${ctx.siteUrl}${path}`;
}

function robotsFor(ctx: SeoContext, forceNoindex: boolean): PageSeo["robots"] {
  return forceNoindex || !ctx.indexable ? "noindex,nofollow" : "index,follow";
}

/** Organization node WITHOUT `@context` — safe to nest inside another node. */
function organizationNode(ctx: SeoContext): object {
  return {
    "@type": "Organization",
    name: SITE_NAME,
    url: `${ctx.siteUrl}/`,
    logo: absolute(ctx, "/favicon.svg"),
    sameAs: [REPO_URL],
  };
}

export function landingSeo(ctx: SeoContext): PageSeo {
  return {
    path: "/",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    canonical: `${ctx.siteUrl}/`,
    ogImage: absolute(ctx, "/og.png"),
    ogType: "website",
    robots: robotsFor(ctx, false),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        description: LANDING_DESCRIPTION,
        url: `${ctx.siteUrl}/`,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web, Docker",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      { "@context": "https://schema.org", ...organizationNode(ctx) },
    ],
  };
}

export function docSeo(
  slug: string,
  fm: DocFrontmatter,
  ctx: SeoContext,
): PageSeo {
  const path = `/docs/${slug}`;
  const canonical = absolute(ctx, path);
  return {
    path,
    title: `${fm.title} — ${SITE_NAME} docs`,
    description: fm.description,
    canonical,
    ogImage: absolute(ctx, "/og.png"),
    ogType: "article",
    robots: robotsFor(ctx, false),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: fm.title,
        description: fm.description,
        url: canonical,
        inLanguage: "en",
        articleSection: fm.section,
        isPartOf: {
          "@type": "WebSite",
          name: `${SITE_NAME} docs`,
          url: absolute(ctx, "/docs"),
        },
        publisher: organizationNode(ctx),
      },
      {
        // Two levels only. schema.org permits the LAST item to omit `item`,
        // but a MIDDLE item without one is discouraged — and sections are not
        // pages, so they have no URL to give. The section rides the
        // TechArticle's `articleSection` instead.
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Docs",
            item: absolute(ctx, "/docs"),
          },
          { "@type": "ListItem", position: 2, name: fm.title, item: canonical },
        ],
      },
    ],
  };
}

export function notFoundSeo(ctx: SeoContext): PageSeo {
  return {
    path: "/404",
    title: `Page not found — ${SITE_NAME}`,
    description: "That page doesn't exist.",
    // No canonical, ever. A 404 that claims to be the canonical version of
    // some other URL is worse than no canonical at all — and `renderSitemap`
    // uses exactly this null to exclude the page from the sitemap.
    canonical: null,
    ogImage: absolute(ctx, "/og.png"),
    ogType: "website",
    robots: robotsFor(ctx, true),
    jsonLd: [],
  };
}

const DOCS_PREFIX = "/docs/";
/** Where bare `/docs` lands — must match `src/routes/docs.index.tsx`. */
export const DOCS_INDEX_SLUG = "getting-started/overview";

/**
 * Resolve a router pathname to its metadata. Used by the client on navigation;
 * the prerender script builds its pages from `docEntries` directly instead.
 */
export function seoForPath(
  pathname: string,
  docs: ReadonlyMap<string, DocFrontmatter>,
  ctx: SeoContext,
): PageSeo {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  if (path === "" || path === "/") return landingSeo(ctx);

  // `/docs` redirects to the overview, so report the overview's metadata
  // rather than flashing not-found for the frame before the redirect lands.
  const slug = path === "/docs" ? DOCS_INDEX_SLUG : path.startsWith(DOCS_PREFIX) ? path.slice(DOCS_PREFIX.length) : null;
  if (slug) {
    const fm = docs.get(slug);
    if (fm) return docSeo(slug, fm, ctx);
  }

  return notFoundSeo(ctx);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** JSON-LD payload text. `<` is escaped so no value can close the script tag. */
function jsonLdText(node: object): string {
  return JSON.stringify(node).replace(/</g, "\\u003c");
}

/** The inner HTML of `<head>` for one page. Injected at `<!--seo-->`. */
export function renderHeadHtml(seo: PageSeo): string {
  const lines: string[] = [];
  const meta = (attr: "name" | "property", key: string, content: string) => {
    lines.push(`<meta ${attr}="${key}" content="${escapeHtml(content)}" />`);
  };

  lines.push(`<title>${escapeHtml(seo.title)}</title>`);
  meta("name", "description", seo.description);
  meta("name", "robots", seo.robots);
  if (seo.canonical) {
    lines.push(`<link rel="canonical" href="${escapeHtml(seo.canonical)}" />`);
  }

  meta("property", "og:type", seo.ogType);
  meta("property", "og:site_name", SITE_NAME);
  meta("property", "og:title", seo.title);
  meta("property", "og:description", seo.description);
  meta("property", "og:image", seo.ogImage);
  if (seo.canonical) meta("property", "og:url", seo.canonical);

  meta("name", "twitter:card", "summary_large_image");
  meta("name", "twitter:title", seo.title);
  meta("name", "twitter:description", seo.description);
  meta("name", "twitter:image", seo.ogImage);

  for (const node of seo.jsonLd) {
    lines.push(
      `<script type="application/ld+json">${jsonLdText(node)}</script>`,
    );
  }

  return lines.join("\n    ");
}

function setMeta(
  doc: Document,
  attr: "name" | "property",
  key: string,
  content: string,
): void {
  let el = doc.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = doc.createElement("meta");
    el.setAttribute(attr, key);
    doc.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function removeMeta(doc: Document, attr: "name" | "property", key: string): void {
  doc.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)?.remove();
}

function setCanonical(doc: Document, href: string | null): void {
  const el = doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!href) {
    el?.remove();
    return;
  }
  if (el) {
    el.setAttribute("href", href);
    return;
  }
  const link = doc.createElement("link");
  link.setAttribute("rel", "canonical");
  link.setAttribute("href", href);
  doc.head.appendChild(link);
}

/**
 * Update the live document head after a client-side navigation.
 *
 * Updates in place rather than appending, so repeated navigations cannot
 * accumulate duplicate tags. Deliberately does NOT write `robots` (owned by
 * the build — rewriting it here would let a preview build un-noindex itself
 * the moment a user clicked a link) or `og:image` (constant for every page).
 */
export function applyHead(seo: PageSeo, doc: Document): void {
  doc.title = seo.title;
  setMeta(doc, "name", "description", seo.description);
  setMeta(doc, "property", "og:type", seo.ogType);
  setMeta(doc, "property", "og:title", seo.title);
  setMeta(doc, "property", "og:description", seo.description);
  setMeta(doc, "name", "twitter:title", seo.title);
  setMeta(doc, "name", "twitter:description", seo.description);
  setCanonical(doc, seo.canonical);
  // `og:url` tracks the canonical exactly, INCLUDING its absence: navigating
  // from a doc to an unknown path must not leave the previous page's URL
  // behind claiming to be this one's.
  if (seo.canonical) setMeta(doc, "property", "og:url", seo.canonical);
  else removeMeta(doc, "property", "og:url");
}
