export interface TocEntry {
  id: string;
  text: string;
  /** 2 for `<h2>`, 3 for `<h3>`. */
  depth: number;
}

/**
 * Extract an "On this page" table of contents from rendered MDX: every `<h2>`
 * / `<h3>` carrying an `id` (rehype-slug adds them). Pure DOM read — no React,
 * no glob — so it's unit-testable against a happy-dom container.
 */
export function extractToc(container: HTMLElement): TocEntry[] {
  const headings = container.querySelectorAll<HTMLElement>("h2[id], h3[id]");
  const entries: TocEntry[] = [];
  for (const el of headings) {
    entries.push({
      id: el.id,
      text: el.textContent?.trim() ?? "",
      depth: el.tagName === "H3" ? 3 : 2,
    });
  }
  return entries;
}
