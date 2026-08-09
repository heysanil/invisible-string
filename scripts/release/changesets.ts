/**
 * Parsing and validation for `.changeset/*.md`.
 *
 * Validation exists because changesets handles a versionless (= auto-ignored)
 * package badly in two different ways, neither of them obvious:
 *
 *   - named ALONE: exit 0, "All files have been updated", the changeset is
 *     never consumed and nothing is bumped — a zombie that persists forever.
 *   - named ALONGSIDE a versioned package: "Mixed changesets that contain both
 *     ignored and not ignored packages are not allowed", from deep inside
 *     assemble-release-plan.
 *
 * Both become one clear, file-located error before changesets ever runs.
 */
import type { Workspace } from "./workspaces";

export type Bump = "major" | "minor" | "patch";

export interface ChangesetEntry {
  file: string;
  bumps: Record<string, Bump>;
  summary: string;
}

const BUMPS: readonly string[] = ["major", "minor", "patch"];

export function parseChangeset(file: string, text: string): ChangesetEntry {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trimStart());
  if (!match) throw new Error(`${file}: missing --- frontmatter block`);

  const [, frontmatter = "", body = ""] = match;
  const bumps: Record<string, Bump> = {};

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = /^"?([^":]+)"?\s*:\s*(\S+)$/.exec(trimmed);
    if (!entry) throw new Error(`${file}: cannot parse frontmatter line: ${trimmed}`);
    const [, name = "", bump = ""] = entry;
    if (!BUMPS.includes(bump)) {
      throw new Error(`${file}: unknown bump type "${bump}" for ${name}`);
    }
    bumps[name] = bump as Bump;
  }

  if (Object.keys(bumps).length === 0) {
    throw new Error(`${file}: frontmatter names no packages`);
  }

  const summary = body.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
  if (!summary) throw new Error(`${file}: has no summary`);

  return { file, bumps, summary };
}

export function validateChangesets(
  entries: ChangesetEntry[],
  workspaces: Workspace[],
): string[] {
  const versioned = new Set(workspaces.filter((w) => w.version).map((w) => w.name));
  const known = new Set(workspaces.map((w) => w.name));
  const errors: string[] = [];

  for (const entry of entries) {
    for (const name of Object.keys(entry.bumps)) {
      if (!known.has(name)) {
        errors.push(
          `.changeset/${entry.file} names "${name}", which is not a workspace in this repo.`,
        );
      } else if (!versioned.has(name)) {
        errors.push(
          `.changeset/${entry.file} names "${name}", which is excluded from versioning ` +
            `(it has no "version" field). Name only shipped workspaces — see AGENTS.md → Releases.`,
        );
      }
    }
  }

  return errors;
}
