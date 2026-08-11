# apps/site Static Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prerender every `apps/site` route to a static HTML file with complete, page-specific `<head>` metadata, so the marketing site and docs are fully crawlable without JavaScript.

**Architecture:** `vite build` produces the client bundle and an `index.html` template. A second `vite build --ssr` produces a server bundle exporting `renderPage(path)`, which renders the TanStack router over a memory history using React 19's `prerender()` from `react-dom/static` (it waits for the `React.lazy` MDX bodies to resolve; `renderToString` cannot). A Bun script then walks the derived page list, injects rendered markup and a generated `<head>` into the template, and writes `dist/**/index.html` plus `sitemap.xml`, `robots.txt`, and `llms.txt`. The client switches to `hydrateRoot`. The `<head>` never participates in hydration — the build owns the static head, and a small imperative `applyHead` updates it on SPA navigation.

**Tech Stack:** Vite 8, React 19 (`react-dom/static`), TanStack Router 1.170, MDX via `@mdx-js/rollup`, Bun (test runner + script runtime), Cloudflare Workers static assets.

**Spec:** `docs/superpowers/specs/2026-08-11-site-static-generation-design.md`

## Global Constraints

- **Package manager is bun.** All commands run from the repo root unless stated; site commands use `bun run --cwd apps/site <script>`.
- **No MDX in tests.** `bun test` cannot run Vite plugins. No file under `src/__tests__/` may import an `.mdx` file, a route file, `src/lib/docs.ts`, or anything using `import.meta.glob`. New logic that needs testing must live in a glob-free module, exactly as `src/lib/sidebar.ts` and `src/lib/toc.ts` already do.
- **E1 design system is law.** No task in this plan changes any visual style. `data-reveal` is a behavioral attribute only.
- **Conventional commits, and commit messages never mention AI assistance.** No `Co-Authored-By` trailers.
- **TypeScript strict.** `bun run --cwd apps/site typecheck` must pass at the end of every task.
- **Every URL currently served must keep working.** `html_handling` stays at its default `auto-trailing-slash`; no route path changes.
- **`SITE_INDEXABLE` is fail-safe.** Only the literal value `1` makes a build indexable. Anything else — including unset — emits `noindex` on every page and `Disallow: /` in robots.txt.
- **Canonical site URL** is `https://invisiblestring.io`; local default is `http://localhost:5173`.
- **Never `git clean -fd .changeset`** — Task 9 writes an untracked changeset file.

---

### Task 1: Add `description` to doc frontmatter

Every one of the 28 docs pages needs a meta description. This task adds the field to the type in all three places it is declared, writes the 28 values, and fixes the one test fixture that constructs a `DocFrontmatter` by hand.

**Files:**
- Modify: `apps/site/src/lib/sidebar.ts:4-8` (the `DocFrontmatter` interface)
- Modify: `apps/site/src/types/mdx.d.ts:5-9` (the `*.mdx` module declaration)
- Modify: all 28 files under `apps/site/src/content/docs/**/*.mdx` (frontmatter block only)
- Test: `apps/site/src/__tests__/sidebar.test.ts:11-13` (the `fm()` helper)

**Interfaces:**
- Consumes: nothing.
- Produces: `DocFrontmatter { title: string; section: string; order: number; description: string }` — every later task depends on `description` being a required, non-empty string.

- [ ] **Step 1: Add the field to the shared interface**

In `apps/site/src/lib/sidebar.ts`, replace the `DocFrontmatter` interface:

```ts
/** Frontmatter schema every doc MDX file must declare (see src/types/mdx.d.ts).
 *  Defined here (not in lib/docs.ts) so pure consumers/tests can import it
 *  without pulling in lib/docs.ts's `import.meta.glob`. */
export interface DocFrontmatter {
  title: string;
  section: string;
  order: number;
  /** Meta description for this page. Required — `scripts/prerender.ts` fails
   *  the build on a missing or empty value, so a new doc cannot ship without
   *  one. Aim for 110–155 characters: longer is truncated in search results. */
  description: string;
}
```

- [ ] **Step 2: Add the field to the MDX module declaration**

In `apps/site/src/types/mdx.d.ts`, replace the `frontmatter` export:

```ts
  /** YAML frontmatter, surfaced by remark-mdx-frontmatter as a named export. */
  export const frontmatter: {
    title: string;
    section: string;
    order: number;
    description: string;
  };
```

- [ ] **Step 3: Fix the test fixture so the suite still typechecks**

In `apps/site/src/__tests__/sidebar.test.ts`, replace the `fm` helper:

```ts
function fm(title: string, section: string, order: number): DocFrontmatter {
  return { title, section, order, description: `${title} description` };
}
```

- [ ] **Step 4: Run the existing suite to confirm nothing regressed**

Run: `bun test apps/site`
Expected: PASS — `sidebar.test.ts` and `toc.test.tsx` both green.

- [ ] **Step 5: Add `description:` to each of the 28 MDX frontmatter blocks**

Insert a `description:` line after `order:` in each file's frontmatter. Values below are written against each page's actual opening content — read the page's intro before changing one, and keep the copy in the site's voice (plain, concrete, no marketing adjectives).

Because these values contain colons and em-dashes, **quote every one** so the YAML parses.

