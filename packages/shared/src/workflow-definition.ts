/**
 * WorkflowDefinition — the draft pillar config (TRIGGER · CONTEXT · AGENT ·
 * INSTRUCTIONS) stored on `workflows.draft` and snapshotted immutably into
 * `workflow_versions.config` at publish (INITIAL-SPEC.md §1/§9, docs/PLAN.md
 * Phase 1). This is the input to `packages/compiler`'s pure
 * `compile(WorkflowDefinition, versions)`.
 *
 * Draft-lenient by design: a draft may be incomplete in ways the compiler
 * rejects at publish (empty instructions, unresolved @references, model not
 * allowlisted, run_as user no longer a member, …). This schema guards SHAPE,
 * not publishability.
 *
 * Enum values here mirror packages/db pgEnums (`model_preset_slug`,
 * `reasoning_effort`, `trigger_type`) — keep them in lockstep.
 */
import { z } from "zod";

// ── TRIGGER pillar ──────────────────────────────────────────────────────────

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
 * check — eve's schedule compiler is the real validator. Schedules fire only
 * under `eve start` (PLAN correction 9), and compile to `agent/schedules/*`
 * rather than a dispatcher channel.
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

// ── CONTEXT pillar ──────────────────────────────────────────────────────────

const uuidArray = (what: string) =>
  z
    .array(z.uuid())
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate ${what} ids`,
        });
      }
    })
    .default([]);

/**
 * References into workspace/user context resources. Ids point at
 * `mcp_connections` / `skills` rows; the control plane resolves them to
 * concrete connection/skill definitions before compiling.
 */
export const contextConfigSchema = z.object({
  mcpConnectionIds: uuidArray("MCP connection"),
  skillIds: uuidArray("skill"),
});

export type ContextConfig = z.infer<typeof contextConfigSchema>;

// ── AGENT pillar ────────────────────────────────────────────────────────────

/** Mirrors pgEnum `model_preset_slug` (spec §7). */
export const modelPresetSlugSchema = z.enum(["powerful", "balanced", "quick"]);
export type ModelPresetSlug = z.infer<typeof modelPresetSlugSchema>;

/** Mirrors pgEnum `reasoning_effort`. */
export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * Agent pillar: which agent preset runs, with optional per-workflow
 * overrides. Compile-time model resolution order (spec §7):
 * `modelId override → modelPreset (override, else the preset's default) →
 * workspace preset mapping → provider+modelId → emit model: in agent.ts`,
 * allowlist-checked at compile AND dispatch.
 */
export const agentConfigSchema = z.object({
  /** `agents` row (agent preset: persona prompt + default preset/reasoning). */
  agentPresetId: z.uuid(),
  /** Overrides the preset's workspace model preset (powerful/balanced/quick). */
  modelPreset: modelPresetSlugSchema.optional(),
  /** Specific-model override; wins over modelPreset. Must be allowlisted. */
  modelId: z.string().min(1).optional(),
  /** Overrides the preset's reasoning effort. */
  reasoning: reasoningEffortSchema.optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ── INSTRUCTIONS pillar ─────────────────────────────────────────────────────

/**
 * Instructions markdown with inline `@references`. Empty is a valid DRAFT;
 * the compiler requires non-empty at publish (`instructions.md` is required
 * on the eve root agent).
 */
export const instructionsConfigSchema = z.object({
  markdown: z.string(),
});

export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;

// ── @reference parsing ──────────────────────────────────────────────────────

/**
 * `@trigger.<path>` — resolved at DISPATCH time against `TriggerEvent.data`
 * (dot path, e.g. `@trigger.customer.email` → `data.customer.email`).
 * A bare `@trigger` parses with `path: ""` so validators can flag it.
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
 * `@<connection>` — resolved at COMPILE time to literal text (+ description)
 * for an MCP connection in the workflow's context pillar.
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
 * `@skill.<slug>` — resolved at COMPILE time to literal text for an authored
 * skill. A bare `@skill` parses with `slug: ""` so validators can flag it.
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
  | ConnectionReference
  | SkillReference;

/** Parsed `@reference` inventory of an instructions document, grouped by kind. */
export interface ReferenceInventory {
  /** Every reference in document order. */
  all: ParsedReference[];
  trigger: TriggerReference[];
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
 * Extract every `@reference` from instructions markdown, in document order.
 *
 * Classification (first segment):
 * - `trigger` → {@link TriggerReference} (path = remaining segments)
 * - `skill`   → {@link SkillReference} (slug = remaining segments)
 * - anything else → {@link ConnectionReference}; the span is truncated to
 *   the first segment (`@linear.issues` yields connection "linear" spanning
 *   only "@linear")
 *
 * Purely lexical: matches inside code fences/inline code too, and does NOT
 * validate that referenced connections/skills/fields exist — that is the
 * compiler's (publish) and builder validation's (draft) job.
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

    if (head === "trigger") {
      refs.push({
        kind: "trigger",
        raw: match[0],
        path: rest,
        start,
        end: start + match[0].length,
      });
    } else if (head === "skill") {
      refs.push({
        kind: "skill",
        raw: match[0],
        slug: rest,
        start,
        end: start + match[0].length,
      });
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
    connections: all.filter((ref) => ref.kind === "connection"),
    skills: all.filter((ref) => ref.kind === "skill"),
  };
}

// ── The full four-pillar definition ─────────────────────────────────────────

export const workflowDefinitionSchema = z.object({
  trigger: triggerConfigSchema,
  context: contextConfigSchema,
  agent: agentConfigSchema,
  instructions: instructionsConfigSchema,
});

/** Parsed (defaults applied) definition — what the compiler consumes. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Pre-parse shape (defaults still optional) — what API bodies may send. */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
