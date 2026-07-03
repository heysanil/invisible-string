/** Small helpers for emitting TypeScript/JSON/YAML-safe literals. */

/** A double-quoted TS string literal (JSON escaping is valid TS). */
export function tsString(value: string): string {
  return JSON.stringify(value);
}

/** An inline TS array of string literals: `["a", "b"]`. */
export function tsStringArray(values: readonly string[]): string {
  return `[${values.map(tsString).join(", ")}]`;
}

/** A double-quoted YAML scalar (JSON string is a valid YAML flow scalar). */
export function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** `my-conn` → `MY_CONN` (slug grammar has no `_`, so this is injective). */
export function slugToEnvSegment(slug: string): string {
  return slug.toUpperCase().replaceAll("-", "_");
}

/** Env var the generated bearer-token connection reads. */
export function connectionTokenEnvVar(slug: string): string {
  return `MCP_${slugToEnvSegment(slug)}_TOKEN`;
}

/** Lowercase kebab slug, 1–64 chars, no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Env var NAME grammar (values are injected by the supervisor). */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** HTTP header NAME grammar (RFC 7230 token, pragmatic subset). */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