| File | `description:` |
|---|---|
| `building/agent-editor.mdx` | `"Persona, Model, Context, and Access in one editor — with autosave to the draft, per-section validation, and the AI copilot docked alongside."` |
| `building/chat.mdx` | `"Hand work to a published Agent and watch it happen: runs stream live, showing what it said, what it did, and anything it needs before it can continue."` |
| `building/context-mcp.mdx` | `"The library your Agents are equipped from — adding MCP connections from the catalog, registry, or a custom URL, plus their credentials, health, and tools."` |
| `building/copilot.mdx` | `"An AI copilot docked in both editors. It reads your draft and workspace inventory and proposes typed edits, on the platform's credentials rather than your own key."` |
| `building/models.mdx` | `"Agents pick a preset — powerful, balanced, or quick — not a raw model. How presets resolve against the allowlist, and why changes land on the next publish."` |
| `building/settings.mdx` | `"Workspace configuration across five panels — Models, Allowlist, Integrations, Members, and Workspace — and what each role can actually change."` |
| `building/skills.mdx` | `"A skill is authored knowledge, markdown plus attachments, packaged into an Agent's artifact when equipped. A connection gives tools; a skill gives something to know."` |
| `building/triggers.mdx` | `"The five ways a Workflow fires — chat, webhook, form, Slack, and schedule — and how every one authenticates, normalizes, and dispatches the same way."` |
| `building/workflow-editor.mdx` | `"A single column that reads like a delegation memo: when it happens, who handles it, and what they should do — with @ autocomplete from the Agent's context."` |
| `concepts/agents.mdx` | `"An Agent is a role you define — who it is, how it thinks, and what it's equipped with. Chat with a published one directly, or put it on standing duty."` |
| `concepts/sessions-and-runs.mdx` | `"A session is a conversation with a published Agent; a run is one execution inside it. How sessions pin an agent version and stream progress back live."` |
| `concepts/workflows.mdx` | `"A Workflow is a standing delegation in three parts — Trigger, Agent, Instructions — the way you'd tell an assistant to watch for something and act on it."` |
| `concepts/workspaces.mdx` | `"Every Agent, Workflow, session, connection, and secret belongs to a workspace. How multi-tenancy, roles, and first-run seeding work."` |
| `getting-started/deploy-your-own.mdx` | `"invisible-string is self-hostable. The whole platform runs as one single-host Docker Compose stack: web, control plane, worker, Postgres, Garage, and Meilisearch."` |
| `getting-started/overview.mdx` | `"Give an Agent a role, a model, and the tools it needs, then chat with it like a teammate — or put it on standing duty from Slack, forms, webhooks, or a schedule."` |
| `getting-started/quickstart.mdx` | `"Build your first Agent, publish it, chat with it, and put it on standing duty — end to end in a few minutes."` |
| `guides/connect-slack.mdx` | `"Connect a workspace to Slack once, then wire a Workflow to a team and channel so mentioning the app in a thread actually starts a run."` |
| `guides/equip-an-agent.mdx` | `"Connect Linear through the catalog's OAuth connector, narrow what the Agent may do with it, and prove the whole path works from chat."` |
| `guides/personas-and-instructions.mdx` | `"A persona is durable identity compiled into every version; instructions are per-delegation task text that goes live the moment you publish. What belongs where."` |
| `guides/scheduled-workflow.mdx` | `"Build a standup digest that runs every weekday at 09:00 UTC — the cron expression, the bound Agent, and where the digest ends up once it's generated."` |
| `guides/webhook-workflow.mdx` | `"Wire a support form's POST to a Workflow that triages the submission and files a Linear issue through the Agent's connector."` |
| `platform/architecture.mdx` | `"Three services over Postgres and an object store, plus one optional search index: the control plane, the stateless worker pool, and the compiler."` |
| `platform/durability.mdx` | `"Kill a worker mid-run and the run survives. Why stateless workers plus Postgres-backed state let a crashed run resume anywhere instead of being lost."` |
| `platform/security.mdx` | `"Secrets never touch git, logs, or model context. AES-256-GCM envelope encryption with tenant-bound AAD, workspace scoping, and guarded outbound egress."` |
| `reference/glossary.mdx` | `"One line per term in invisible-string's vocabulary, each linking to the page that covers it in depth. A lookup table, not a tutorial."` |
| `reference/keyboard-and-accessibility.mdx` | `"Every shipped keyboard shortcut in one table, alongside the platform's accessibility commitments. Nothing on this page is aspirational."` |
| `reference/limits-and-defaults.mdx` | `"The platform's real limits, verified against the running system — with the environment variable named wherever a self-hoster can change one."` |
| `reference/troubleshooting.mdx` | `"Organized by where you are, not by error code. Find your situation, read what's actually happening, then what to do about it."` |

For example, `getting-started/overview.mdx` becomes:

```md
---
title: Overview
section: Getting started
order: 10
description: "Give an Agent a role, a model, and the tools it needs, then chat with it like a teammate — or put it on standing duty from Slack, forms, webhooks, or a schedule."
---
```

- [ ] **Step 6: Verify all 28 files have the field**

Run:
```bash
cd apps/site/src/content/docs && \
  echo "mdx files: $(find . -name '*.mdx' | wc -l)" && \
  echo "with description: $(grep -l '^description:' $(find . -name '*.mdx') | wc -l)"
```
Expected: both counts are `28`.

- [ ] **Step 7: Typecheck**

Run: `bun run --cwd apps/site typecheck`
Expected: PASS. This is the real check that no MDX file was missed — `import.meta.glob<DocFrontmatter>` in `src/lib/docs.ts` types every globbed module against the interface.

- [ ] **Step 8: Commit**

```bash
git add apps/site/src/lib/sidebar.ts apps/site/src/types/mdx.d.ts \
        apps/site/src/__tests__/sidebar.test.ts apps/site/src/content/docs
git commit -m "feat(site): require a description in doc frontmatter"
```

---

### Task 2: `lib/seo.ts` — the head model and its two renderers

One pure module owning every piece of page metadata, with a server renderer (HTML string) and a client renderer (DOM mutation). Pure TypeScript: no `import.meta.glob`, no `.mdx` import, no route import, no environment access — callers pass the site URL in.

**Files:**
- Create: `apps/site/src/lib/seo.ts`
- Test: `apps/site/src/__tests__/seo.test.ts`
- Test: `apps/site/src/__tests__/head-apply.test.tsx`

**Interfaces:**
- Consumes: `DocFrontmatter` from Task 1.
- Produces:
  - `SeoContext { siteUrl: string; indexable: boolean }`
  - `PageSeo { path, title, description, canonical: string | null, ogImage, ogType, robots, jsonLd }`
  - `DEFAULT_SITE_URL: string`, `normalizeSiteUrl(raw: string | undefined): string`
  - `landingSeo(ctx)`, `docSeo(slug, fm, ctx)`, `notFoundSeo(ctx)` — all `=> PageSeo`
  - `seoForPath(pathname: string, docs: ReadonlyMap<string, DocFrontmatter>, ctx: SeoContext): PageSeo`
  - `renderHeadHtml(seo: PageSeo): string`
  - `applyHead(seo: PageSeo, doc: Document): void`
  - `escapeHtml(value: string): string`

- [ ] **Step 1: Write the failing pure-logic test**

Create `apps/site/src/__tests__/seo.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/site/src/__tests__/seo.test.ts`
Expected: FAIL — `Cannot find module '../lib/seo'`.

- [ ] **Step 3: Write the implementation**

Create `apps/site/src/lib/seo.ts`:

```ts
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
  if (seo.canonical) setMeta(doc, "property", "og:url", seo.canonical);
}
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `bun test apps/site/src/__tests__/seo.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Write the failing DOM test for `applyHead`**

Create `apps/site/src/__tests__/head-apply.test.tsx`. The `.tsx` extension and the setup import order match `toc.test.tsx` — `../test/setup` must be the FIRST import so happy-dom registers before anything else evaluates.

