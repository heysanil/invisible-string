/**
 * `@reference` sources for the pipeline editors: the autocomplete option
 * list and the unresolved-reference detector. Both speak the SAME grammar as
 * `parseReferences` (packages/shared) and the SAME slugs as the compiler
 * (`slugifyName` mirrors apps/control-plane/src/build/compiler-adapter.ts —
 * `@refs` address connections/skills by slug at compile time; step/state
 * handles come from the config itself).
 *
 * Sources are POSITIONAL in a pipeline: a step's markdown surface may only
 * reference steps strictly before it (`stepsBefore` — no forward refs in
 * autocomplete), and `@item` exists only inside a for_each body. Use
 * {@link referenceSourcesForStep} to derive the per-position sources from the
 * live draft.
 *
 * Tested in __tests__/builder-references.test.ts: every emitted token must
 * parse back to exactly one reference of the intended kind.
 */
import {
  parseReferences,
  stepsBefore,
  walkSteps,
  type OutputSchemaNode,
  type ParsedReference,
  type PipelineStep,
  type PipelineStepKind,
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

/** One prior step addressable as `@steps.<slug>` from the current position. */
export interface StepReferenceSource {
  /** The `@steps.<slug>` handle (non-empty — slugless steps are unaddressable). */
  slug: string;
  /** Display name for the completion info panel (falls back to the slug). */
  name?: string | null;
  kind: PipelineStepKind;
  /**
   * Dot paths into the step's output worth offering in autocomplete (e.g.
   * "result", "text"). Derived per kind ({@link stepOutputHints}); the author
   * can always type a deeper path by hand.
   */
  outputHints: readonly string[];
}

export interface ReferenceSources {
  trigger: TriggerConfig;
  /**
   * Steps whose output is addressable from the current position —
   * `stepsBefore(currentStepId)` ONLY, never the whole tree (forward refs
   * would resolve "(not provided)" at run time).
   */
  steps: readonly StepReferenceSource[];
  /** State keys any `state` step in the config writes (`@state.<key>`). */
  stateKeys: readonly string[];
  /** True only when the surface lives inside a for_each body (`@item`). */
  item: boolean;
  /** Attached MCP connections (an agent STEP's bound agent's context). */
  connections: readonly NamedResource[];
  /** Attached skills (same provenance as connections). */
  skills: readonly NamedResource[];
}

/**
 * All the reference kinds the shared grammar can classify — the chip system
 * (lib/editor/reference.ts) stamps this on every `@reference` node.
 */
export type ReferenceOptionKind = ParsedReference["kind"];

/** One autocomplete option (`label` is the literal text inserted). */
export interface ReferenceOption {
  /** Inserted token, e.g. "@trigger.email", "@steps.search.result", "@now". */
  label: string;
  kind: ReferenceOptionKind;
  /** Right-aligned hint, e.g. "form field" / "tool step" / "state key". */
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
 * The FIXED data keys the Slack adapter emits in TriggerEvent.data
 * (packages/shared/src/trigger-adapters.ts slackEventToTriggerData) — offered
 * in autocomplete so authors never have to guess key names that would only
 * fail at runtime as "(not provided)".
 */
export const SLACK_TRIGGER_DATA_KEYS: readonly { key: string; info: string }[] = [
  { key: "text", info: "The Slack message text (mention stripped)." },
  { key: "user", info: "Slack user id of the sender." },
  { key: "channel", info: "Slack channel id the message was posted in." },
  { key: "ts", info: "Message timestamp (Slack ts)." },
  { key: "thread_ts", info: "Thread root timestamp (the reply target)." },
  { key: "team", info: "Slack team (workspace) id." },
  { key: "eventType", info: "Inbound event type: app_mention or message." },
  { key: "channelType", info: "Channel type (channel / group / im) when known." },
];

// ── Per-position source derivation ──────────────────────────────────────────

/**
 * Output paths worth offering per step kind. Conservative: the envelopes the
 * runner persists (`{result, text, isError}` for tool, `{text}`/`{result}`
 * for infer/agent, `{items}` for a loop's aggregate) — an author can always
 * type a deeper path by hand.
 */
export function stepOutputHints(step: PipelineStep): string[] {
  switch (step.kind) {
    case "tool":
      return ["result", "text"];
    case "infer": {
      const schema = step.output?.schema;
      if (!schema) return ["text"];
      return schema.type === "object"
        ? ["result", ...objectKeys(schema).map((key) => `result.${key}`)]
        : ["result"];
    }
    case "agent":
      return step.output ? ["result"] : ["text"];
    case "for_each":
      return ["items"];
    case "branch":
    case "filter":
    case "state":
      return [];
  }
}

function objectKeys(schema: OutputSchemaNode): string[] {
  return schema.type === "object" ? Object.keys(schema.properties) : [];
}

/** Every state key any `state` step in the tree writes, in document order. */
export function stateKeysOf(steps: readonly PipelineStep[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of walkSteps(steps)) {
    if (entry.step.kind !== "state") continue;
    for (const key of Object.keys(entry.step.set)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Whether `stepId` sits inside a for_each body (`@item` is addressable). */
export function isInsideForEach(
  steps: readonly PipelineStep[],
  stepId: string,
): boolean {
  const entry = walkSteps(steps).find((candidate) => candidate.step.id === stepId);
  return (
    entry !== undefined &&
    entry.ancestors.some((ancestor) => ancestor.kind === "for_each")
  );
}

/** The trigger/connections/skills half of the sources a position inherits. */
export interface BaseReferenceSources {
  trigger: TriggerConfig;
  connections: readonly NamedResource[];
  skills: readonly NamedResource[];
}

/**
 * The reference sources for a surface belonging to `stepId` in the given
 * pipeline: prior steps only (slugless ones omitted — they have no handle),
 * every configured state key, and `@item` iff the step sits inside a loop.
 * `base` carries the trigger plus whatever connection/skill context the
 * surface resolves against (an agent step's bound agent's published context;
 * empty for tool/infer surfaces, where those refs are plain prose).
 */
export function referenceSourcesForStep(
  steps: readonly PipelineStep[],
  stepId: string,
  base: BaseReferenceSources,
): ReferenceSources {
  return {
    trigger: base.trigger,
    steps: stepsBefore(steps, stepId)
      .filter((step) => step.slug.length > 0)
      .map((step) => ({
        slug: step.slug,
        name: step.name ?? null,
        kind: step.kind,
        outputHints: stepOutputHints(step),
      })),
    stateKeys: stateKeysOf(steps),
    item: isInsideForEach(steps, stepId),
    connections: base.connections,
    skills: base.skills,
  };
}

// ── Autocomplete options ────────────────────────────────────────────────────

const STEP_KIND_DETAIL: Record<PipelineStepKind, string> = {
  tool: "tool step",
  infer: "infer step",
  agent: "agent step",
  for_each: "loop",
  branch: "branch",
  filter: "filter",
  state: "state step",
};

/**
 * Build the `@` autocomplete option list from the live draft: trigger data
 * keys (`@trigger.<key>`), prior step outputs (`@steps.<slug>[.<hint>]`),
 * state keys (`@state.<key>`), `@item` inside loops, `@now`, then attached
 * connections (`@<slug>`) and skills (`@skill.<slug>`). Resources whose names
 * slugify to "" are unaddressable and omitted.
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

  if (sources.trigger.type === "slack") {
    for (const { key, info } of SLACK_TRIGGER_DATA_KEYS) {
      options.push({
        label: `@trigger.${key}`,
        kind: "trigger",
        detail: "slack event",
        info,
      });
    }
  }

  if (sources.trigger.type === "webhook") {
    options.push({
      label: "@trigger.message",
      kind: "trigger",
      detail: "webhook body",
      info: 'The "message" field of the posted JSON (the documented convention). Any other top-level key is addressable as @trigger.<key>.',
    });
  }

  for (const step of sources.steps) {
    const stepName = step.name?.trim() || step.slug;
    options.push({
      label: `@steps.${step.slug}`,
      kind: "step",
      detail: STEP_KIND_DETAIL[step.kind],
      info: `"${stepName}" — this step's whole output.`,
    });
    for (const hint of step.outputHints) {
      options.push({
        label: `@steps.${step.slug}.${hint}`,
        kind: "step",
        detail: STEP_KIND_DETAIL[step.kind],
        info: `"${stepName}" — its ${hint}.`,
      });
    }
  }

  for (const key of sources.stateKeys) {
    options.push({
      label: `@state.${key}`,
      kind: "state",
      detail: "state key",
      info: "Persisted workflow state — survives across runs.",
    });
  }

  if (sources.item) {
    options.push({
      label: "@item",
      kind: "item",
      detail: "loop item",
      info: "The current for_each item (dot into it for fields, e.g. @item.id).",
    });
  }

  options.push({
    label: "@now",
    kind: "now",
    detail: "timestamp",
    info: "The run's ISO timestamp.",
  });

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
  /** Human explanation, mirrors the validators' publish-time errors. */
  reason: string;
}

/**
 * Why `ref` would fail to resolve against `sources` — or null when it
 * resolves. Mirrors the server-side workflow validator so the editor's amber
 * underlines predict publish-time errors.
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

  if (ref.kind === "step") {
    if (ref.slug === "") {
      return "Bare @steps — name a step like @steps.search.";
    }
    return sources.steps.some((step) => step.slug === ref.slug)
      ? null
      : `No earlier step is slugged "${ref.slug}" — steps can only reference outputs of steps before them.`;
  }

  if (ref.kind === "state") {
    if (ref.key === "") {
      return "Bare @state — name a key like @state.cursor.";
    }
    const head = ref.key.split(".")[0] ?? "";
    return sources.stateKeys.includes(head)
      ? null
      : `No state step writes "${head}" — add a state step that sets it.`;
  }

  if (ref.kind === "item") {
    return sources.item
      ? null
      : "@item only resolves inside a for_each body.";
  }

  if (ref.kind === "now") {
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

/** Every reference in `markdown` that would fail to resolve, in order. */
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

// ── `$ref` scope paths ──────────────────────────────────────────────────────

/**
 * Why a `{"$ref": "<path>"}` scope path (tool args, state writes, condition
 * operands, for_each items) would fail to resolve — or null when it does.
 * Unlike markdown, a `$ref` path has no prose escape hatch: its head must be
 * one of the run scope's roots (`trigger` / `steps` / `state` / `item` /
 * `now`) — connections/skills are structurally unreachable from a pipeline
 * scope (that is the secrets guarantee, not a validator choice).
 */
export function scopeRefProblem(
  path: string,
  sources: ReferenceSources,
): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return "Empty $ref — name a scope path like steps.search.result.";
  const segments = trimmed.split(".");
  const head = segments[0] ?? "";

  if (head === "trigger") {
    if (segments.length === 1) {
      return "Bare trigger — name a data path like trigger.email.";
    }
    if (!triggerCarriesData(sources.trigger)) {
      return `A ${sources.trigger.type} trigger carries no dispatch data.`;
    }
    if (sources.trigger.type === "form") {
      const key = segments[1] ?? "";
      if (!sources.trigger.fields.some((field) => field.key === key)) {
        return `No form field is keyed "${key}".`;
      }
    }
    return null;
  }

  if (head === "steps") {
    const slug = segments[1] ?? "";
    if (slug === "") return "Bare steps — name a step like steps.search.";
    return sources.steps.some((step) => step.slug === slug)
      ? null
      : `No earlier step is slugged "${slug}".`;
  }

  if (head === "state") {
    const key = segments[1] ?? "";
    if (key === "") return "Bare state — name a key like state.cursor.";
    return sources.stateKeys.includes(key)
      ? null
      : `No state step writes "${key}".`;
  }

  if (head === "item") {
    return sources.item ? null : "item only resolves inside a for_each body.";
  }

  if (head === "now") {
    return null;
  }

  return `"${head}" is not a scope root — paths start with trigger, steps, state, item or now.`;
}
