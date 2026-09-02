/**
 * WorkflowConfig — a standing PIPELINE (TRIGGER → STEPS) stored on
 * `workflows.draft` and snapshotted into `workflows.published` at publish
 * (pipeline redesign spec; `version: 2` is the one and only shape — the
 * platform ships no v1 compatibility). Workflows compile nothing: the control
 * plane INTERPRETS the step tree (pipeline-config.ts), agent steps ride the
 * bound agent's current published version as child runs, and publish
 * validates + snapshots + syncs the trigger row.
 *
 * Draft-lenient by design: an empty pipeline, empty tool/connection strings,
 * and null agent-step agentIds all parse. Publish requires runnable steps
 * (published agents, real connections/tools, non-empty unique slugs, legal
 * `@references`). This schema guards SHAPE plus tree integrity (unique
 * ids/slugs, no nested for_each) — not publishability.
 *
 * Trigger `type` values mirror the packages/db pgEnum `trigger_type` — keep
 * them in lockstep.
 */
import { z } from "zod";

import { pipelineStepSchema, walkSteps } from "./pipeline-config";

// ── TRIGGER ─────────────────────────────────────────────────────────────────

/**
 * Form field kinds renderable by the Phase-2 form UI. The submitted values
 * become `TriggerEvent.data[key]`, addressable as `@trigger.<key>`.
 */
export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "checkbox",
  "date",
] as const;

export const formFieldTypeSchema = z.enum(FORM_FIELD_TYPES);
export type FormFieldType = z.infer<typeof formFieldTypeSchema>;

/**
 * Field keys double as `TriggerEvent.data` keys and `@trigger.<key>`
 * reference segments — the charset must stay a subset of the reference
 * grammar's segment charset (see {@link parseReferences}).
 */
const FORM_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const formFieldSchema = z
  .object({
    key: z
      .string()
      .regex(
        FORM_FIELD_KEY_PATTERN,
        "key must start with a letter and contain only letters, digits, _ or -",
      ),
    label: z.string().min(1),
    type: formFieldTypeSchema,
    required: z.boolean().default(false),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
    /** Choices for `select` fields; disallowed on every other type. */
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "select") {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "select fields require at least one option",
        });
      }
    } else if (field.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `options are only allowed on select fields (got type "${field.type}")`,
      });
    }
  });

export type FormField = z.infer<typeof formFieldSchema>;

/** Manual trigger: runs started from chat/builder; uses eve's default HTTP channel. */
export const manualTriggerSchema = z.object({ type: z.literal("manual") });

/** Form trigger: `POST /t/:token` with the rendered form's field values. */
export const formTriggerSchema = z
  .object({
    type: z.literal("form"),
    fields: z.array(formFieldSchema).min(1),
  })
  .superRefine((trigger, ctx) => {
    const seen = new Set<string>();
    trigger.fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "key"],
          message: `duplicate field key "${field.key}"`,
        });
      }
      seen.add(field.key);
    });
  });

/**
 * Webhook trigger: `POST /t/:token` with an arbitrary JSON payload (becomes
 * `TriggerEvent.data`). The ingress token is GENERATED at publish and stored
 * only as a hash on `triggers.token_hash` — it is never part of the
 * definition (secrets discipline).
 */
export const webhookTriggerSchema = z.object({ type: z.literal("webhook") });

/**
 * Routing binding for the single platform-level Slack app (spec §2 locked;
 * inbound events route by Slack `team_id` + this binding). Persisted on
 * `triggers.binding` at publish.
 */
export const slackTriggerBindingSchema = z.object({
  /** Slack channel id (e.g. "C0123456789"); omitted = any channel the app is in. */
  channelId: z.string().min(1).optional(),
  /** Only @-mentions of the app trigger (thread replies always continue sessions). */
  mentionOnly: z.boolean().default(true),
  /** Also trigger on direct messages to the app. */
  includeDirectMessages: z.boolean().default(false),
});

export type SlackTriggerBinding = z.infer<typeof slackTriggerBindingSchema>;

export const slackTriggerSchema = z.object({
  type: z.literal("slack"),
  binding: slackTriggerBindingSchema,
});

/**
 * Five-field cron (minute hour day-of-month month day-of-week). Shape-only
 * check — the control plane's cron evaluator is the real validator. At
 * publish the expression syncs to `triggers.cron`/`next_fire_at`; the
 * schedule ticker fires due triggers through the ordinary dispatch path.
 */
const CRON_5_FIELD_PATTERN = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export const cronExpressionSchema = z
  .string()
  .trim()
  .regex(
    CRON_5_FIELD_PATTERN,
    "expected a 5-field cron expression (minute hour day-of-month month day-of-week)",
  );

export const scheduleTriggerSchema = z.object({
  type: z.literal("schedule"),
  cron: cronExpressionSchema,
});

export const triggerConfigSchema = z.discriminatedUnion("type", [
  manualTriggerSchema,
  formTriggerSchema,
  webhookTriggerSchema,
  slackTriggerSchema,
  scheduleTriggerSchema,
]);

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