```tsx
import { ensureDomForThisFile } from "../test/setup";

import { beforeEach, describe, expect, test } from "bun:test";

import type { DocFrontmatter } from "../lib/sidebar";
import { applyHead, docSeo, notFoundSeo, type SeoContext } from "../lib/seo";

ensureDomForThisFile();

const ctx: SeoContext = { siteUrl: "https://example.com", indexable: true };

const agents: DocFrontmatter = {
  title: "Agents",
  section: "Concepts",
  order: 20,
  description: "An Agent is a role you define.",
};

const workflows: DocFrontmatter = {
  title: "Workflows",
  section: "Concepts",
  order: 30,
  description: "A Workflow is a standing delegation.",
};

describe("applyHead", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.title = "";
  });

  test("sets the title, description and canonical on a fresh head", () => {
    applyHead(docSeo("concepts/agents", agents, ctx), document);

    expect(document.title).toBe("Agents — invisible-string docs");
    expect(
      document.head.querySelector('meta[name="description"]')?.getAttribute("content"),
    ).toBe("An Agent is a role you define.");
    expect(
      document.head.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ).toBe("https://example.com/docs/concepts/agents");
  });

  test("updates in place across navigations instead of appending duplicates", () => {
    applyHead(docSeo("concepts/agents", agents, ctx), document);
    applyHead(docSeo("concepts/workflows", workflows, ctx), document);

    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(
      document.head.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ).toBe("https://example.com/docs/concepts/workflows");
  });

  test("removes the canonical when navigating to a page that has none", () => {
    applyHead(docSeo("concepts/agents", agents, ctx), document);
    applyHead(notFoundSeo(ctx), document);

    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
  });

  test("never writes the robots meta — the build owns it", () => {
    const robots = document.createElement("meta");
    robots.setAttribute("name", "robots");
    robots.setAttribute("content", "noindex,nofollow");
    document.head.appendChild(robots);

    applyHead(docSeo("concepts/agents", agents, ctx), document);

    expect(
      document.head.querySelector('meta[name="robots"]')?.getAttribute("content"),
    ).toBe("noindex,nofollow");
  });
});
```

- [ ] **Step 6: Run the DOM test to verify it passes**

Run: `bun test apps/site/src/__tests__/head-apply.test.tsx`
Expected: PASS — 4 cases. (`applyHead` was written in Step 3, so this suite passes on first run; its purpose is to lock the update-in-place and never-touch-robots behaviors, which are exactly the ones a later refactor would break.)

- [ ] **Step 7: Run the full site suite and typecheck**

Run: `bun test apps/site && bun run --cwd apps/site typecheck`
Expected: PASS for both.

- [ ] **Step 8: Commit**

```bash
git add apps/site/src/lib/seo.ts apps/site/src/__tests__/seo.test.ts \
        apps/site/src/__tests__/head-apply.test.tsx
git commit -m "feat(site): add the SEO metadata model and its head renderers"
```

---

### Task 3: `lib/sitemap.ts` and `lib/llms.ts` — the generated text files

Two more pure modules: one renders `sitemap.xml` + `robots.txt`, the other renders the `## Docs` section of `llms.txt` from frontmatter so it can no longer drift from the actual doc set.

**Files:**
- Create: `apps/site/src/lib/sitemap.ts`
- Create: `apps/site/src/lib/llms.ts`
- Create: `apps/site/scripts/llms-template.md`
- Test: `apps/site/src/__tests__/sitemap.test.ts`
- Test: `apps/site/src/__tests__/llms.test.ts`
- Delete: `apps/site/public/llms.txt` (now generated into `dist/`)
- Delete: `apps/site/public/robots.txt` (now generated into `dist/`)

**Interfaces:**
- Consumes: `PageSeo`, `SeoContext` from Task 2; `DocFrontmatter`, `buildSidebar` from `lib/sidebar.ts`.
- Produces:
  - `renderSitemap(pages: PageSeo[]): string`
  - `renderRobots(ctx: SeoContext): string`
  - `renderLlmsTxt(template: string, entries: Array<[string, DocFrontmatter]>): string`
  - `LLMS_DOCS_MARKER: string` (`"<!--docs-->"`)

- [ ] **Step 1: Write the failing sitemap test**

Create `apps/site/src/__tests__/sitemap.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/site/src/__tests__/sitemap.test.ts`
Expected: FAIL — `Cannot find module '../lib/sitemap'`.

- [ ] **Step 3: Write `lib/sitemap.ts`**

```ts
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
```

- [ ] **Step 4: Run the sitemap test to verify it passes**

Run: `bun test apps/site/src/__tests__/sitemap.test.ts`
Expected: PASS — 8 cases.

- [ ] **Step 5: Write the failing llms test**

Create `apps/site/src/__tests__/llms.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { LLMS_DOCS_MARKER, renderLlmsTxt } from "../lib/llms";
import type { DocFrontmatter } from "../lib/sidebar";

const template = `# invisible-string\n\n## Docs\n\n${LLMS_DOCS_MARKER}\n\n## Source\n\n- [GitHub](https://github.com/heysanil/invisible-string)\n`;

function fm(
  title: string,
  section: string,
  order: number,
  description: string,
): DocFrontmatter {
  return { title, section, order, description };
}

const entries: Array<[string, DocFrontmatter]> = [
  ["concepts/agents", fm("Agents", "Concepts", 20, "A role you define.")],
  ["getting-started/overview", fm("Overview", "Getting started", 10, "What it is.")],
  ["getting-started/quickstart", fm("Quickstart", "Getting started", 20, "Build one.")],
];

