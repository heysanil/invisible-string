/**
 * Pure pipeline templating: reference resolution, markdown-surface rendering,
 * the structured tagged-value walk, and the condition evaluator. The runner
 * (apps/control-plane/src/pipeline) calls these against the run scope; the
 * SPA imports the SAME functions for previews — keep this module pure (no
 * node:* imports, no I/O, no clocks: `now` arrives ON the scope).
 *
 * The scope is deliberately the ONLY resolution root — trigger data, prior
 * step outputs, workflow state, the current loop item, and the run
 * timestamp. Credentials are structurally unreachable, so persisted
 * `run_steps.input` snapshots cannot contain secrets.
 *
 * Three rendering surfaces, three missing-value semantics (each locally
 * ergonomic — documented on the functions):
 * - markdown (`renderMarkdownTemplate`): missing → "(not provided)"
 * - structured (`renderTemplateValue`): missing → undefined; object keys
 *   drop, array slots become null (JSON.stringify parity)
 * - conditions (`evaluateCondition`): missing → null
 */
import {
  type ConditionOperand,
  type PipelineCondition,
  type TemplateValue,
} from "./pipeline-config";
import { formatTriggerValue } from "./render";
import { parseReferences, type ParsedReference } from "./workflow-config";

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * The resolution scope for one pipeline run. Mirrors the runner's
 * `PipelineScope` (apps/control-plane/src/pipeline/types.ts) — keep the two
 * in lockstep.
 */
export interface PipelineScope {
  /** The trigger event's `data` record (`@trigger.*`). */
  trigger: Record<string, unknown>;
  /** Prior step outputs by SLUG (`@steps.<slug>.*`). */
  steps: Record<string, Record<string, unknown>>;
  /** Workflow state as of this run (`@state.*`). */
  state: Record<string, unknown>;
  /** Current for_each item; absent outside a loop body (`@item`). */
  item?: unknown;
  /** ISO timestamp minted at run start (`@now`). */
  now: string;
}

/**
 * Resolve one dot path against the scope. The FIRST segment picks the head
 * (`trigger` / `steps` / `state` / `item` / `now`); the rest walk records
 * AND arrays (numeric segments index — unlike the legacy
 * `resolveTriggerPath`, which never did). A bare head resolves to the whole
 * value (`"steps.search"` → that step's full output record); an unknown
 * head, a missing path, or trailing segments after `now` resolve undefined.
 */
export function resolveScopePath(scope: PipelineScope, path: string): unknown {
  if (path === "") return undefined;
  const segments = path.split(".");
  const head = segments[0];
  const rest = segments.slice(1);
  switch (head) {
    case "trigger":
      return resolveSegments(scope.trigger, rest);
    case "steps":
      return resolveSegments(scope.steps, rest);
    case "state":
      return resolveSegments(scope.state, rest);
    case "item":
      return resolveSegments(scope.item, rest);
    case "now":
      return rest.length === 0 ? scope.now : undefined;
    default:
      return undefined;
  }
}

