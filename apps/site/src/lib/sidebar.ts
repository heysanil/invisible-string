/** Frontmatter schema every doc MDX file must declare (see src/types/mdx.d.ts).
 *  Defined here (not in lib/docs.ts) so pure consumers/tests can import it
 *  without pulling in lib/docs.ts's `import.meta.glob`. */
export interface DocFrontmatter {
  title: string;
  section: string;
  order: number;
}

export interface SidebarItem {
  slug: string;
  title: string;
  order: number;
}

export interface SidebarSection {
  section: string;
  items: SidebarItem[];
}

/**
 * Group doc entries by `section`, ordering items within a section by `order`
 * then `title`, and ordering the sections themselves by their smallest item
 * `order` (tie-break: section name). Pure — no MDX, no glob, no DOM — so it can
 * be unit-tested under `bun test`.
 */
export function buildSidebar(
  entries: Array<[string, DocFrontmatter]>,
): SidebarSection[] {
  const bySection = new Map<string, SidebarItem[]>();

  for (const [slug, fm] of entries) {
    const item: SidebarItem = { slug, title: fm.title, order: fm.order };
    const existing = bySection.get(fm.section);
    if (existing) existing.push(item);
    else bySection.set(fm.section, [item]);
  }

  const sections: SidebarSection[] = [];
  for (const [section, items] of bySection) {
    items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    sections.push({ section, items });
  }

  sections.sort((a, b) => {
    const aMin = a.items[0]?.order ?? 0;
    const bMin = b.items[0]?.order ?? 0;
    return aMin - bMin || a.section.localeCompare(b.section);
  });

  return sections;
}

/** A sidebar item plus the section it belongs to — the shape prev/next and the
 *  breadcrumb both want. */
export interface FlatDoc extends SidebarItem {
  section: string;
}

/**
 * Flatten a built sidebar into a single reading-order list (section order, then
 * within-section item order). Pure — the source of truth for prev/next
 * pagination and breadcrumb lookup. Unit-testable under `bun test`.
 */
export function flattenSidebar(sections: SidebarSection[]): FlatDoc[] {
  const flat: FlatDoc[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      flat.push({ ...item, section: section.section });
    }
  }
  return flat;
}

/** Prev/next neighbours of `slug` in reading order (either may be `null`). */
export function docNeighbours(
  flat: FlatDoc[],
  slug: string,
): { prev: FlatDoc | null; next: FlatDoc | null } {
  const i = flat.findIndex((d) => d.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? (flat[i - 1] ?? null) : null,
    next: i < flat.length - 1 ? (flat[i + 1] ?? null) : null,
  };
}