// ── @reference parsing ──────────────────────────────────────────────────────

/**
 * `@trigger.<path>` — resolved at RUN time against the trigger event's data
 * (dot path, e.g. `@trigger.customer.email` → `data.customer.email`; see
 * `renderMarkdownTemplate` in pipeline-template.ts). A bare `@trigger`
 * parses with `path: ""` so validators can flag it.
 */
export interface TriggerReference {
  kind: "trigger";
  /** Exact matched text, e.g. "@trigger.customer.email". */
  raw: string;
  /** Dot path into TriggerEvent.data ("" when the ref is a bare `@trigger`). */
  path: string;
  /** [start, end) character offsets into the markdown (editor spans). */
  start: number;
  end: number;
}

/**
 * `@steps.<slug>.<path>` — a prior pipeline step's output, resolved against
 * the run scope (`scope.steps[slug]`). A bare `@steps` parses with
 * `slug: ""`; `@steps.<slug>` alone (empty `path`) names the whole output
 * record.
 */
export interface StepReference {
  kind: "step";
  raw: string;
  /** The referenced step's slug ("" when the ref is a bare `@steps`). */
  slug: string;
  /** Dot path into that step's output ("" = the whole output). */
  path: string;
  start: number;
  end: number;
}

/**
 * `@state.<key>` — a workflow state value. `key` is the dot path into the
 * state record (first segment = the state key, later segments walk into the
 * value). A bare `@state` parses with `key: ""` so validators can flag it.
 */
export interface StateReference {
  kind: "state";
  raw: string;
  key: string;
  start: number;
  end: number;
}

/**
 * `@item` / `@item.<path>` — the current for_each item. Legal only inside a
 * loop body (validators enforce; the parser is lexical).
 */
export interface ItemReference {
  kind: "item";
  raw: string;
  /** Dot path into the item ("" = the item itself). */
  path: string;
  start: number;
  end: number;
}

/**
 * `@now` — the run's ISO timestamp. Takes no path: like connection refs, the
 * span truncates to the bare head (`@now.date` yields `@now` + literal
 * ".date").
 */
export interface NowReference {
  kind: "now";
  raw: string;
  start: number;
  end: number;
}

/**
 * `@<connection>` — rewritten to literal text (+ description) for an MCP
 * connection in the agent's context: at COMPILE time in personas, at
 * DISPATCH time in workflow instructions.
 */
export interface ConnectionReference {
  kind: "connection";
  raw: string;
  /** Connection name (first segment only — `@linear.x` still names "linear"). */
  name: string;
  start: number;
  end: number;
}

/**
 * `@skill.<slug>` — rewritten to literal text for an authored skill in the
 * agent's context (compile time in personas, dispatch time in workflow
 * instructions). A bare `@skill` parses with `slug: ""` so validators can
 * flag it.
 */
export interface SkillReference {
  kind: "skill";
  raw: string;
  slug: string;
  start: number;
  end: number;
}

export type ParsedReference =
  | TriggerReference
  | StepReference
  | StateReference
  | ItemReference
  | NowReference
  | ConnectionReference
  | SkillReference;

/** Parsed `@reference` inventory of a markdown document, grouped by kind. */
export interface ReferenceInventory {
  /** Every reference in document order. */
  all: ParsedReference[];
  trigger: TriggerReference[];
  steps: StepReference[];
  state: StateReference[];
  items: ItemReference[];
  now: NowReference[];
  connections: ConnectionReference[];
  skills: SkillReference[];
}

/**
 * Reference grammar: `@` followed by dot-separated segments. The first
 * segment must start with a letter (rejects "@5pm"-style prose); later
 * segments may be any of `[A-Za-z0-9_-]` (numeric trigger-data path indices
 * stay addressable). The lookbehind rejects `@` preceded by a word char,
 * dot, hyphen or another `@` — so email addresses (`sanil@example.com`) and
 * `@@` never match. Trailing dots are not consumed (`@trigger.email.` →
 * `@trigger.email`).
 */
