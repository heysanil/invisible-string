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
