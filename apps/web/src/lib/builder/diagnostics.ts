/**
 * Workflow editor diagnostics: a client-side mirror of the server's workflow
 * validator plus the distributor that routes server findings (the
 * `diagnostics` array riding GET/PATCH workflow responses) onto the three
 * editor sections.
 *
 * Severity semantics (mirrors `workflowDiagnosticSchema`):
 * - "error"   — blocks publish (the publish endpoint would reject).
 * - "warning" — legal draft, but worth surfacing (e.g. empty instructions
 *   are saveable yet unpublishable; an agent republish stranding a
 *   `@connection` ref degrades gracefully at dispatch).
 */
import {
  triggerConfigSchema,
  type AgentSummaryDto,
  type WorkflowConfig,
  type WorkflowDiagnostics,
} from "@invisible-string/shared";

import type { WorkflowSection } from "./model";
import { unresolvedReferences, type ReferenceSources } from "./references";

export type DiagnosticSeverity = "error" | "warning";

export interface BuilderDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
}

export interface BuilderDiagnostics {
  sections: Record<WorkflowSection, BuilderDiagnostic[]>;
  /** Issues that belong to the whole draft, not one section. */
  general: BuilderDiagnostic[];
}

export function emptyDiagnostics(): BuilderDiagnostics {
  return {
    sections: { trigger: [], agent: [], instructions: [] },
    general: [],
  };
}

export function mergeDiagnostics(
  ...sets: BuilderDiagnostics[]
): BuilderDiagnostics {
  const merged = emptyDiagnostics();
  for (const set of sets) {
    for (const section of Object.keys(merged.sections) as WorkflowSection[]) {
      merged.sections[section].push(...set.sections[section]);
    }
    merged.general.push(...set.general);
  }
  return merged;
}

export function countIssues(diagnostics: BuilderDiagnostics): number {
  return (
    diagnostics.general.length +
    Object.values(diagnostics.sections).reduce(
      (sum, list) => sum + list.length,
      0,
    )
  );
}

export function sectionIssueCount(
  diagnostics: BuilderDiagnostics,
  section: WorkflowSection,
): number {
  return diagnostics.sections[section].length;
}

// ── Local (client-mirror) checks ────────────────────────────────────────────

export interface LocalCheckInputs {
  definition: WorkflowConfig;
  /** Reference sources resolved from the SELECTED AGENT's context. */
  sources: ReferenceSources;
  /** Workspace agent inventory; null while still loading (skip the check). */
  agents: readonly AgentSummaryDto[] | null;
  /**
   * False while the selected agent's context is still resolving —
   * `@connection`/`@skill` reference checks are skipped so a slow agent
   * fetch never flashes false "not attached" warnings (`@trigger` refs
   * validate regardless: they depend only on the local trigger config).
   */
  contextResolved: boolean;
}

/**
 * Instant validation while typing — the server validator confirms on save,
 * but section cards must not wait a network round-trip to flag a removed
 * form field or an empty instructions doc.
 */
export function localDiagnostics(inputs: LocalCheckInputs): BuilderDiagnostics {
  const { definition, sources, agents, contextResolved } = inputs;
  const diagnostics = emptyDiagnostics();

  // TRIGGER — shape per the shared schema (dedup zod noise into one line each).
  const trigger = triggerConfigSchema.safeParse(definition.trigger);
  if (!trigger.success) {
    const seen = new Set<string>();
    for (const issue of trigger.error.issues) {
      const message = issue.message;
      if (seen.has(message)) continue;
      seen.add(message);
      diagnostics.sections.trigger.push({ severity: "error", message });
    }
  }

  // AGENT — publish requires an existing, PUBLISHED agent.
  if (definition.agentId === null) {
    diagnostics.sections.agent.push({
      severity: "error",
      message: "Choose an agent to do the work.",
    });
  } else if (agents !== null) {
    const agent = agents.find((a) => a.id === definition.agentId);
    if (!agent) {
      diagnostics.sections.agent.push({
        severity: "error",
        message: "The selected agent no longer exists — choose another.",
      });
    } else if (agent.publishedVersionId === null) {
      diagnostics.sections.agent.push({
        severity: "error",
        message: `"${agent.name}" isn't published yet — publish it in Agents first.`,
      });
    }
  }

  // INSTRUCTIONS — empty is a saveable draft but unpublishable; unresolved
  // @references mirror the server validator's publish-time errors.
  if (definition.instructions.markdown.trim().length === 0) {
    diagnostics.sections.instructions.push({
      severity: "warning",
      message: "Instructions are empty — required to publish.",
    });
  } else {
    const seen = new Set<string>();
    for (const problem of unresolvedReferences(
      definition.instructions.markdown,
      sources,
    )) {
      // Connection/skill resolvability is unknowable until the selected
      // agent's context has loaded — only trigger refs are judged locally.
      if (!contextResolved && problem.ref.kind !== "trigger") continue;
      if (seen.has(problem.ref.raw)) continue;
      seen.add(problem.ref.raw);
      diagnostics.sections.instructions.push({
        severity: "warning",
        message: `${problem.ref.raw} — ${problem.reason}`,
      });
    }
  }

  return diagnostics;
}

// ── Server-finding distribution ─────────────────────────────────────────────

/**
 * Map a server diagnostic's dot path (rooted at the config key, e.g.
 * "agentId" / "instructions.markdown" / "trigger.fields.0.key") onto a
 * section; unrooted paths land in the general bucket.
 */
function sectionFromPath(path: string): WorkflowSection | null {
  const head = path.split(".")[0] ?? "";
  if (head === "trigger") return "trigger";
  if (head === "agentId" || head === "agent") return "agent";
  if (head === "instructions") return "instructions";
  return null;
}

/**
 * Route the shared-validator findings that ride workflow GET/PATCH responses
 * ({@link WorkflowDiagnostics}) onto the section cards.
 */
export function serverDiagnostics(
  findings: WorkflowDiagnostics,
): BuilderDiagnostics {
  const diagnostics = emptyDiagnostics();
  for (const finding of findings) {
    const entry: BuilderDiagnostic = {
      severity: finding.severity,
      message: finding.message,
    };
    const section = sectionFromPath(finding.path);
    if (section === null) diagnostics.general.push(entry);
    else diagnostics.sections[section].push(entry);
  }
  return diagnostics;
}
