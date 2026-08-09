/**
 * Root-CHANGELOG.md rendering.
 *
 * Changesets writes per-package changelogs; this repo ships as ONE unit, so
 * `changelog: false` disables that and these functions produce a single root
 * file instead.
 *
 * STRUCTURAL RULE, depended on by scripts/release-tag.ts too: the preamble may
 * use `# ` and prose, but the FIRST `## ` in the file is always the newest
 * release. That is how the release-notes body is extracted.
 */
import type { ChangesetEntry } from "./changesets";

const BREAKING_MARKER = "**Breaking:**";

/** Rendered in this order; empty ones are dropped. */
const SECTIONS = ["Breaking changes", "Features", "Fixes & maintenance"] as const;
export type Section = (typeof SECTIONS)[number];

export function classify(entry: ChangesetEntry): Section {
  if (entry.summary.startsWith(BREAKING_MARKER)) return "Breaking changes";
  const bumps = Object.values(entry.bumps);
  if (bumps.includes("major")) return "Breaking changes";
  if (bumps.includes("minor")) return "Features";
  return "Fixes & maintenance";
}

function scope(entry: ChangesetEntry): string {
  return Object.keys(entry.bumps)
    .map((name) => name.replace(/^@invisible-string\//, ""))
    .sort()
    .join(", ");
}

function line(entry: ChangesetEntry): string {
  const summary = entry.summary.startsWith(BREAKING_MARKER)
    ? entry.summary.slice(BREAKING_MARKER.length).trim()
    : entry.summary;
  return `- **${scope(entry)}** — ${summary}`;
}

export function renderSection(
  version: string,
  date: string,
  entries: ChangesetEntry[],
): string {
  const blocks = SECTIONS.flatMap((section) => {
    const lines = entries.filter((e) => classify(e) === section).map(line);
    return lines.length === 0 ? [] : [`### ${section}\n${lines.join("\n")}`];
  });

  return `## v${version} — ${date}\n\n${blocks.join("\n\n")}\n`;
}

export function insertSection(changelog: string, section: string): string {
  const body = section.endsWith("\n") ? section : `${section}\n`;
  const index = changelog.startsWith("## ") ? 0 : changelog.indexOf("\n## ") + 1;

  if (index <= 0) {
    const separator = changelog.endsWith("\n") ? "\n" : "\n\n";
    return `${changelog}${separator}${body}`;
  }
  return `${changelog.slice(0, index)}${body}\n${changelog.slice(index)}`;
}
