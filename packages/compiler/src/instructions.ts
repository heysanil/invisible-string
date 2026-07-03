/**
 * INSTRUCTIONS pillar → `agent/instructions.md`.
 *
 * Reference semantics (docs/PLAN.md "@reference semantics"):
 * - COMPILE time: `@<connection>` / `@skill.<slug>` become readable literal
 *   text, and a generated appendix lists each connection/skill WITH its
 *   description so eve's `connection_search` / `load_skill` routing can find
 *   them.
 * - DISPATCH time: `@trigger.<path>` refs are left as `{{trigger.<path>}}`
 *   template markers. The generated trigger channel bakes the marker list
 *   and resolves each path against `TriggerEvent.data` into a
 *   `<trigger-context>` block prepended to the model message (custom
 *   channels fold context into the message — PLAN correction 2).
 *
 * Unresolved references are compile errors: drafts may be lenient, published
 * versions may not (see workflow-definition.ts docs).
 */
import {
  parseReferences,
  type TriggerConfig,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import { CompileError } from "./errors";
import type { CompileDeps } from "./types";

export interface RenderedInstructions {
  /** Final content of `agent/instructions.md`. */
  readonly markdown: string;
  /** Unique `@trigger.*` paths in document order — baked into the channel. */
  readonly triggerRefPaths: readonly string[];
}

/** Trigger types whose dispatch envelope carries `data` for `@trigger.*`. */
function triggerCarriesData(trigger: TriggerConfig): boolean {
  return (
    trigger.type === "form" ||
    trigger.type === "webhook" ||
    trigger.type === "slack"
  );
}

function validateTriggerPath(
  trigger: TriggerConfig,
  path: string,
  raw: string,
): void {
  if (path === "") {
    throw new CompileError(
      "UNRESOLVED_REFERENCE",
      `bare "@trigger" reference — name a data path like "@trigger.email"`,
      { raw },
    );
  }
  if (!triggerCarriesData(trigger)) {
    throw new CompileError(
      "TRIGGER_REF_NOT_ALLOWED",
      `"${raw}" cannot be used with a "${trigger.type}" trigger — it carries no dispatch data`,
      { raw, triggerType: trigger.type },
    );
  }
  if (trigger.type === "form") {
    const head = path.split(".")[0] ?? "";
    if (!trigger.fields.some((field) => field.key === head)) {
      throw new CompileError(
        "TRIGGER_REF_UNKNOWN_FIELD",
        `"${raw}" does not match any form field key (fields: ${trigger.fields
          .map((field) => field.key)
          .join(", ")})`,
        { raw, fieldKey: head },
      );
    }
  }
}

export function renderInstructions(
  definition: WorkflowDefinition,
  deps: CompileDeps,
): RenderedInstructions {
  const source = definition.instructions.markdown;
  if (source.trim().length === 0) {
    throw new CompileError(
      "EMPTY_INSTRUCTIONS",
      "instructions are empty — a publishable workflow needs instructions.md content",
    );
  }

  const connectionsBySlug = new Map(
    deps.connections.map((connection) => [connection.slug, connection]),
  );
  const skillsBySlug = new Map(deps.skills.map((skill) => [skill.slug, skill]));

  const refs = parseReferences(source);
  const triggerRefPaths: string[] = [];

  // Validate every reference before rewriting anything.
  for (const ref of refs) {
    if (ref.kind === "trigger") {
      validateTriggerPath(definition.trigger, ref.path, ref.raw);
      if (!triggerRefPaths.includes(ref.path)) triggerRefPaths.push(ref.path);
    } else if (ref.kind === "skill") {
      if (ref.slug === "" || !skillsBySlug.has(ref.slug)) {
        throw new CompileError(
          "UNRESOLVED_REFERENCE",
          ref.slug === ""
            ? `bare "@skill" reference — name a skill like "@skill.release-notes"`
            : `"${ref.raw}" does not match any skill in this workflow's context (skills: ${[...skillsBySlug.keys()].join(", ") || "none"})`,
          { raw: ref.raw, slug: ref.slug },
        );
      }
    } else {
      if (!connectionsBySlug.has(ref.name)) {
        throw new CompileError(
          "UNRESOLVED_REFERENCE",
          `"${ref.raw}" does not match any connection in this workflow's context (connections: ${[...connectionsBySlug.keys()].join(", ") || "none"}). Prose "@words" count as references — rephrase or add the connection.`,
          { raw: ref.raw, name: ref.name },
        );
      }
    }
  }

  // Rewrite from the end so earlier spans stay valid.
  let resolved = source;
  for (const ref of [...refs].reverse()) {
    const replacement =
      ref.kind === "trigger"
        ? `{{trigger.${ref.path}}}`
        : ref.kind === "skill"
          ? `the "${ref.slug}" skill`
          : `the "${ref.name}" connection`;
    resolved =
      resolved.slice(0, ref.start) + replacement + resolved.slice(ref.end);
  }

  const sections: string[] = [];
  const persona = deps.agentPreset.persona.trim();
  if (persona.length > 0) sections.push(persona);
  sections.push(resolved.trim());

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
  if (triggerRefPaths.length > 0) {
    if (appendix.length > 0) appendix.push("");
    appendix.push(
      "### Trigger data",
      "`{{trigger.*}}` placeholders above are bound per run: each triggered message starts with a `<trigger-context>` block carrying the resolved values.",
    );
  }
  if (appendix.length > 0) {
    sections.push(["## Workspace context", "", ...appendix].join("\n"));
  }

  return {
    markdown: `${sections.join("\n\n---\n\n")}\n`,
    triggerRefPaths,
  };
}
