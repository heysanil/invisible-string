/**
 * Generated `agent/skills/*` — the SKILL.md convention (eve docs: skills).
 *
 * - Flat skill (no extra files): `agent/skills/<slug>.md` with a
 *   `description` frontmatter (the model's routing hint).
 * - Packaged skill (has files): `agent/skills/<slug>/SKILL.md` + siblings;
 *   packaged SKILL.md MUST carry description frontmatter (no filename slug
 *   to fall back on).
 */
import type { ResolvedSkill } from "../types";
import { yamlString } from "./strings";

function skillMarkdown(skill: ResolvedSkill): string {
  const body = skill.markdown.replace(/\s+$/, "");
  return `---\ndescription: ${yamlString(skill.description)}\n---\n\n${body}\n`;
}

/** Returns the emitted files for one skill (path → content). */
export function emitSkill(skill: ResolvedSkill): Map<string, string> {
  const files = new Map<string, string>();
  const extraFiles = Object.entries(skill.files ?? {});
  if (extraFiles.length === 0) {
    files.set(`agent/skills/${skill.slug}.md`, skillMarkdown(skill));
    return files;
  }
  files.set(`agent/skills/${skill.slug}/SKILL.md`, skillMarkdown(skill));
  for (const [relativePath, content] of extraFiles.sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    files.set(`agent/skills/${skill.slug}/${relativePath}`, content);
  }
  return files;
}