describe("renderLlmsTxt", () => {
  test("lists every doc, grouped and ordered like the sidebar", () => {
    const out = renderLlmsTxt(template, entries);
    const docLines = out.split("\n").filter((line) => line.startsWith("- ["));
    expect(docLines).toEqual([
      "- [Overview](/docs/getting-started/overview): What it is.",
      "- [Quickstart](/docs/getting-started/quickstart): Build one.",
      "- [Agents](/docs/concepts/agents): A role you define.",
      "- [GitHub](https://github.com/heysanil/invisible-string)",
    ]);
  });

  test("emits a heading per section", () => {
    const out = renderLlmsTxt(template, entries);
    expect(out).toContain("### Getting started");
    expect(out).toContain("### Concepts");
  });

  test("preserves the template's own sections", () => {
    const out = renderLlmsTxt(template, entries);
    expect(out.startsWith("# invisible-string")).toBe(true);
    expect(out).toContain("## Source");
  });

  test("consumes the marker", () => {
    expect(renderLlmsTxt(template, entries)).not.toContain(LLMS_DOCS_MARKER);
  });

  test("throws when the template has no marker, rather than silently dropping the docs", () => {
    expect(() => renderLlmsTxt("# no marker here\n", entries)).toThrow(
      /marker/i,
    );
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test apps/site/src/__tests__/llms.test.ts`
Expected: FAIL — `Cannot find module '../lib/llms'`.

- [ ] **Step 7: Write `lib/llms.ts`**

```ts
/**
 * `llms.txt`'s `## Docs` section, generated from frontmatter.
 *
 * Hand-maintaining it meant the list covered 12 of 28 pages with no mechanism
 * to stay current. Now the prose (summary, `## Source`) lives in
 * scripts/llms-template.md and the page list is derived, ordered by the same
 * `buildSidebar` the site's own nav uses — so the file and the sidebar can
 * never disagree.
 */
import { buildSidebar, type DocFrontmatter } from "./sidebar";

/** Replaced with the generated doc list. */
export const LLMS_DOCS_MARKER = "<!--docs-->";

export function renderLlmsTxt(
  template: string,
  entries: Array<[string, DocFrontmatter]>,
): string {
  if (!template.includes(LLMS_DOCS_MARKER)) {
    throw new Error(
      `llms template is missing the ${LLMS_DOCS_MARKER} marker — the doc list has nowhere to go`,
    );
  }

  const byslug = new Map(entries);
  const blocks: string[] = [];

  for (const section of buildSidebar(entries)) {
    const lines = [`### ${section.section}`, ""];
    for (const item of section.items) {
      const description = byslug.get(item.slug)?.description ?? "";
      lines.push(`- [${item.title}](/docs/${item.slug}): ${description}`);
    }
    blocks.push(lines.join("\n"));
  }

  return template.replace(LLMS_DOCS_MARKER, blocks.join("\n\n"));
}
```

- [ ] **Step 8: Run the llms test to verify it passes**

Run: `bun test apps/site/src/__tests__/llms.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 9: Create the llms template and delete the two static files**

Create `apps/site/scripts/llms-template.md` — the prose from the old `public/llms.txt`, with the hand-maintained doc list replaced by the marker:

```md
# invisible-string

> An open-source, self-hostable platform for AI agents: build an agent — a persona, a model, and the tools it's equipped with — chat with it directly, or delegate standing work with workflows fired from Slack, forms, webhooks, or a schedule. Every published agent compiles into a self-hosted, version-pinned process; runs stream live, pause for human approval, and survive infrastructure failure without losing work.

## Docs

<!--docs-->

## Source

- [GitHub](https://github.com/heysanil/invisible-string): repository and issue tracker
```

Then delete the two files now generated into `dist/` by Task 7:

```bash
git rm apps/site/public/llms.txt apps/site/public/robots.txt
```

- [ ] **Step 10: Run the full site suite and typecheck**

Run: `bun test apps/site && bun run --cwd apps/site typecheck`
Expected: PASS for both.

- [ ] **Step 11: Commit**

```bash
git add apps/site/src/lib/sitemap.ts apps/site/src/lib/llms.ts \
        apps/site/scripts/llms-template.md \
        apps/site/src/__tests__/sitemap.test.ts apps/site/src/__tests__/llms.test.ts \
        apps/site/public
git commit -m "feat(site): generate sitemap, robots and llms.txt from frontmatter"
```

---

### Task 4: Extract the router factory and sync the head on navigation

One router config shared by client and server — the usual source of hydration mismatches is two `createRouter` calls that drift. The client also starts updating the head on navigation, which works today (with `createRoot`) and keeps working after Task 7 switches to `hydrateRoot`.

**Files:**
- Create: `apps/site/src/router.tsx`
- Create: `apps/site/src/components/HeadSync.tsx`
- Modify: `apps/site/src/main.tsx` (whole file)
- Modify: `apps/site/src/lib/docs.ts` (add a slug→frontmatter map export)
- Modify: `apps/site/src/routes/__root.tsx:13-29` (render `<HeadSync />`)

**Interfaces:**
- Consumes: `seoForPath`, `applyHead`, `normalizeSiteUrl`, `SeoContext` from Task 2.
- Produces:
  - `createSiteRouter(options?: { history?: RouterHistory; defaultPreload?: false }): Router` from `src/router.tsx`
  - `docFrontmatterMap: ReadonlyMap<string, DocFrontmatter>` from `src/lib/docs.ts`
  - `<HeadSync />` component from `src/components/HeadSync.tsx`

- [ ] **Step 1: Add the slug→frontmatter map to `lib/docs.ts`**

Append to `apps/site/src/lib/docs.ts`:

```ts
/** Slug → frontmatter, the lookup shape `seoForPath` wants. */
export const docFrontmatterMap: ReadonlyMap<string, DocFrontmatter> = new Map(
  docFrontmatterList,
);
```

- [ ] **Step 2: Create the shared router factory**

Create `apps/site/src/router.tsx`:

```tsx
import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * The one router config, shared by the browser entry (`main.tsx`) and the
 * prerender entry (`entry-server.tsx`).
 *
 * Two `createRouter` calls that drift on `basepath` or preloading are the
 * classic cause of hydration mismatches in a hand-rolled SSG, so there is
 * exactly one call site. The server passes a memory history and disables
 * preloading (there is no pointer to hover); everything else is identical.
 */
export function createSiteRouter(options?: {
  history?: RouterHistory;
  defaultPreload?: false;
}) {
  return createRouter({
    routeTree,
    // `basepath` from Vite's `BASE_URL` (driven by SITE_BASE) so a subpath
    // deploy routes correctly with the same one knob.
    basepath: import.meta.env.BASE_URL,
    defaultPreload: options?.defaultPreload === false ? false : "intent",
    history: options?.history,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createSiteRouter>;
  }
}
```

- [ ] **Step 3: Create the head-sync component**

Create `apps/site/src/components/HeadSync.tsx`:

```tsx
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { docFrontmatterMap } from "../lib/docs";
import { applyHead, normalizeSiteUrl, type SeoContext, seoForPath } from "../lib/seo";

/**
 * `indexable: true` is inert here — `applyHead` never writes the robots meta,
 * which the build owns (a preview build's `noindex` must survive every
 * client-side navigation). The field is required rather than optional so that
 * the prerender script, where the value genuinely matters, cannot omit it.
 */
const SEO_CONTEXT: SeoContext = {
  siteUrl: normalizeSiteUrl(import.meta.env.VITE_SITE_URL),
  indexable: true,
};

/**
 * Keeps the document head in step with client-side navigation.
 *
 * Crawlers never need this — they read the prerendered head. It exists so the
 * browser tab, bookmarks, and history entries are correct for humans, and so
 * the dev server (where nothing is prerendered) still shows real titles.
 *
 * Renders nothing. The head is deliberately outside React's tree: it never
 * participates in hydration, so there is no mismatch surface in it at all.
 */
export function HeadSync(): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    applyHead(seoForPath(pathname, docFrontmatterMap, SEO_CONTEXT), document);
  }, [pathname]);

  return null;
}
```

- [ ] **Step 4: Render it from the root layout**

In `apps/site/src/routes/__root.tsx`, add the import and the element. Replace the `RootLayout` function body's opening:

```tsx
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";

import { HeadSync } from "../components/HeadSync";
import { SiteFooter } from "../components/SiteFooter";
import { SiteNav } from "../components/SiteNav";
import { Wash } from "../components/Wash";
```

and inside `RootLayout`, directly after the `<MotionConfig …>` opening tag:

```tsx
    <MotionConfig reducedMotion="user">
      <HeadSync />
      <Wash />
```

- [ ] **Step 5: Rewrite `main.tsx` to use the factory**

Replace the whole of `apps/site/src/main.tsx`:

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createSiteRouter } from "./router";
import "./index.css";

const router = createSiteRouter();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

(`createRoot` stays for now. Task 7 switches it to `hydrateRoot`, in the same commit that first produces static markup for it to hydrate — hydrating an empty `#root` before then would be a broken intermediate state.)

- [ ] **Step 6: Typecheck and build**

Run: `bun run --cwd apps/site typecheck && bun run --cwd apps/site build`
Expected: PASS for both. The build still produces a plain SPA at this point.

- [ ] **Step 7: Verify the head updates in the dev server**

Run: `bun run --cwd apps/site dev`

In the browser: load `/`, confirm the tab reads "invisible-string — describe the work, consider it done"; click through to a docs page, confirm the tab changes to "<Page> — invisible-string docs"; in devtools confirm `<link rel="canonical">` tracks the URL and there is exactly one of them after several navigations. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add apps/site/src/router.tsx apps/site/src/components/HeadSync.tsx \
        apps/site/src/main.tsx apps/site/src/lib/docs.ts apps/site/src/routes/__root.tsx
git commit -m "feat(site): share one router factory and sync the head on navigation"
```

---

### Task 5: Prepare the HTML template

`index.html` becomes a template: the hardcoded landing-page metadata comes out (it is what makes all 28 docs pages claim to be the homepage), a `<!--seo-->` marker goes in, and a `<noscript>` rule guarantees motion-hidden text is visible to a client that never runs the animations.

**Files:**
- Modify: `apps/site/index.html` (whole file)
- Modify: `apps/site/vite.config.ts:26-31` (delete the `VITE_SITE_URL` defaulting block)
- Modify: `apps/site/src/components/landing/parts.tsx:38-44` (`Reveal` gains `data-reveal`)
- Modify: `apps/site/src/components/landing/Hero.tsx` (5 motion elements gain `data-reveal`)

**Interfaces:**
- Consumes: nothing.
- Produces: `<!--seo-->` and `<div id="root"></div>` as the two exact strings `scripts/prerender.ts` replaces in Task 7; `[data-reveal]` as the noscript selector.

- [ ] **Step 1: Rewrite `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f7f7f7" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />

    <!-- Replaced per page by scripts/prerender.ts with the output of
         renderHeadHtml() — title, description, robots, canonical, OG/Twitter
         and JSON-LD. Left as a bare comment by the dev server, where
         components/HeadSync.tsx populates the head on mount instead. -->
    <!--seo-->

    <!-- Landing-page entrance animations render their INITIAL state during
         prerender, so without JavaScript the hero headline ships at opacity 0
         and blurred. Any client that does not run the animations gets the
         final state instead. -->
    <noscript>
      <style>
        [data-reveal] {
          opacity: 1 !important;
          transform: none !important;
          filter: none !important;
        }
      </style>
    </noscript>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Delete the `VITE_SITE_URL` defaulting block from `vite.config.ts`**

Remove lines 26–31 entirely (the comment plus the `if (!process.env.VITE_SITE_URL) { … }` statement). It existed only to keep the `%VITE_SITE_URL%` HTML substitutions from breaking, and those are gone. The default now lives in `normalizeSiteUrl` (`src/lib/seo.ts`), which both entry points call — so the browser and the prerender script cannot disagree about it.

- [ ] **Step 3: Tag `Reveal` with `data-reveal`**

In `apps/site/src/components/landing/parts.tsx`, add the attribute to the `motion.div` inside `Reveal`:

```tsx
    <motion.div
      data-reveal
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: EASE, delay }}
    >
```

- [ ] **Step 4: Tag the Hero's five animated elements**

`Hero.tsx` animates directly rather than through `Reveal`, and its `<h1>` spans carry `filter: blur(7px)` as well as `opacity: 0` — the site's most important text. Add `data-reveal` as the first prop on each of these five elements in `apps/site/src/components/landing/Hero.tsx`:

- line 32, the spool `motion.div` (`initial={{ opacity: 0, scale: 0.9 }}`)
- line 47, the first `motion.span` (`variants={line}`)
- line 50, the second `motion.span` (`variants={line}`)
- line 55, the `motion.p` (`initial={{ opacity: 0, y: 12 }}`)
- line 66, the CTA `motion.div` (`initial={{ opacity: 0, y: 12 }}`)
- line 83, the vignette `motion.div` (`initial={{ opacity: 0, y: 26 }}`)

For example the headline spans become:

```tsx
        <motion.span data-reveal variants={line} className="block">
          Describe the work,
        </motion.span>
        <motion.span data-reveal variants={line} className="block">
          consider it done.
        </motion.span>
```

Do **not** tag `motion.h1` itself — its `container` variant's `hidden` state is `{}`, so it renders no inline style and needs no override.

- [ ] **Step 5: Typecheck, test and build**

Run: `bun run --cwd apps/site typecheck && bun test apps/site && bun run --cwd apps/site build`
Expected: PASS for all three.

- [ ] **Step 6: Verify the template markers survive the build**

Run:
```bash
grep -c -e '<!--seo-->' -e '<div id="root"></div>' apps/site/dist/index.html
```
Expected: `2`. If either is missing, Vite has rewritten it and Task 7's replacements will silently no-op.

- [ ] **Step 7: Commit**

```bash
git add apps/site/index.html apps/site/vite.config.ts \
        apps/site/src/components/landing/parts.tsx apps/site/src/components/landing/Hero.tsx
git commit -m "feat(site): make index.html a per-page template"
```

---

### Task 6: The SSR entry and its build

A second Vite build producing a server bundle that renders any route to an HTML string.

**Files:**
- Create: `apps/site/src/entry-server.tsx`
- Modify: `apps/site/package.json:6-12` (scripts)
- Modify: `apps/site/tsconfig.json:7` (include `scripts`)
- Modify: `.gitignore` (add `.ssr/`)

**Interfaces:**
- Consumes: `createSiteRouter` from Task 4.
- Produces, from `.ssr/entry-server.js`:
  - `renderPage(path: string): Promise<string>` — markup for `#root`'s children, nothing else
  - `docEntries: Array<{ slug: string; frontmatter: DocFrontmatter }>` (re-exported from `lib/docs.ts`)

- [ ] **Step 1: Create the SSR entry**

Create `apps/site/src/entry-server.tsx`:

```tsx
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { prerender } from "react-dom/static";

import { createSiteRouter } from "./router";

/**
 * Re-exported so scripts/prerender.ts derives its page list from the same
 * glob the sidebar uses. A new .mdx file is prerendered on the next build
 * with no registry edit anywhere.
 */
export { docEntries } from "./lib/docs";

/**
 * Render one route to HTML.
 *
 * `prerender()` from react-dom/static, NOT renderToString: doc bodies are
 * `React.lazy(() => import('…mdx'))` (see routes/docs.$.tsx), and
 * renderToString throws on a component that suspends. `prerender()` waits for
 * every Suspense boundary to settle and resolves with complete markup — which
 * is what lets lib/docs.ts stay exactly as it is.
 *
 * Returns the children of `#root` only; scripts/prerender.ts wraps them in the
 * built index.html template.
 */
export async function renderPage(path: string): Promise<string> {
  const router = createSiteRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPreload: false,
  });

  await router.load();

  const { prelude } = await prerender(<RouterProvider router={router} />);
  return await new Response(prelude).text();
}
```

- [ ] **Step 2: Ignore the SSR output directory**

Add to the repo-root `.gitignore`, directly under the `dist/` line:

```
.ssr/
```

`.ssr/` is a sibling of `dist/`, never a child: everything under `dist/` is uploaded to Cloudflare, and the server bundle must never be.

- [ ] **Step 3: Wire the build scripts**

Replace the `scripts` block in `apps/site/package.json`:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && bun run build:client && bun run build:server && bun run prerender",
    "build:client": "vite build",
    "build:server": "vite build --ssr src/entry-server.tsx --outDir .ssr",
    "prerender": "bun scripts/prerender.ts",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
```

- [ ] **Step 4: Include `scripts/` in typechecking**

In `apps/site/tsconfig.json`:

```json
  "include": ["src", "scripts"]
```

- [ ] **Step 5: Build the server bundle on its own and verify it emits**

Run: `bun run --cwd apps/site build:server`
Expected: succeeds, and `apps/site/.ssr/entry-server.js` exists.

Run: `ls apps/site/.ssr/`

- [ ] **Step 6: Smoke-test the renderer before writing the real script**

Run:
```bash
cd apps/site && bun -e '
  const m = await import("./.ssr/entry-server.js");
  const html = await m.renderPage("/");
  console.log("docs:", m.docEntries.length);
  console.log("has h1:", html.includes("<h1"));
  console.log("has headline:", html.includes("consider it done"));
  const doc = await m.renderPage("/docs/concepts/agents");
  console.log("doc has h1:", doc.includes("<h1"));
  console.log("doc body rendered:", doc.includes("An Agent is a role you define"));
'
```
Expected: `docs: 28`, and all four booleans `true`. The last one is the real proof — it means `prerender()` resolved the lazy MDX body rather than emitting a Suspense fallback.

If `doc body rendered` is `false`, the lazy import did not resolve: check that `renderPage` awaits `prerender()`'s promise (not just its `prelude`) and that `router.load()` ran first.

- [ ] **Step 7: Verify the full build still passes**

Run: `bun run --cwd apps/site build`
Expected: FAILS at the `prerender` step with "Cannot find module scripts/prerender.ts" — that script is Task 7. The client and server builds before it must both succeed.

- [ ] **Step 8: Commit**

```bash
git add apps/site/src/entry-server.tsx apps/site/package.json apps/site/tsconfig.json .gitignore
git commit -m "feat(site): add the SSR entry and server build"
```

---

### Task 7: The prerender script

Walks the derived page list, writes one HTML file per route plus the three generated text files, verifies the output, and switches the client to `hydrateRoot`.

**Files:**
- Create: `apps/site/scripts/prerender.ts`
- Modify: `apps/site/src/main.tsx` (`createRoot` → `hydrateRoot`)

**Interfaces:**
- Consumes: `renderPage`, `docEntries` from Task 6; `landingSeo`/`docSeo`/`notFoundSeo`/`normalizeSiteUrl`/`renderHeadHtml`/`PageSeo`/`SeoContext` from Task 2; `renderSitemap`/`renderRobots` from Task 3; `renderLlmsTxt` from Task 3.
- Produces: `dist/index.html`, `dist/docs/<slug>/index.html` × 28, `dist/404.html`, `dist/sitemap.xml`, `dist/robots.txt`, `dist/llms.txt`.

- [ ] **Step 1: Write the prerender script**

Create `apps/site/scripts/prerender.ts`:

```ts
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
    const html = template
      .replace(SEO_MARKER, renderHeadHtml(page.seo))
      .replace(ROOT_MARKER, `<div id="root">${appHtml}</div>`);

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
```

Note on `src/lib/seo.ts` being imported here: `applyHead` references `Document` and `HTMLMetaElement`, which resolve at typecheck from the app's `DOM` lib. Bun importing the module is harmless — the function is never called outside a browser — so no DOM shim is needed in the script.

- [ ] **Step 2: Run the full build**

Run: `bun run --cwd apps/site build`
Expected: PASS, ending with `prerendered 30 pages → dist/  (site http://localhost:5173, noindex)`.

- [ ] **Step 3: Verify the emitted files**

Run:
```bash
cd apps/site && \
  echo "html files: $(find dist -name '*.html' | wc -l)" && \
  echo "--- landing title ---" && grep -o '<title>[^<]*' dist/index.html && \
  echo "--- doc title ---" && grep -o '<title>[^<]*' dist/docs/concepts/agents/index.html && \
  echo "--- doc canonical ---" && grep -o '<link rel="canonical"[^>]*' dist/docs/concepts/agents/index.html && \
  echo "--- doc body present ---" && grep -c 'An Agent is a role you define' dist/docs/concepts/agents/index.html && \
  echo "--- sitemap entries ---" && grep -c '<loc>' dist/sitemap.xml && \
  echo "--- robots ---" && cat dist/robots.txt && \
  echo "--- llms doc lines ---" && grep -c '^- \[' dist/llms.txt
```

Expected:
- `html files: 30`
- landing title is the landing headline; doc title is `Agents — invisible-string docs` — **different**, which is the whole point
- doc canonical is `http://localhost:5173/docs/concepts/agents`
- doc body present: `1` or more
- sitemap entries: `29` (28 docs + landing; the 404 has no canonical)
- robots: `Disallow: /` (this is a non-indexable local build)
- llms doc lines: `29` (28 docs + the GitHub line from the template)

- [ ] **Step 4: Verify an indexable build differs**

Run:
```bash
cd apps/site && SITE_INDEXABLE=1 VITE_SITE_URL=https://invisiblestring.io bun run build >/dev/null && \
  cat dist/robots.txt && \
  grep -o '<meta name="robots"[^>]*' dist/index.html && \
  grep -o '<loc>[^<]*' dist/sitemap.xml | head -2
```
Expected: robots.txt has `Allow: /` and the `Sitemap:` line; the robots meta is `index,follow`; sitemap locs are absolute `https://invisiblestring.io/…`.

- [ ] **Step 5: Switch the client to hydration**

Now that static markup exists, replace the render call at the bottom of `apps/site/src/main.tsx`:

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { createSiteRouter } from "./router";
import "./index.css";

const router = createSiteRouter();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

// hydrateRoot, not createRoot: scripts/prerender.ts has already written this
// page's markup into #root. React adopts it rather than rebuilding it, which
// is what keeps the prerendered content on screen through first paint.
hydrateRoot(
  rootElement,
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 6: Rebuild and preview**

Run:

```bash
bun run --cwd apps/site build && bun run --cwd apps/site preview
```

In the browser at the previewed origin: load `/docs/concepts/agents` directly (not via a link). Confirm the page content is visible immediately and the console shows **no hydration mismatch warnings**. Then navigate with in-app links and confirm the SPA still works and the tab title changes.

- [ ] **Step 7: If and only if a hydration warning names `ThreadCanvas`**

The spec anticipates this: `useReducedMotion()` can resolve differently on server and client, changing `pathLength`. If — and only if — the console reports it, gate the component. In `apps/site/src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
```

and inside `LandingPage`:

```tsx
  // ThreadCanvas binds a scroll spring whose initial value differs between the
  // server and a reduced-motion client, so it is mounted after hydration. It
  // is pointer-events-none decoration behind the content and contributes no
  // indexable text — deferring it costs nothing.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
```

and replace the `<ThreadCanvas targetRef={pageRef} />` line with:

```tsx
      {mounted ? <ThreadCanvas targetRef={pageRef} /> : null}
```

Re-run Step 6 and confirm the warning is gone. If no warning appeared, skip this step entirely and leave `index.tsx` untouched.

- [ ] **Step 8: Full verification**

Run: `bun run --cwd apps/site typecheck && bun test apps/site && bun run --cwd apps/site build`
Expected: PASS for all three.

- [ ] **Step 9: Commit**

```bash
git add apps/site/scripts/prerender.ts apps/site/src/main.tsx apps/site/src/routes/index.tsx
git commit -m "feat(site): prerender every route to static HTML"
```

---

### Task 8: Cloudflare and CI configuration

The serving rules that make prerendered files behave correctly: real 404s, a real redirect for `/docs`, security headers in production, and the production-only indexability flag.

**Files:**
- Modify: `apps/site/wrangler.jsonc:5-11`
- Create: `apps/site/public/_redirects`
- Create: `apps/site/public/_headers`
- Modify: `.github/workflows/site.yml` (deploy job's build step only)

**Interfaces:**
- Consumes: `SITE_INDEXABLE` from Task 7's script.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Switch `not_found_handling` to `404-page`**

In `apps/site/wrangler.jsonc`, replace the `assets` block:

```jsonc
  // Assets-only Worker: no `main` script — requests never invoke compute.
  "assets": {
    "directory": "./dist",
    // Every route is now a real prerendered file, so SPA fallback would serve
    // the HOMEPAGE at 200 for every mistyped URL — an unbounded set of
    // soft-404s all duplicating `/`. "404-page" serves dist/404.html with a
    // genuine 404 status instead; real deep links still return 200 because
    // they are real files.
    "not_found_handling": "404-page"
  },
```

Leave `compatibility_date`, `routes`, `workers_dev` and `preview_urls` exactly as they are. `html_handling` stays unset, i.e. the default `auto-trailing-slash`, which is what serves `dist/docs/concepts/agents/index.html` at `/docs/concepts/agents`.

- [ ] **Step 2: Add the `/docs` redirect**

Create `apps/site/public/_redirects`:

```
# `/docs` has no page of its own — src/routes/docs.index.tsx redirects to the
# overview in-app. A client-side redirect leaves `/docs` competing with
# `/docs/getting-started/overview` for the same content, so consolidate it at
# the edge with a real 301. Workers static assets reads this file from the
# root of the asset directory (public/ is copied to dist/).
/docs  /docs/getting-started/overview  301
```

- [ ] **Step 3: Add production security headers**

Create `apps/site/public/_headers`:

```
# vite.config.ts sets these for the dev server and `vite preview` only —
# Workers adds neither on its own, so production had no sniffing or referrer
# protection at all. No X-Frame-Options: this is a public marketing site and
# framing is fine (unlike the authenticated SPA).
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

- [ ] **Step 4: Set `SITE_INDEXABLE` on the production deploy only**

In `.github/workflows/site.yml`, in the **`deploy`** job, replace the build step:

```yaml
      # SITE_INDEXABLE is set here and ONLY here. Every other build — the
      # preview job below, a local build, a manual `wrangler versions upload`
      # — emits noindex on every page and `Disallow: /` in robots.txt, so a
      # preview copy of the site can never compete with production in search.
      - name: Build site
        env:
          SITE_INDEXABLE: "1"
        run: bun run --cwd apps/site build
```

Leave the `preview` job's `Build site` step exactly as it is — no `env:` block. Do **not** move `SITE_INDEXABLE` to the workflow-level `env:`, which would apply it to both jobs and defeat the entire mechanism.

- [ ] **Step 5: Verify the assets files reach `dist/`**

Run:
```bash
bun run --cwd apps/site build >/dev/null && ls -1 apps/site/dist/_redirects apps/site/dist/_headers
```
Expected: both paths listed. Vite copies `public/` into `dist/` verbatim.

- [ ] **Step 6: Verify the workflow is still valid YAML**

Run:
```bash
bunx --yes yaml-lint .github/workflows/site.yml 2>/dev/null || \
  bun -e 'console.log(Bun.YAML.parse(await Bun.file(".github/workflows/site.yml").text()) ? "valid yaml" : "invalid")'
```
Expected: no parse error. Confirm by eye that `SITE_INDEXABLE` appears exactly once in the file, under the `deploy` job:

```bash
grep -n -B4 'SITE_INDEXABLE' .github/workflows/site.yml
```

- [ ] **Step 7: Commit**

```bash
git add apps/site/wrangler.jsonc apps/site/public/_redirects apps/site/public/_headers \
        .github/workflows/site.yml
git commit -m "feat(site): serve real 404s, redirect /docs, and gate indexability on the deploy"
```

---

### Task 9: Documentation and changeset

Docs move with code in this repo — a doc that lies is treated as a bug. Four documents describe behavior this plan changed.

**Files:**
- Modify: `apps/site/README.md`
- Modify: `AGENTS.md` (the `apps/site` architecture sentence, and the CI section's `site.yml` paragraph)
- Modify: `.env.example:231-237`
- Modify: `docs/superpowers/specs/2026-08-11-site-static-generation-design.md` (two refinements made during implementation)
- Create: `.changeset/site-static-generation.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite the affected sections of `apps/site/README.md`**

Update, at minimum:

- **Intro** — "built with Vite + React + TanStack Router" becomes prerendered-then-hydrated; state that every route ships as a static HTML file with its own head.
- **Commands** — `build` now runs four steps (`tsc --noEmit`, `build:client`, `build:server`, `prerender`); document `build:client`, `build:server`, and `prerender` as individually runnable, and note that `.ssr/` is gitignored build output that must never end up inside `dist/`.
- **Build-time environment table** — add a `SITE_INDEXABLE` row: set to `1` by `site.yml`'s deploy job only; anything else emits `noindex` on every page plus `Disallow: /`. Adjust the `VITE_SITE_URL` row: no longer substituted into `index.html`, now consumed by `src/lib/seo.ts` via `normalizeSiteUrl`, defaulting to `http://localhost:5173`.
- **MDX authoring** — add `description` to the frontmatter example and say it is required, 110–155 characters, and guarded by the build.
- **New "SEO and prerendering" section** — the four-step pipeline; `src/lib/seo.ts` as the single metadata source with two renderers; why `prerender()` rather than `renderToString`; why not `HeadContent` (duplicate `<title>`); the `<!--seo-->` and `<div id="root"></div>` template markers and that changing either breaks the injection; the `[data-reveal]` noscript rule and why the Hero needs it; the generated `sitemap.xml`/`robots.txt`/`llms.txt`; and the "no `lastmod` until `fetch-depth: 0`" note under Future work.
- **Replace the "SPA fallback" section** — it currently explains `not_found_handling: "single-page-application"`. Rewrite as `404-page`: real files serve 200, everything else gets `dist/404.html` at a genuine 404, and `_redirects` handles `/docs`. Explain that SPA fallback was correct before prerendering and became a soft-404 generator after.
- **Delete the stale claim** that "GitHub Pages fronts the static build with its own headers" — `public/_headers` now does it.
- **Testing constraint section** — note that `src/lib/seo.ts`, `src/lib/sitemap.ts`, and `src/lib/llms.ts` are glob-free for exactly the reason `sidebar.ts` and `toc.ts` are.

- [ ] **Step 2: Update `AGENTS.md`**

Two edits.

In the **Architecture** section, replace the `apps/site` sentence:

> `apps/site`: standalone Vite + React static landing + docs SPA (MDX docs, E1 tokens via `packages/design-tokens`), deployed to Cloudflare Workers (assets-only Worker) at invisiblestring.io — no server, no compose service.

with a version stating that it is **prerendered at build time** (React 19 `prerender()` → one static HTML file per route, each with its own title/description/canonical/JSON-LD, plus generated `sitemap.xml`/`robots.txt`/`llms.txt`) and then hydrated, and that the deploy is unchanged — still an assets-only Worker with no compute.

In the **CI** section's `site.yml` paragraph, add that the deploy job sets `SITE_INDEXABLE=1` and the preview job deliberately does not, so preview versions ship `noindex` + `Disallow: /`.

- [ ] **Step 3: Update `.env.example`**

Extend the `apps/site` block (lines 231–237) to mention `SITE_INDEXABLE`: an `apps/site` build-time variable set to `1` by `.github/workflows/site.yml`'s deploy job only, never needed in `.env`, and fail-safe — any other value produces a `noindex` build.

- [ ] **Step 4: Correct two spec statements that implementation refined**

The spec must match what shipped.

In `docs/superpowers/specs/2026-08-11-site-static-generation-design.md` §6, under `sitemap.xml`, replace:

> One `<url>` per prerendered page, absolute `<loc>`, `noindex` pages excluded.

with wording that says the sitemap lists every page that **has a canonical**, which excludes exactly the 404 — and that keying off the canonical rather than an indexability flag keeps the sitemap correct in a `noindex` preview build too (where every page is `noindex` but the sitemap is still well-formed, and `robots.txt`'s `Disallow: /` is what actually holds crawlers off).

In §4, under "Template mechanics", replace the `const SITE_URL = import.meta.env.VITE_SITE_URL ?? …` snippet with the shipped shape: `seo.ts` exports `DEFAULT_SITE_URL` and `normalizeSiteUrl(raw)`, and each entry point passes its own source (`import.meta.env.VITE_SITE_URL` in `HeadSync.tsx`, `process.env.VITE_SITE_URL` in `scripts/prerender.ts`). Note that this keeps `seo.ts` free of environment access, which is what lets the same module run under Vite, under `bun test`, and under a bare Bun script.

- [ ] **Step 5: Write the changeset**

Create `.changeset/site-static-generation.md`. The summary must be **one logical line** — `parseChangeset` collapses the body into a single space-joined line, so bullets and line breaks come back out as a run-on sentence.

```md
---
"@invisible-string/site": minor
---

Prerender every landing and docs route to static HTML with per-page title, description, canonical, OG and JSON-LD metadata, and add a generated sitemap.xml, robots.txt and llms.txt, real 404 statuses, a 301 for /docs, and noindex on preview deploys.
```

Name only `@invisible-string/site` — it is a shipped workspace, so this is valid on its own.

- [ ] **Step 6: Full verification before committing**

Run:
```bash
bun run typecheck && bun test && bun run --cwd apps/site build
```
Expected: PASS for all three. The root `bun test` run is what proves the new pure modules did not break any other workspace's suite.

- [ ] **Step 7: Confirm the changeset is staged**

Run: `git status --short .changeset/`
Expected: `A  .changeset/site-static-generation.md` after `git add`. A changeset is untracked until staged — never run `git clean -fd .changeset`.

- [ ] **Step 8: Commit**

```bash
git add apps/site/README.md AGENTS.md .env.example \
        docs/superpowers/specs/2026-08-11-site-static-generation-design.md \
        .changeset/site-static-generation.md
git commit -m "docs(site): document prerendering, SEO metadata and indexability"
```

---

## Post-merge verification

Not a task — run these against production after the deploy workflow succeeds.

```bash
curl -sI https://invisiblestring.io/docs/concepts/agents | head -1     # HTTP/2 200
curl -sI https://invisiblestring.io/docs/nonexistent-page | head -1    # HTTP/2 404
curl -sI https://invisiblestring.io/docs | grep -i '^location'         # /docs/getting-started/overview
curl -sI https://invisiblestring.io/ | grep -i 'x-content-type-options'
curl -s  https://invisiblestring.io/docs/concepts/agents | grep -o '<title>[^<]*'
curl -s  https://invisiblestring.io/docs/concepts/agents | grep -o '<meta name="robots"[^>]*'
curl -s  https://invisiblestring.io/sitemap.xml | grep -c '<loc>'      # 29
curl -s  https://invisiblestring.io/robots.txt                         # Allow: / + Sitemap:
```

Then, on the next PR that touches `apps/site/**`, confirm the preview URL serves `Disallow: /` and `noindex` — that is the half of the indexability mechanism production traffic cannot exercise.

Finally, submit `https://invisiblestring.io/sitemap.xml` in Google Search Console and check the rendered HTML of one docs page with the Rich Results Test to confirm the `TechArticle` and `BreadcrumbList` blocks parse.
