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

/**
 * Lazy loader for a doc body by slug, or `undefined` for an unknown slug
 * (→ designed not-found). Pass the result to `React.lazy`.
 */
export function getDocLoader(
  slug: string,
): (() => Promise<{ default: ComponentType }>) | undefined {
  return bodyModules[`${PREFIX}${slug}.mdx`];
}