function resolveSegments(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** Resolve one parsed markdown `@reference` against the scope. */
function resolveReference(
  scope: PipelineScope,
  ref: ParsedReference,
): unknown {
  switch (ref.kind) {
    case "trigger":
      return resolveScopePath(scope, joinPath("trigger", ref.path));
    case "step":
      return resolveScopePath(
        scope,
        joinPath(joinPath("steps", ref.slug), ref.path),
      );
    case "state":
      return resolveScopePath(scope, joinPath("state", ref.key));
    case "item":
      return ref.path === "" ? scope.item : resolveScopePath(scope, joinPath("item", ref.path));
    case "now":
      return scope.now;
    default:
      return undefined; // connection/skill — prose literals, handled by the renderer
  }
}

function joinPath(head: string, rest: string): string {
  return rest === "" ? head : `${head}.${rest}`;
}

// ── Markdown-surface rendering ──────────────────────────────────────────────

/**
 * Render a markdown surface (infer prompts, agent-step instructions, the
 * onComplete Slack template) by rewriting every `@reference` in place:
 * scope refs inline their resolved value (strings verbatim, non-strings
 * JSON, missing → "(not provided)" — {@link formatTriggerValue} semantics);
 * `@connection` / `@skill.<slug>` refs become the same prose literals the
 * legacy task renderer produced.
 */
export function renderMarkdownTemplate(
  markdown: string,
  scope: PipelineScope,
): string {
  const refs = parseReferences(markdown);
  // Rewrite from the end so earlier spans stay valid.
  let resolved = markdown;
  for (const ref of [...refs].reverse()) {
    const replacement =
      ref.kind === "connection"
        ? `the "${ref.name}" connection`
        : ref.kind === "skill"
          ? `the "${ref.slug}" skill`
          : formatTriggerValue(resolveReference(scope, ref));
    resolved =
      resolved.slice(0, ref.start) + replacement + resolved.slice(ref.end);
  }
  return resolved;
}

// ── Structured-value rendering (the tagged walk) ────────────────────────────

/**
 * Render one {@link TemplateValue} against the scope:
 * - `{"$ref": "dot.path"}` (sole key) → the resolved value, TYPE-PRESERVED;
 *   a missing path resolves undefined
 * - `{"$tpl": "text"}` (sole key) → {@link renderMarkdownTemplate} output
 * - everything else is literal, walked recursively — object keys whose
 *   rendered value is undefined are DROPPED, array slots become null
 *   (exactly JSON.stringify's semantics, so an optional API param backed by
 *   unset state simply stays absent)
 *
 * An object carrying `$ref`/`$tpl` alongside OTHER keys is a literal object
 * (the schema's strict tag objects reject that shape anyway).
 */
export function renderTemplateValue(
  value: TemplateValue,
  scope: PipelineScope,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const rendered = renderTemplateValue(entry, scope);
      return rendered === undefined ? null : rendered;
    });
  }
  const record = value as Record<string, TemplateValue>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "$ref" && typeof record["$ref"] === "string") {
    return resolveScopePath(scope, record["$ref"]);
  }
  if (keys.length === 1 && keys[0] === "$tpl" && typeof record["$tpl"] === "string") {
    return renderMarkdownTemplate(record["$tpl"], scope);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const rendered = renderTemplateValue(entry, scope);
    if (rendered !== undefined) out[key] = rendered;
  }
  return out;
}

/** {@link renderTemplateValue} over a record (tool `args`, state `set`). */
export function renderTemplateRecord(
  record: Record<string, TemplateValue>,
  scope: PipelineScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const rendered = renderTemplateValue(entry, scope);
    if (rendered !== undefined) out[key] = rendered;
  }
  return out;
}

// ── Condition evaluation ────────────────────────────────────────────────────

/** Maximum condition-node nesting (the root node is depth 1). */
export const MAX_CONDITION_DEPTH = 8;

/**
 * Evaluate a {@link PipelineCondition} against the scope. Pure, no regex,
 * and depth-capped: nesting beyond {@link MAX_CONDITION_DEPTH} THROWS (the
 * runner classifies that as a config error — never a silent false).
 *
 * Semantics:
 * - operand `{$ref}` resolves against the scope; a MISSING path normalizes
 *   to null (so `{eq: [{$ref: "state.cursor"}, null]}` tests "unset")
 * - `and: []` → true, `or: []` → false (vacuous truth)
 * - `eq`/`ne`: structural deep equality
 * - `gt`/`gte`/`lt`/`lte`: number×number numeric, string×string
 *   lexicographic, anything else false
 * - `contains`: string substring, or array membership (deep equality)
 * - `in`: mirror of array-membership `contains` (needle first)
 * - `startsWith`/`endsWith`: strings only
 * - `exists`: not null (missing already normalized to null)
 * - `truthy`: JS Boolean() semantics
 * - `empty`: null, "", [], or {} → true
 */
