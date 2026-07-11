/**
 * Agent editor diagnostics: a client-side mirror of the compiler's instant
 * draft checks plus the distributor that routes dry-run-compile errors (the
 * `{ok:false, error}` payload of `POST .../agents/:agentId/dry-run-compile`,
 * also carried on draft PATCH responses) onto the editor's four sections.
 *
 * Severity semantics:
 * - "error"   — blocks publish (the compiler/publish endpoint would reject).
 * - "warning" — legal draft, but worth surfacing (e.g. an empty persona is
 *   saveable yet unpublishable).
 */
import type { ApiErrorInfo, AgentDefinition } from "@invisible-string/shared";

import type { AgentSection } from "./model";

export type AgentDiagnosticSeverity = "error" | "warning";

export interface AgentDiagnostic {
  severity: AgentDiagnosticSeverity;
  message: string;
}

export interface AgentDiagnostics {
  sections: Record<AgentSection, AgentDiagnostic[]>;
  /** Issues that belong to the whole draft, not one section. */
  general: AgentDiagnostic[];
}

export function emptyAgentDiagnostics(): AgentDiagnostics {
  return {
    sections: { persona: [], model: [], context: [], access: [] },
    general: [],
  };
}

export function mergeAgentDiagnostics(
  ...sets: AgentDiagnostics[]
): AgentDiagnostics {
  const merged = emptyAgentDiagnostics();
  for (const set of sets) {
    for (const section of Object.keys(merged.sections) as AgentSection[]) {
      merged.sections[section].push(...set.sections[section]);
    }
    merged.general.push(...set.general);
  }
  return merged;
}

export function countAgentIssues(diagnostics: AgentDiagnostics): number {
  return (
    diagnostics.general.length +
    Object.values(diagnostics.sections).reduce(
      (sum, list) => sum + list.length,
      0,
    )
  );
}

export function sectionIssueCount(
  diagnostics: AgentDiagnostics,
  section: AgentSection,
): number {
  return diagnostics.sections[section].length;
}

export function hasBlockingAgentIssues(diagnostics: AgentDiagnostics): boolean {
  return (
    diagnostics.general.some((d) => d.severity === "error") ||
    Object.values(diagnostics.sections).some((list) =>
      list.some((d) => d.severity === "error"),
    )
  );
}

// ── Local (client-mirror) checks ────────────────────────────────────────────

export interface LocalAgentCheckInputs {
  definition: AgentDefinition;
  /** Enabled allowlist model ids; null while still loading (skip the check). */
  allowedModelIds: readonly string[] | null;
}

/**
 * Instant validation while typing — the dry run confirms on save, but the
 * rail badges must not wait a network round-trip to flag an empty persona or
 * an off-allowlist model override.
 */
export function localAgentDiagnostics(
  inputs: LocalAgentCheckInputs,
): AgentDiagnostics {
  const { definition, allowedModelIds } = inputs;
  const diagnostics = emptyAgentDiagnostics();

  // PERSONA — empty is a saveable draft but unpublishable.
  if (definition.persona.trim().length === 0) {
    diagnostics.sections.persona.push({
      severity: "warning",
      message: "Persona is empty — required to publish.",
    });
  }

  // MODEL — a specific-model override must be allowlisted.
  if (
    definition.model.modelId !== undefined &&
    allowedModelIds !== null &&
    !allowedModelIds.includes(definition.model.modelId)
  ) {
    diagnostics.sections.model.push({
      severity: "error",
      message: `Model "${definition.model.modelId}" is not on the workspace allowlist.`,
    });
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

function sectionFromPathHead(
  head: string | number | undefined,
): AgentSection | null {
  if (head === "persona" || head === "model" || head === "context") return head;
  if (head === "runAsUserId") return "access";
  return null;
}

/**
 * Compiler issue paths look like `connections.<name>.…` / `skills.<name>` /
 * `persona`, and pathless messages are prefixed with the CompileErrorCode
 * (see apps/control-plane/src/build/compiler-adapter.ts).
 */
function sectionFromCompileIssue(issue: WireIssue): AgentSection | null {
  const path = typeof issue.path === "string" ? issue.path : "";
  if (path.startsWith("connections.") || path.startsWith("skills.")) {
    return "context";
  }
  if (path === "persona" || path.startsWith("persona.")) return "persona";
  const code = issue.message.split(":")[0] ?? "";
  switch (code) {
    case "EMPTY_PERSONA":
    case "EMPTY_INSTRUCTIONS":
    case "UNRESOLVED_REFERENCE":
    case "TRIGGER_REF_NOT_ALLOWED":
    case "TRIGGER_REF_UNKNOWN_FIELD":
      return "persona";
    case "MODEL_MISMATCH":
      return "model";
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
  diagnostics: AgentDiagnostics,
  section: AgentSection | null,
  message: string,
): void {
  const diagnostic: AgentDiagnostic = { severity: "error", message };
  if (section === null) diagnostics.general.push(diagnostic);
  else diagnostics.sections[section].push(diagnostic);
}

/**
 * Route a dry-run-compile failure (`{ok:false, error}` payload — codes from
 * apps/control-plane/src/runtime/errors.ts) onto the section cards.
 */
export function dryRunAgentDiagnostics(error: ApiErrorInfo): AgentDiagnostics {
  const diagnostics = emptyAgentDiagnostics();
  const details = Array.isArray(error.details) ? error.details : [];

  switch (error.code) {
    case "draft_invalid": {
      // details = zod issues with array paths rooted at the definition key.
      let routed = false;
      for (const raw of details) {
        if (!isWireIssue(raw)) continue;
        const path = Array.isArray(raw.path) ? raw.path : [];
        push(
          diagnostics,
          sectionFromPathHead(path[0]),
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
        push(diagnostics, sectionFromCompileIssue(raw), raw.message);
        routed = true;
      }
      if (!routed) push(diagnostics, null, error.message);
      return diagnostics;
    }

    case "model_preset_not_found":
    case "model_not_allowlisted":
      push(diagnostics, "model", error.message);
      return diagnostics;

    case "context_resource_not_found":
      push(diagnostics, "context", error.message);
      return diagnostics;

    default:
      // Run-as problems (member left the workspace, …) belong to Access.
      push(
        diagnostics,
        error.code.includes("run_as") ? "access" : null,
        error.message,
      );
      return diagnostics;
  }
}