const REFERENCE_PATTERN =
  /(?<![A-Za-z0-9_.@-])@([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)/g;

/**
 * Extract every `@reference` from a markdown surface, in document order.
 *
 * Classification (first segment):
 * - `trigger` → {@link TriggerReference} (path = remaining segments)
 * - `steps`   → {@link StepReference} (slug = second segment, path = rest)
 * - `state`   → {@link StateReference} (key = remaining segments)
 * - `item`    → {@link ItemReference} (path = remaining segments)
 * - `now`     → {@link NowReference}; the span truncates to `@now`
 * - `skill`   → {@link SkillReference} (slug = remaining segments)
 * - anything else → {@link ConnectionReference}; the span is truncated to
 *   the first segment (`@linear.issues` yields connection "linear" spanning
 *   only "@linear")
 *
 * Purely lexical: matches inside code fences/inline code too, and does NOT
 * validate that referenced steps/connections/skills/fields exist — that is
 * the compiler's (agent publish), workflow validator's (workflow publish),
 * and editor validation's (draft) job.
 */
export function parseReferences(markdown: string): ParsedReference[] {
  const refs: ParsedReference[] = [];
  for (const match of markdown.matchAll(REFERENCE_PATTERN)) {
    const dottedName = match[1];
    if (dottedName === undefined) continue;
    const start = match.index ?? 0;
    const segments = dottedName.split(".");
    const head = segments[0] ?? "";
    const rest = segments.slice(1).join(".");
    const end = start + match[0].length;

    if (head === "trigger") {
      refs.push({ kind: "trigger", raw: match[0], path: rest, start, end });
    } else if (head === "steps") {
      refs.push({
        kind: "step",
        raw: match[0],
        slug: segments[1] ?? "",
        path: segments.slice(2).join("."),
        start,
        end,
      });
    } else if (head === "state") {
      refs.push({ kind: "state", raw: match[0], key: rest, start, end });
    } else if (head === "item") {
      refs.push({ kind: "item", raw: match[0], path: rest, start, end });
    } else if (head === "now") {
      const raw = "@now";
      refs.push({ kind: "now", raw, start, end: start + raw.length });
    } else if (head === "skill") {
      refs.push({ kind: "skill", raw: match[0], slug: rest, start, end });
    } else {
      const raw = `@${head}`;
      refs.push({
        kind: "connection",
        raw,
        name: head,
        start,
        end: start + raw.length,
      });
    }
  }
  return refs;
}

/** {@link parseReferences}, grouped by kind for validators/autocomplete. */
export function buildReferenceInventory(markdown: string): ReferenceInventory {
  const all = parseReferences(markdown);
  return {
    all,
    trigger: all.filter((ref) => ref.kind === "trigger"),
    steps: all.filter((ref) => ref.kind === "step"),
    state: all.filter((ref) => ref.kind === "state"),
    items: all.filter((ref) => ref.kind === "item"),
    now: all.filter((ref) => ref.kind === "now"),
    connections: all.filter((ref) => ref.kind === "connection"),
    skills: all.filter((ref) => ref.kind === "skill"),
  };
}

// ── The full workflow config ────────────────────────────────────────────────

/** The one supported config shape. Kept as a literal for future evolution. */
export const WORKFLOW_CONFIG_VERSION = 2;

/**
 * Overlap policy for trigger dispatch: `skip` (default) refuses to start a
 * run while another run of the workflow is live — protecting cursor
 * semantics against a slow run overlapping the next window; `allow` runs
 * them concurrently.
 */
export const workflowOverlapSchema = z.enum(["skip", "allow"]);
export type WorkflowOverlapPolicy = z.infer<typeof workflowOverlapSchema>;

/**
 * Explicit end-of-run delivery. Pipelines have no well-defined "final
 * assistant message", so nothing is delivered unless configured: the
 * template renders against the final run scope (pipeline-template.ts) and
 * posts through the DeliveryService.
 */
export const workflowOnCompleteSchema = z.object({
  slackReply: z
    .object({ template: z.object({ markdown: z.string().default("") }) })
    .optional(),
});
export type WorkflowOnComplete = z.infer<typeof workflowOnCompleteSchema>;

export const workflowConfigSchema = z
  .object({
    version: z.literal(WORKFLOW_CONFIG_VERSION),
    trigger: triggerConfigSchema,
    /** The pipeline. Empty is a valid DRAFT; publish requires ≥1 step. */
    steps: z.array(pipelineStepSchema).default([]),
    onComplete: workflowOnCompleteSchema.optional(),
    overlap: workflowOverlapSchema.default("skip"),
  })
  .superRefine((config, ctx) => {
    // Tree integrity — shape-level like the trigger schemas' duplicate-key
    // checks: ids/slugs are addressing handles, and a duplicate corrupts
    // `@steps.<slug>` refs and the run_steps claim keys no matter how
    // unfinished the draft is. Empty slugs stay legal (draft-lenient);
    // publish requires them non-empty.
    const seenIds = new Set<string>();
    const seenSlugs = new Set<string>();
    for (const entry of walkSteps(config.steps)) {
      const { step, ancestors, configPath } = entry;
      if (seenIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", ...configPath, "id"],
          message: `duplicate step id "${step.id}"`,
        });
      }
      seenIds.add(step.id);
      if (step.slug.length > 0) {
        if (seenSlugs.has(step.slug)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", ...configPath, "slug"],
            message: `duplicate step slug "${step.slug}"`,
          });
        }
        seenSlugs.add(step.slug);
      }
      if (
        step.kind === "for_each" &&
        ancestors.some((ancestor) => ancestor.kind === "for_each")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", ...configPath],
          message: "for_each steps cannot nest inside another for_each",
        });
      }
    }
  });

/** Parsed (defaults applied) config — what publish/dispatch consume. */
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

/** Pre-parse shape (defaults still optional) — what API bodies may send. */
export type WorkflowConfigInput = z.input<typeof workflowConfigSchema>;
