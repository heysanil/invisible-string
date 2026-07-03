/**
 * Builder diagnostics: a client-side mirror of the compiler's draft checks
 * plus the distributor that routes dry-run-compile errors (the payload of
 * `POST .../versions/dry-run-compile` when `ok: false`) onto the four pillar
 * cards.
 *
 * Severity semantics:
 * - "error"   — blocks publish (the compiler/publish endpoint would reject).
 * - "warning" — legal draft, but worth surfacing (e.g. empty instructions
 *   are saveable yet unpublishable).
 */
import {
  triggerConfigSchema,
  type ApiErrorInfo,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import type { Pillar } from "./model";
import { unresolvedReferences, type ReferenceSources } from "./references";

export type DiagnosticSeverity = "error" | "warning";

export interface PillarDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
}

export interface BuilderDiagnostics {
  pillars: Record<Pillar, PillarDiagnostic[]>;
  /** Issues that belong to the whole draft, not one pillar. */
  general: PillarDiagnostic[];
}

export function emptyDiagnostics(): BuilderDiagnostics {
  return {
    pillars: { trigger: [], context: [], agent: [], instructions: [] },
    general: [],
  };
}

export function mergeDiagnostics(
  ...sets: BuilderDiagnostics[]
): BuilderDiagnostics {
  const merged = emptyDiagnostics();
  for (const set of sets) {
    for (const pillar of Object.keys(merged.pillars) as Pillar[]) {
      merged.pillars[pillar].push(...set.pillars[pillar]);
    }
    merged.general.push(...set.general);
  }
  return merged;
}

export function countIssues(diagnostics: BuilderDiagnostics): number {
  return (
    diagnostics.general.length +
    Object.values(diagnostics.pillars).reduce(
      (sum, list) => sum + list.length,
      0,
    )
  );
}

export function pillarIssueCount(
  diagnostics: BuilderDiagnostics,
  pillar: Pillar,
): number {
  return diagnostics.pillars[pillar].length;
}

// ── Local (client-mirror) checks ────────────────────────────────────────────

export interface LocalCheckInputs {
  definition: WorkflowDefinition;
  /** Reference sources resolved from the attached context resources. */
  sources: ReferenceSources;
  /** Known agent preset ids; null while still loading (skip the check). */
  agentPresetIds: readonly string[] | null;
  /** Enabled allowlist model ids; null while still loading (skip the check). */
  allowedModelIds: readonly string[] | null;
}

/**
 * Instant validation while typing — the dry-run endpoint confirms on save,
 * but pillar cards must not wait a network round-trip to flag a removed
 * form field or an empty instructions doc.
 */
export function localDiagnostics(inputs: LocalCheckInputs): BuilderDiagnostics {
  const { definition, sources, agentPresetIds, allowedModelIds } = inputs;
  const diagnostics = emptyDiagnostics();

  // TRIGGER — shape per the shared schema (dedup zod noise into one line each).
  const trigger = triggerConfigSchema.safeParse(definition.trigger);
  if (!trigger.success) {
    const seen = new Set<string>();
    for (const issue of trigger.error.issues) {
      const message = issue.message;
      if (seen.has(message)) continue;
      seen.add(message);
      diagnostics.pillars.trigger.push({ severity: "error", message });
    }
  }

  // AGENT — preset must exist; a model override must be allowlisted.
  if (definition.agent.agentPresetId === "") {
    diagnostics.pillars.agent.push({
      severity: "error",
      message: "Choose an agent preset.",
    });
  } else if (
    agentPresetIds !== null &&
    !agentPresetIds.includes(definition.agent.agentPresetId)
  ) {
    diagnostics.pillars.agent.push({
      severity: "error",
      message: "The selected agent preset no longer exists.",
    });
  }
  if (
    definition.agent.modelId !== undefined &&
    allowedModelIds !== null &&
    !allowedModelIds.includes(definition.agent.modelId)
  ) {
    diagnostics.pillars.agent.push({
      severity: "error",
      message: `Model "${definition.agent.modelId}" is not on the workspace allowlist.`,
    });
  }

  // INSTRUCTIONS — empty is a saveable draft but unpublishable; unresolved
  // @references mirror the compiler's publish-time errors.
  if (definition.instructions.markdown.trim().length === 0) {
    diagnostics.pillars.instructions.push({
      severity: "warning",
      message: "Instructions are empty — required to publish.",
    });
  } else {
    const seen = new Set<string>();
    for (const problem of unresolvedReferences(
      definition.instructions.markdown,
      sources,
    )) {
      if (seen.has(problem.ref.raw)) continue;
      seen.add(problem.ref.raw);
      diagnostics.pillars.instructions.push({
        severity: "warning",
        message: `${problem.ref.raw} — ${problem.reason}`,
      });
    }
  }

  return diagnostics;
}

