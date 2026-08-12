/**
 * Tool-call DISPLAY contract (2026-08-11 spec D5) — everything needed to render
 * one tool call as English ("Linear · Create issue") instead of as
 * `linear__create_issue` plus a serialized-JSON blob.
 *
 * Three pieces, deliberately together in one pure module so the control plane
 * and the SPA cannot drift on any of them:
 *
 * 1. **The wire↔display split.** A compiled agent's MCP tools are namespaced
 *    `<connection-slug>__<tool>` (`packages/compiler/src/codegen/connections.ts`
 *    `qualify()`); eve's own builtins (`ask_question`, `read_file`, …) carry no
 *    prefix. The connection slug grammar is lowercase kebab with NO underscore
 *    (`codegen/strings.ts` — "slug grammar has no `_`, so this is injective"),
 *    which is what makes splitting on the FIRST `__` unambiguous even when the
 *    bare tool name contains underscores or a `__` of its own.
 * 2. **The directory** the server projects from data it already holds: the
 *    version row's `connection_slugs` map (slug → connection id) joined to each
 *    connection's display name and its probe-cached `tools/list` metadata
 *    (`connections.tools_cache`). Nothing new is ever fetched from an MCP
 *    server to render a thread.
 * 3. **The resolved shape** ({@link ToolDisplay}) the thread renders, plus
 *    {@link summarizeToolResult} — a short human summary of a result value,
 *    with the raw output left reachable on demand but never shown by default.
 *
 * An UNKNOWN slug (a connection detached from the agent since the run, a
 * version published before `connection_slugs` existed) degrades to a null
 * `connectionName` while still humanizing the tool — the caller can fall back
 * to the slug itself, which stays on {@link ToolDisplay.connectionSlug}.
 */
import { z } from "zod";

import { connectionIdSchema, connectionToolSchema, type ConnectionTool } from "./api";
import type { EveJsonValue } from "./eve-events";

// ── the wire name split ─────────────────────────────────────────────────────

/** Separator the compiler puts between a connection slug and its tool name. */
export const QUALIFIED_TOOL_SEPARATOR = "__";

/** A qualified tool name taken apart, with the bare name humanized. */
export interface ParsedToolName {
  /** Connection slug prefix; null for an unprefixed (builtin) tool. */
  connectionSlug: string | null;
  /** The bare tool name with any `<slug>__` prefix removed. */
  toolName: string;
  /** Human label for {@link toolName} ("Create issue"). */
  label: string;
}

/**
 * Split `<slug>__<tool>` on the FIRST separator. Unprefixed names, and names
 * whose split would leave either half empty (`__x`, `x__`), are treated as
 * builtins rather than half-parsed — a display path must never invent a
 * connection that does not exist.
 */
export function splitQualifiedToolName(qualified: string): {
  connectionSlug: string | null;
  toolName: string;
} {
  const at = qualified.indexOf(QUALIFIED_TOOL_SEPARATOR);
  if (at <= 0) return { connectionSlug: null, toolName: qualified };
  const slug = qualified.slice(0, at);
  const tool = qualified.slice(at + QUALIFIED_TOOL_SEPARATOR.length);
  if (tool.length === 0) return { connectionSlug: null, toolName: qualified };
  return { connectionSlug: slug, toolName: tool };
}

/**
 * `create_issue` → "Create issue", `searchIssues` → "Search issues",
 * `getHTTPStatus` → "Get HTTP status", `list-repos` → "List repos".
 *
 * Word case is preserved for anything that is not a plain Capitalized word, so
 * acronyms survive; only the first word is capitalized, so the result reads as
 * a sentence fragment rather than as Title Case. An input that humanizes to
 * nothing (punctuation only) comes back unchanged — never blank.
 */
export function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/[_\-.]+/g, " ")
    // camelCase / snake-free boundaries: `searchIssues` → `search Issues`.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // acronym followed by a word: `HTTPStatus` → `HTTP Status`.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (spaced.length === 0) return name;
  const words = spaced.split(" ").map((word, index) =>
    // Downcase ONLY plain Capitalized words after the first, so "Issues"
    // becomes "issues" while "HTTP"/"URL" keep their shape.
    index > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word,
  );
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** {@link splitQualifiedToolName} + {@link humanizeToolName} in one step. */
export function parseQualifiedToolName(qualified: string): ParsedToolName {
  const { connectionSlug, toolName } = splitQualifiedToolName(qualified);
  return { connectionSlug, toolName, label: humanizeToolName(toolName) };
}

// ── the server-projected directory ──────────────────────────────────────────
//
//   GET /workspaces/:workspaceId/agents/:agentId/versions/:versionId/tools
//     → GetAgentVersionToolsResponse
//
// Read-only projection of rows the control plane already has. `tools` is empty
// (never absent) when the connection has no successful probe behind it — the
// thread then shows the humanized name with no description, which is exactly
// the pre-D5 rendering minus the raw slug.

export const connectionToolDirectoryEntrySchema = z.object({
  /** The per-version `<slug>__` prefix, from `agent_versions.connection_slugs`. */
  slug: z.string().min(1),
  connectionId: connectionIdSchema,
  /** `connections.name` — what the step actually shows the user. */
  connectionName: z.string().min(1),
  /** Probe-cached `tools/list` metadata; empty when never probed OK. */
  tools: z.array(connectionToolSchema),
});
export type ConnectionToolDirectoryEntry = z.infer<
  typeof connectionToolDirectoryEntrySchema
>;

