/**
 * The agent editor's THREE save states (2026-08-11 spec D3).
 *
 * `isDirty` only ever compared the draft against the last SAVE, so the gap
 * between "saved" and "live" was invisible: an agent could be fully saved,
 * read "Published", and be running week-old bytes. The missing baseline is
 * `agents.publishedDefinition`, already on the agent DTO — so this is a purely
 * client-side comparison.
 *
 *   Unsaved changes   draft ≠ last save          (the existing isDirty)
 *   Unpublished changes   last save ≠ publishedDefinition, OR the agent has
 *                         been RENAMED since it was published
 *   Published         saved and matching the published version
 *
 * An agent that has NEVER been published reads as **Draft**, not "unpublished
 * changes" — there is nothing to be behind.
 *
 * THE NAME COUNTS. `agents.name` is not part of the definition, so a rename
 * moves neither baseline — yet D1 kept `agentSlug` in the content hash on
 * purpose, because the display name still shapes emitted BYTES (the generated
 * package name and the model-visible identity line, `packages/compiler`'s
 * hash.ts). A renamed published agent is therefore genuinely behind: the live
 * artifact still introduces itself by the old name until it is republished,
 * and reading "Published" over that is the same lie D3 exists to end. The
 * comparison is by SLUG, since the slug is what the hash actually carries —
 * casing and punctuation that slugify identically are not drift.
 *
 * Why not `agentEditorStatesEqual` (JSON.stringify) against the published
 * baseline: it is key-ORDER sensitive, and the two sides are built by
 * different producers. The reducer's `withModel` emits `{preset, reasoning,
 * modelId}` while a fresh `agentDefinitionSchema` parse emits schema order
 * `{preset, modelId, reasoning}`, so an edit that changes nothing semantically
 * would flip the chip to "Unpublished changes" forever. That comparison is
 * fine for `isDirty` (both sides are locally produced, same order) and wrong
 * here, hence {@link definitionsEquivalent}'s canonical serialization.
 */
import {
  parseAgentDefinition,
  type AgentDefinition,
  type AgentDto,
} from "@invisible-string/shared";

import { slugifyName } from "../builder/references";

export const AGENT_LIFECYCLE_STATES = [
  "draft",
  "unsaved",
  "unpublished",
  "published",
] as const;
export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

export const AGENT_LIFECYCLE_LABELS: Record<AgentLifecycleState, string> = {
  draft: "Draft",
  unsaved: "Unsaved changes",
  unpublished: "Unpublished changes",
  published: "Published",
};

export interface AgentLifecycleInput {
  /** The existing dirtiness signal: draft ≠ last save. */
  hasUnsavedChanges: boolean;
  /** The definition as last persisted (NOT the live keystroke draft). */
  savedDefinition: AgentDefinition;
  /**
   * `agent.publishedDefinition` AS SERVED (jsonb, unparsed) — null while the
   * agent has never been published.
   */
  publishedDefinition: unknown;
  /** The agent row's CURRENT display name (`agent.name`). */
  currentName?: string;
  /**
   * The display name the current published version was compiled under, from
   * {@link publishedAgentName}. `undefined`/`null` means UNKNOWN, and an
   * unknown baseline never claims drift — the same discipline the
   * unparseable-definition case follows.
   */
  publishedName?: string | null;
}

/**
 * Resolve the editor's single lifecycle state, most-urgent-first: an unsaved
 * edit outranks a publish gap, which outranks the resting states.
 */
export function agentLifecycleState(
  input: AgentLifecycleInput,
): AgentLifecycleState {
  if (input.hasUnsavedChanges) return "unsaved";
  if (input.publishedDefinition == null) return "draft";
  if (renamedSincePublish(input.currentName, input.publishedName)) {
    return "unpublished";
  }
  const published = parseAgentDefinition(input.publishedDefinition);
  // A published definition this client cannot parse (written by a newer
  // server) proves nothing about drift — never cry "unpublished" on it.
  if (published === null) return "published";
  return definitionsEquivalent(input.savedDefinition, published)
    ? "published"
    : "unpublished";
}

/**
 * Has the agent been renamed in a way that re-keys its artifact? Compare the
 * compiler's slug, not the raw string — `slugifyName` here mirrors
 * `apps/control-plane/src/build/compiler-adapter.ts`, and the empty-slug
 * fallback mirrors `compile-service.ts`'s `slugifyName(agent.name) || "agent"`.
 *
 * Either side unknown ⇒ false. A baseline the server has not told us is not
 * evidence of drift, and a false "Unpublished changes" that never clears is
 * worse than the gap this closes.
 */
export function renamedSincePublish(
  currentName: string | undefined,
  publishedName: string | null | undefined,
): boolean {
  if (currentName === undefined || publishedName == null) return false;
  return agentSlugOf(currentName) !== agentSlugOf(publishedName);
}

/** The slug the compiler bakes for a display name (empty ⇒ "agent"). */
export function agentSlugOf(name: string): string {
  return slugifyName(name) || "agent";
}

/**
 * The display name the agent's CURRENT published version was compiled under.
 *
 * The server does not serve it yet — `agent_versions` has no name column and
 * `AgentDto` has no `publishedName` — so this reads the field defensively and
 * yields `undefined` until it lands, which {@link renamedSincePublish} treats
 * as "no evidence", never as "no drift proven". Everything downstream is
 * already wired; adding the field to the DTO is the only remaining step.
 */
export function publishedAgentName(agent: AgentDto): string | null | undefined {
  return (agent as AgentDto & { publishedName?: string | null }).publishedName;
}

/**
 * Content equality for two definitions, insensitive to object key order and
 * to keys carrying `undefined` (the reducer omits cleared overrides, but a
 * stored draft may still round-trip one). Array order stays significant —
 * reordering an agent's connections IS a change.
 */
export function definitionsEquivalent(
  a: AgentDefinition,
  b: AgentDefinition,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Deterministic JSON: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}