// ── Dry-run error distribution ──────────────────────────────────────────────

/** Serialized issue shapes carried in dry-run/publish 422 `details`. */
interface WireIssue {
  message: string;
  /** zod path array (draft_invalid) or compiler dotted path (compile_failed). */
  path?: ReadonlyArray<string | number> | string;
}

function isWireIssue(value: unknown): value is WireIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function pillarFromPathHead(head: string | number | undefined): Pillar | null {
  if (
    head === "trigger" ||
    head === "context" ||
    head === "agent" ||
    head === "instructions"
  ) {
    return head;
  }
  return null;
}

/**
 * Compiler issue paths look like `connections.<name>.…` / `skills.<name>` and
 * pathless messages are prefixed with the CompileErrorCode (see
 * apps/control-plane/src/build/compiler-adapter.ts).
 */
function pillarFromCompileIssue(issue: WireIssue): Pillar | null {
  const path = typeof issue.path === "string" ? issue.path : "";
  if (path.startsWith("connections.") || path.startsWith("skills.")) {
    return "context";
  }
  const code = issue.message.split(":")[0] ?? "";
  switch (code) {
    case "EMPTY_INSTRUCTIONS":
    case "UNRESOLVED_REFERENCE":
    case "TRIGGER_REF_NOT_ALLOWED":
    case "TRIGGER_REF_UNKNOWN_FIELD":
      return "instructions";
    case "AGENT_PRESET_MISMATCH":
    case "MODEL_MISMATCH":
      return "agent";
    case "MISSING_CONNECTION":
    case "UNEXPECTED_CONNECTION":
    case "MISSING_SKILL":
    case "UNEXPECTED_SKILL":
    case "DUPLICATE_SLUG":
    case "INVALID_SLUG":
    case "INVALID_HEADER":
    case "INVALID_TOOL_FILTER":
    case "INVALID_APPROVAL":
    case "INVALID_SKILL_FILE":
      return "context";
    default:
      return null;
  }
}

function push(
  diagnostics: BuilderDiagnostics,
  pillar: Pillar | null,
  message: string,
): void {
  const diagnostic: PillarDiagnostic = { severity: "error", message };
  if (pillar === null) diagnostics.general.push(diagnostic);
  else diagnostics.pillars[pillar].push(diagnostic);
}

/**
 * Route a dry-run-compile failure (`{ok:false, error}` payload — codes from
 * apps/control-plane/src/runtime/errors.ts) onto the pillar cards.
 */
export function dryRunDiagnostics(error: ApiErrorInfo): BuilderDiagnostics {
  const diagnostics = emptyDiagnostics();
  const details = Array.isArray(error.details) ? error.details : [];

  switch (error.code) {
    case "draft_invalid": {
      // details = zod issues with array paths rooted at the pillar key.
      let routed = false;
      for (const raw of details) {
        if (!isWireIssue(raw)) continue;
        const path = Array.isArray(raw.path) ? raw.path : [];
        push(
          diagnostics,
          pillarFromPathHead(path[0]),
          path.length > 0 ? `${path.join(".")}: ${raw.message}` : raw.message,
        );
        routed = true;
      }
      if (!routed) push(diagnostics, null, error.message);
      return diagnostics;
    }

    case "compile_failed": {
      // details = CompileIssue[] ({path?: string, message}).
      let routed = false;
      for (const raw of details) {
        if (!isWireIssue(raw)) continue;
        push(diagnostics, pillarFromCompileIssue(raw), raw.message);
        routed = true;
      }
      if (!routed) push(diagnostics, null, error.message);
      return diagnostics;
    }

    case "agent_preset_not_found":
    case "model_preset_not_found":
    case "model_not_allowlisted":
      push(diagnostics, "agent", error.message);
      return diagnostics;

    case "context_resource_not_found":
      push(diagnostics, "context", error.message);
      return diagnostics;

    default:
      push(diagnostics, null, error.message);
      return diagnostics;
  }
}
