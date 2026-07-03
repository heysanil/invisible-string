/**
 * Typed compile failures. The control plane maps these onto publish-time API
 * errors (build never starts when compile throws), and the builder UI mirrors
 * the same checks client-side as draft warnings.
 *
 * Model resolution and allowlist validation happen in the CONTROL PLANE
 * before compile — compile() only re-checks INTERNAL consistency of the
 * input it was handed (e.g. a resolved connection missing for a referenced
 * id) and never performs I/O.
 */

export type CompileErrorCode =
  /** The WorkflowDefinition failed schema validation. */
  | "INVALID_DEFINITION"
  /** A dependency field is malformed (model, preset, slugs, …). */
  | "INVALID_DEPS"
  /** Instructions are empty — valid as a draft, unpublishable. */
  | "EMPTY_INSTRUCTIONS"
  /** deps.agentPreset does not match definition.agent.agentPresetId. */
  | "AGENT_PRESET_MISMATCH"
  /** definition.agent.modelId is set and differs from deps.resolvedModel. */
  | "MODEL_MISMATCH"
  /** A definition.context.mcpConnectionIds entry has no resolved connection. */
  | "MISSING_CONNECTION"
  /** deps.connections contains an entry the definition does not reference. */
  | "UNEXPECTED_CONNECTION"
  /** A definition.context.skillIds entry has no resolved skill. */
  | "MISSING_SKILL"
  /** deps.skills contains an entry the definition does not reference. */
  | "UNEXPECTED_SKILL"
  /** Two resolved connections or skills share a slug. */
  | "DUPLICATE_SLUG"
  /** A slug fails the [a-z0-9-] grammar (or starts/ends with "-"). */
  | "INVALID_SLUG"
  /** A connection header name or env-var name is malformed. */
  | "INVALID_HEADER"
  /** tools filter must carry exactly one non-empty allow OR block list. */
  | "INVALID_TOOL_FILTER"
  /** Custom approval policy has no rules, empty/duplicate tool names, … */
  | "INVALID_APPROVAL"
  /** A packaged-skill file path escapes the skill directory or is empty. */
  | "INVALID_SKILL_FILE"
  /** An @reference names an unknown connection/skill, or is bare. */
  | "UNRESOLVED_REFERENCE"
  /** @trigger.* used with a trigger type that carries no dispatch data. */
  | "TRIGGER_REF_NOT_ALLOWED"
  /** @trigger.<key> does not match any form field key. */
  | "TRIGGER_REF_UNKNOWN_FIELD";

export class CompileError extends Error {
  readonly code: CompileErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CompileErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CompileError";
    this.code = code;
    this.details = details;
  }
}