export function evaluateCondition(
  condition: PipelineCondition,
  scope: PipelineScope,
): boolean {
  return evaluateNode(condition, scope, 1);
}

function evaluateNode(
  condition: PipelineCondition,
  scope: PipelineScope,
  depth: number,
): boolean {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new Error(
      `condition nesting exceeds the depth cap of ${MAX_CONDITION_DEPTH}`,
    );
  }
  if ("and" in condition) {
    return condition.and.every((child) => evaluateNode(child, scope, depth + 1));
  }
  if ("or" in condition) {
    return condition.or.some((child) => evaluateNode(child, scope, depth + 1));
  }
  if ("not" in condition) {
    return !evaluateNode(condition.not, scope, depth + 1);
  }
  if ("eq" in condition) {
    return deepEquals(operand(condition.eq[0], scope), operand(condition.eq[1], scope));
  }
  if ("ne" in condition) {
    return !deepEquals(operand(condition.ne[0], scope), operand(condition.ne[1], scope));
  }
  if ("gt" in condition) return compare(condition.gt, scope, (a, b) => a > b);
  if ("gte" in condition) return compare(condition.gte, scope, (a, b) => a >= b);
  if ("lt" in condition) return compare(condition.lt, scope, (a, b) => a < b);
  if ("lte" in condition) return compare(condition.lte, scope, (a, b) => a <= b);
  if ("contains" in condition) {
    const haystack = operand(condition.contains[0], scope);
    const needle = operand(condition.contains[1], scope);
    if (typeof haystack === "string" && typeof needle === "string") {
      return haystack.includes(needle);
    }
    if (Array.isArray(haystack)) {
      return haystack.some((entry) => deepEquals(entry, needle));
    }
    return false;
  }
  if ("startsWith" in condition) {
    const [a, b] = resolvePair(condition.startsWith, scope);
    return typeof a === "string" && typeof b === "string" && a.startsWith(b);
  }
  if ("endsWith" in condition) {
    const [a, b] = resolvePair(condition.endsWith, scope);
    return typeof a === "string" && typeof b === "string" && a.endsWith(b);
  }
  if ("exists" in condition) return operand(condition.exists, scope) !== null;
  if ("truthy" in condition) return Boolean(operand(condition.truthy, scope));
  if ("empty" in condition) {
    const value = operand(condition.empty, scope);
    if (value === null || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }
  if ("in" in condition) {
    const needle = operand(condition.in[0], scope);
    const list = operand(condition.in[1], scope);
    return Array.isArray(list) && list.some((entry) => deepEquals(entry, needle));
  }
  return false; // unreachable for parsed conditions
}

/** Resolve one operand; a missing `{$ref}` normalizes to null. */
function operand(value: ConditionOperand, scope: PipelineScope): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return resolveScopePath(scope, value.$ref) ?? null;
  }
  return value;
}

function resolvePair(
  pair: [ConditionOperand, ConditionOperand],
  scope: PipelineScope,
): [unknown, unknown] {
  return [operand(pair[0], scope), operand(pair[1], scope)];
}

function compare(
  pair: [ConditionOperand, ConditionOperand],
  scope: PipelineScope,
  op: (a: number | string, b: number | string) => boolean,
): boolean {
  const [a, b] = resolvePair(pair, scope);
  if (typeof a === "number" && typeof b === "number") {
    return Number.isFinite(a) && Number.isFinite(b) && op(a, b);
  }
  if (typeof a === "string" && typeof b === "string") return op(a, b);
  return false;
}

/** Structural equality over JSON-shaped values (=== on scalars, incl. NaN ≠ NaN). */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEquals(entry, b[i]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => deepEquals(aRecord[key], bRecord[key]))
    );
  }
  return false;
}
