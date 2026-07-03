/**
 * `@reference` sources for the instructions editor: the autocomplete option
 * list and the unresolved-reference detector. Both speak the SAME grammar as
 * `parseReferences` (packages/shared) and the SAME slugs as the compiler
 * (`slugifyName` mirrors apps/control-plane/src/build/compiler-adapter.ts —
 * `@refs` address connections/skills by slug at compile time).
 *
 * Tested in __tests__/builder-references.test.ts: every emitted token must
 * parse back to exactly one reference of the intended kind.
 */
import {
  parseReferences,
  type ParsedReference,
  type TriggerConfig,
} from "@invisible-string/shared";

// ── Slugs (compiler mirror) ─────────────────────────────────────────────────

/** Lowercase-kebab slug from a human name — MUST match the compiler adapter. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

// ── Sources ─────────────────────────────────────────────────────────────────

export interface NamedResource {
  name: string;
  description?: string | null;
}

export interface ReferenceSources {
  trigger: TriggerConfig;
  /** Attached MCP connections (the workflow's context pillar, resolved). */
  connections: readonly NamedResource[];
  /** Attached skills. */
  skills: readonly NamedResource[];
}

export type ReferenceOptionKind = "trigger" | "connection" | "skill";

/** One autocomplete option (`label` is the literal text inserted). */
export interface ReferenceOption {
  /** Inserted token, e.g. "@trigger.email", "@linear", "@skill.release-notes". */
  label: string;
  kind: ReferenceOptionKind;
  /** Right-aligned hint, e.g. "form field" / "connection" / "skill". */
  detail: string;
  /** Longer description shown in the completion info panel. */
  info?: string;
}

/** Trigger types whose dispatch envelope carries `data` for `@trigger.*`. */
export function triggerCarriesData(trigger: TriggerConfig): boolean {
  return (
    trigger.type === "form" ||
    trigger.type === "webhook" ||
    trigger.type === "slack"
  );
}

/**
 * Build the `@` autocomplete option list from the live draft: form-trigger
 * field keys (`@trigger.<key>`), attached connections (`@<slug>`) and skills
 * (`@skill.<slug>`). Resources whose names slugify to "" are unaddressable
 * and omitted (the compiler rejects them at publish).
 */
export function referenceOptions(sources: ReferenceSources): ReferenceOption[] {
  const options: ReferenceOption[] = [];

  if (sources.trigger.type === "form") {
    for (const field of sources.trigger.fields) {
      options.push({
        label: `@trigger.${field.key}`,
        kind: "trigger",
        detail: "form field",
        info: field.label
          ? `"${field.label}" — resolved from the submitted form when a run starts.`
          : "Resolved from the submitted form when a run starts.",
      });
    }
  }

  for (const connection of sources.connections) {
    const slug = slugifyName(connection.name);
    if (slug === "") continue;
    options.push({
      label: `@${slug}`,
      kind: "connection",
      detail: "connection",
      info: connection.description?.trim() || connection.name,
    });
  }

  for (const skill of sources.skills) {
    const slug = slugifyName(skill.name);
    if (slug === "") continue;
    options.push({
      label: `@skill.${slug}`,
      kind: "skill",
      detail: "skill",
      info: skill.description?.trim() || skill.name,
    });
  }

  return options;
}

// ── Unresolved references ───────────────────────────────────────────────────

export interface ReferenceProblem {
  ref: ParsedReference;
  /** Human explanation, mirrors the compiler's publish-time errors. */
  reason: string;
}

/**
 * Why `ref` would fail to compile against `sources` — or null when it
 * resolves. Mirrors packages/compiler/src/instructions.ts checks so the
 * editor's amber underlines predict publish-time errors.
 */
export function referenceProblem(
  ref: ParsedReference,
  sources: ReferenceSources,
): string | null {
  if (ref.kind === "trigger") {
    if (ref.path === "") {
      return "Bare @trigger — name a data path like @trigger.email.";
    }
    if (!triggerCarriesData(sources.trigger)) {
      return `A ${sources.trigger.type} trigger carries no dispatch data — @trigger.* references cannot resolve.`;
    }
    if (sources.trigger.type === "form") {
      const head = ref.path.split(".")[0] ?? "";
      if (!sources.trigger.fields.some((field) => field.key === head)) {
        return `No form field is keyed "${head}".`;
      }
    }
    return null;
  }

  if (ref.kind === "skill") {
    if (ref.slug === "") {
      return "Bare @skill — name a skill like @skill.release-notes.";
    }
    const known = sources.skills.some(
      (skill) => slugifyName(skill.name) === ref.slug,
    );
    return known
      ? null
      : `No attached skill is named "${ref.slug}" — attach it in Context.`;
  }

  const known = sources.connections.some(
    (connection) => slugifyName(connection.name) === ref.name,
  );
  return known
    ? null
    : `No attached connection is named "${ref.name}" — attach it in Context, or rephrase if this is prose.`;
}

/** Every reference in `markdown` that would fail to compile, in order. */
export function unresolvedReferences(
  markdown: string,
  sources: ReferenceSources,
): ReferenceProblem[] {
  const problems: ReferenceProblem[] = [];
  for (const ref of parseReferences(markdown)) {
    const reason = referenceProblem(ref, sources);
    if (reason !== null) problems.push({ ref, reason });
  }
  return problems;
}
