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

  test("removes a stale og:url too, not just the canonical", () => {
    applyHead(docSeo("concepts/agents", agents, ctx), document);
    expect(
      document.head.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    ).toBe("https://example.com/docs/concepts/agents");

    applyHead(notFoundSeo(ctx), document);

    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull();
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
