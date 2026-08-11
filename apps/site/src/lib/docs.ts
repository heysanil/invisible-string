import type { ComponentType } from "react";

import type { DocFrontmatter } from "./sidebar";

// The schema lives in lib/sidebar.ts (glob-free) so tests can import it without
// touching this module's `import.meta.glob`; re-exported here for convenience.
export type { DocFrontmatter };

export interface DocEntry {
  /** Path minus the `../content/docs/` prefix and `.mdx` extension. */
  slug: string;
  frontmatter: DocFrontmatter;
}

const PREFIX = "../content/docs/";

/**
 * Two glob passes over the doc tree:
 *  - eager `import: "frontmatter"` → just the frontmatter objects, for the
 *    sidebar / TOC (cheap, no code loaded).
 *  - lazy default modules → code-split MDX bodies, imported on navigation.
 * `remark-mdx-frontmatter` exposes the YAML block as a named `frontmatter`
 * export, which the eager pass plucks out.
 */
const frontmatterModules = import.meta.glob<DocFrontmatter>(
  "../content/docs/**/*.mdx",
  { eager: true, import: "frontmatter" },
);

const bodyModules = import.meta.glob<{ default: ComponentType }>(
  "../content/docs/**/*.mdx",
);

function toSlug(path: string): string {
  return path.slice(PREFIX.length).replace(/\.mdx$/, "");
}

/** All docs, unsorted — feed to `buildSidebar` for grouped/ordered nav. */
export const docEntries: DocEntry[] = Object.entries(frontmatterModules).map(
  ([path, frontmatter]) => ({ slug: toSlug(path), frontmatter }),
);

/** `[slug, frontmatter]` tuples — the exact input shape `buildSidebar` wants. */
export const docFrontmatterList: Array<[string, DocFrontmatter]> =
  docEntries.map((e) => [e.slug, e.frontmatter]);

/** Slug → frontmatter, the lookup shape `seoForPath` wants. */
export const docFrontmatterMap: ReadonlyMap<string, DocFrontmatter> = new Map(
  docFrontmatterList,
);

/**
 * Lazy loader for a doc body by slug, or `undefined` for an unknown slug
 * (→ designed not-found). Pass the result to `React.lazy`.
 */
export function getDocLoader(
  slug: string,
): (() => Promise<{ default: ComponentType }>) | undefined {
  return bodyModules[`${PREFIX}${slug}.mdx`];
}

/**
 * Warmed only by `preloadDoc` (entry-server.tsx). The client never populates
 * this — it stays empty in the browser, so `docs.$.tsx`'s lazy-import path
 * there is unchanged: same chunking, same network behaviour.
 */
const preloadedDocs = new Map<string, ComponentType>();

/**
 * Resolves one doc body ahead of render, for the SSR entry only. `docs.$.tsx`
 * mounts `getCachedDocComponent`'s result directly instead of wrapping the
 * loader in `React.lazy` when a warmed entry exists: `lazy()` always suspends
 * on its first touch, even against an already-resolved dynamic import, which
 * pushes React's Fizz renderer into its streaming-placeholder output (a
 * visible fallback plus a hidden, script-swapped copy of the real content)
 * for that boundary — regardless of whether `prerender()` later waits for it.
 * A no-op for an unknown slug.
 */
export async function preloadDoc(slug: string): Promise<void> {
  const loader = getDocLoader(slug);
  if (!loader) return;
  const mod = await loader();
  preloadedDocs.set(slug, mod.default);
}

/** Synchronous lookup into the `preloadDoc` cache; `undefined` until warmed. */
export function getCachedDocComponent(slug: string): ComponentType | undefined {
  return preloadedDocs.get(slug);
}