export const agentVersionToolDirectorySchema = z.object({
  /** Echoed so a client caching per version cannot mis-attribute a response. */
  agentVersionId: z.uuid(),
  connections: z.array(connectionToolDirectoryEntrySchema),
});
export type AgentVersionToolDirectory = z.infer<
  typeof agentVersionToolDirectorySchema
>;

export const getAgentVersionToolsResponseSchema = z.object({
  directory: agentVersionToolDirectorySchema,
});
export type GetAgentVersionToolsResponse = z.infer<
  typeof getAgentVersionToolsResponseSchema
>;

// ── resolution ──────────────────────────────────────────────────────────────

/** Slug → connection, and slug → its tools by bare name. Build once, reuse. */
export interface ToolDirectoryIndex {
  readonly bySlug: ReadonlyMap<
    string,
    {
      readonly entry: ConnectionToolDirectoryEntry;
      readonly toolsByName: ReadonlyMap<string, ConnectionTool>;
    }
  >;
}

/** Index for "no directory loaded yet" — resolution degrades, never throws. */
export const EMPTY_TOOL_DIRECTORY_INDEX: ToolDirectoryIndex = {
  bySlug: new Map(),
};

export function indexToolDirectory(
  directory: AgentVersionToolDirectory | null | undefined,
): ToolDirectoryIndex {
  if (directory === null || directory === undefined) {
    return EMPTY_TOOL_DIRECTORY_INDEX;
  }
  const bySlug = new Map<
    string,
    {
      entry: ConnectionToolDirectoryEntry;
      toolsByName: ReadonlyMap<string, ConnectionTool>;
    }
  >();
  for (const entry of directory.connections) {
    const toolsByName = new Map<string, ConnectionTool>();
    for (const tool of entry.tools) toolsByName.set(tool.name, tool);
    bySlug.set(entry.slug, { entry, toolsByName });
  }
  return { bySlug };
}

/** One tool call, resolved for rendering. */
export interface ToolDisplay {
  /** The raw wire name — the key for the on-demand raw view. */
  qualifiedName: string;
  /** Connection slug; null for a builtin. Present even for an unknown slug. */
  connectionSlug: string | null;
  /** Connection display name; null for a builtin OR an unresolvable slug. */
  connectionName: string | null;
  /** Bare tool name (prefix stripped). */
  toolName: string;
  /** Humanized {@link toolName} — the step's title. */
  label: string;
  /** Probe-cached tool description — the step's subtitle; null when unknown. */
  description: string | null;
  /** Short result summary; null while pending or when nothing summarizes. */
  resultSummary: string | null;
}

/**
 * Resolve a qualified tool name against a directory index. Everything is
 * optional on purpose: a thread renders correctly (just less richly) before
 * the directory has loaded, and for calls whose connection is long gone.
 */
export function resolveToolDisplay(
  qualifiedName: string,
  index: ToolDirectoryIndex = EMPTY_TOOL_DIRECTORY_INDEX,
  resultSummary: string | null = null,
): ToolDisplay {
  const { connectionSlug, toolName, label } =
    parseQualifiedToolName(qualifiedName);
  const found =
    connectionSlug === null ? undefined : index.bySlug.get(connectionSlug);
  const description = found?.toolsByName.get(toolName)?.description ?? null;
  return {
    qualifiedName,
    connectionSlug,
    connectionName: found?.entry.connectionName ?? null,
    toolName,
    label,
    description: description !== null && description.length > 0 ? description : null,
    resultSummary,
  };
}

// ── result summaries ────────────────────────────────────────────────────────

/** Hard cap on a rendered result summary (the raw view carries the rest). */
export const TOOL_RESULT_SUMMARY_MAX_CHARS = 120;

/** Object keys worth quoting verbatim, most specific first. */
const SUMMARY_FIELDS = [
  "summary",
  "message",
  "title",
  "name",
  "text",
  "description",
  "url",
  "status",
] as const;

function clamp(text: string): string | null {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > TOOL_RESULT_SUMMARY_MAX_CHARS
    ? `${oneLine.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS)}…`
    : oneLine;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A SHORT English summary of a tool result — what a step shows instead of
 * `JSON.stringify(output)` (D5).
 *
 * The MCP `tools/call` envelope (`{content: [{type:"text", text}], isError}`)
 * is the case that matters most: an agent's tool output is almost always that
 * shape, and its text parts are the only part a human wants at a glance.
 * Everything else degrades to a count ("12 items", "3 fields") rather than to
 * a truncated JSON blob, because a truncated blob is noise, not information.
 * Returns null when there is genuinely nothing to say — callers must render
 * no summary rather than an empty one.
 */
export function summarizeToolResult(
  value: EveJsonValue | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clamp(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "No results";
    // A flat list of scalars reads better inline than as a count.
    const scalars = value.filter(
      (item) => typeof item === "string" || typeof item === "number",
    );
    if (scalars.length === value.length && value.length <= 3) {
      return clamp(scalars.map(String).join(", "));
    }
    return plural(value.length, "item");
  }

  const record = value as { [key: string]: EveJsonValue };

  // MCP tools/call envelope: prefer its text parts over any other key.
  const content = record.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as { [key: string]: EveJsonValue }).text;
      if (typeof text === "string" && text.trim().length > 0) texts.push(text);
    }
    if (texts.length > 0) return clamp(texts.join(" "));
    if (content.length > 0) return plural(content.length, "attachment");
  }

  for (const field of SUMMARY_FIELDS) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return clamp(candidate);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  return plural(keys.length, "field");
}
