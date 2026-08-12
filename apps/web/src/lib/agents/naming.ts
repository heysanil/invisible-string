/**
 * New-agent naming.
 *
 * Agent names are NO LONGER UNIQUE: the 2026-08-11 spec's D1 moved the
 * content hash onto the agent's stable id and dropped
 * `agents_organization_id_name_uidx` with it, so two "Untitled agent" rows are
 * legal and no longer collide onto one world DB. Auto-numbering therefore
 * stops being a correctness constraint and becomes exactly what it looks
 * like — a readability nicety for the grid. Nothing here may block, warn, or
 * reject; a user is free to rename two agents to the same string.
 */
export const UNTITLED_AGENT_BASE = "Untitled agent";

/** `Untitled agent` · `Untitled agent 2` · … — case- and space-insensitive. */
const UNTITLED_PATTERN = /^untitled agent(?:\s+(\d+))?$/;

/**
 * The next free "Untitled agent N" for a workspace, given whatever it already
 * holds. The bare name counts as 1, so the second draft is "Untitled agent 2".
 * Numbering follows the HIGHEST existing number rather than filling gaps —
 * deleting #2 of three must not hand the next agent a name that just vanished
 * from the list.
 */
export function nextUntitledAgentName(
  existing: readonly { readonly name: string }[],
): string {
  let highest = 0;
  for (const agent of existing) {
    const match = UNTITLED_PATTERN.exec(
      agent.name.trim().toLowerCase().replace(/\s+/g, " "),
    );
    if (!match) continue;
    const ordinal = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal;
  }
  return highest === 0 ? UNTITLED_AGENT_BASE : `${UNTITLED_AGENT_BASE} ${highest + 1}`;
}
