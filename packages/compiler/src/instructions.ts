/**
 * Persona → `agent/instructions.md`.
 *
 * Reference semantics (the compile half of the `@reference` contract; the
 * dispatch half — workflow instructions — lives in packages/shared/render.ts):
 * - `@<connection>` / `@skill.<slug>` become readable literal text, and a
 *   generated appendix lists each connection/skill WITH its description so
 *   eve's `connection_search` / `load_skill` routing can find them.
 * - `@trigger.*` is a compile error: agents are trigger-agnostic — trigger
 *   data belongs to WORKFLOW instructions, rendered at dispatch by
 *   `renderTaskMessage`.
 *
 * Unresolved references are compile errors: drafts may be lenient, published
 * versions may not (see agent-definition.ts docs).
 */
import { parseReferences, type AgentDefinition } from "@invisible-string/shared";

import { CompileError } from "./errors";
import type { CompileDeps } from "./types";

export interface RenderedInstructions {
  /** Final content of `agent/instructions.md`. */
  readonly markdown: string;
}

export function renderInstructions(
  definition: AgentDefinition,
  deps: CompileDeps,
): RenderedInstructions {
  const source = definition.persona;
  if (source.trim().length === 0) {
    throw new CompileError(
      "EMPTY_PERSONA",
      "persona is empty — a publishable agent needs instructions.md content",
    );
  }

  const connectionsBySlug = new Map(
    deps.connections.map((connection) => [connection.slug, connection]),
  );
  const skillsBySlug = new Map(deps.skills.map((skill) => [skill.slug, skill]));

  const refs = parseReferences(source);

  // Validate every reference before rewriting anything.
  for (const ref of refs) {
    if (ref.kind === "trigger") {
      throw new CompileError(
        "TRIGGER_REF_NOT_ALLOWED",
        `"${ref.raw}" cannot be used in a persona — agents are trigger-agnostic; @trigger references belong in workflow instructions`,
        { raw: ref.raw, path: ref.path },
      );
    } else if (ref.kind === "skill") {
      if (ref.slug === "" || !skillsBySlug.has(ref.slug)) {
        throw new CompileError(
          "UNRESOLVED_REFERENCE",
          ref.slug === ""
            ? `bare "@skill" reference — name a skill like "@skill.release-notes"`
            : `"${ref.raw}" does not match any skill in this agent's context (skills: ${[...skillsBySlug.keys()].join(", ") || "none"})`,
          { raw: ref.raw, slug: ref.slug },
        );
      }
    } else {
      if (!connectionsBySlug.has(ref.name)) {
        throw new CompileError(
          "UNRESOLVED_REFERENCE",
          `"${ref.raw}" does not match any connection in this agent's context (connections: ${[...connectionsBySlug.keys()].join(", ") || "none"}). Prose "@words" count as references — rephrase or add the connection.`,
          { raw: ref.raw, name: ref.name },
        );
      }
    }
  }

  // Rewrite from the end so earlier spans stay valid.
  let resolved = source;
  for (const ref of [...refs].reverse()) {
    if (ref.kind === "trigger") continue; // unreachable — thrown above
    const replacement =
      ref.kind === "skill"
        ? `the "${ref.slug}" skill`
        : `the "${ref.name}" connection`;
    resolved =
      resolved.slice(0, ref.start) + replacement + resolved.slice(ref.end);
  }

  const sections: string[] = [resolved.trim()];

  const appendix: string[] = [];
  if (deps.connections.length > 0) {
    appendix.push(
      "### Connections (discover tools with `connection_search`)",
      ...deps.connections.map(
        (connection) => `- **${connection.slug}** — ${connection.description}`,
      ),
    );
  }
  if (deps.skills.length > 0) {
    if (appendix.length > 0) appendix.push("");
    appendix.push(
      "### Skills (load on demand with `load_skill`)",
      ...deps.skills.map((skill) => `- **${skill.slug}** — ${skill.description}`),
    );
  }
  if (appendix.length > 0) {
    sections.push(["## Workspace context", "", ...appendix].join("\n"));
  }

  return { markdown: `${sections.join("\n\n---\n\n")}\n` };
}
