/**
 * Pipeline editor diagnostics: a client-side mirror of the server's workflow
 * validator plus the distributor that routes findings (local zod issues and
 * the `diagnostics` array riding GET/PATCH workflow responses) onto the
 * trigger card, the step cards, or the general bucket.
 *
 * Shape: `{trigger, byStep, general}` — server paths are rooted at the config
 * key (`trigger.…`, `steps.2.branches.1.steps.0.args.title`), so `steps.*`
 * paths are resolved to STEP IDS through the live draft: the deepest step the
 * path reaches owns the finding, and a path the draft can no longer resolve
 * (the user deleted the step since saving) falls into `general`.
 *
 * Severity semantics (mirrors `workflowDiagnosticSchema`):
 * - "error"   — blocks publish (the publish endpoint would reject).
 * - "warning" — legal draft, but worth surfacing (e.g. an empty prompt is
 *   saveable yet unpublishable).
 */
import {
  parseReferences,
  walkSteps,
  workflowConfigSchema,
  type AgentSummaryDto,
  type ConnectionDto,
  type PipelineCondition,
  type PipelineStep,
  type TemplateValue,
  type WorkflowConfig,
  type WorkflowDiagnostics,
} from "@invisible-string/shared";

import {
  referenceProblem,
  referenceSourcesForStep,
  scopeRefProblem,
  type ReferenceSources,
} from "./references";

export type DiagnosticSeverity = "error" | "warning";

export interface BuilderDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
}

export interface BuilderDiagnostics {
  /** Issues on the trigger card. */
  trigger: BuilderDiagnostic[];
  /** Issues keyed by the owning step's id (the step card renders them). */
  byStep: Record<string, BuilderDiagnostic[]>;
  /** Issues that belong to the whole draft, not one card. */
  general: BuilderDiagnostic[];
}

export function emptyDiagnostics(): BuilderDiagnostics {
  return { trigger: [], byStep: {}, general: [] };
}

function push(
  diagnostics: BuilderDiagnostics,
  stepId: string,
  entry: BuilderDiagnostic,
): void {
  (diagnostics.byStep[stepId] ??= []).push(entry);
}

export function mergeDiagnostics(
  ...sets: BuilderDiagnostics[]
): BuilderDiagnostics {
  const merged = emptyDiagnostics();
  for (const set of sets) {
    merged.trigger.push(...set.trigger);
    merged.general.push(...set.general);
    for (const [stepId, entries] of Object.entries(set.byStep)) {
      (merged.byStep[stepId] ??= []).push(...entries);
    }
  }
  return merged;
}

export function countIssues(diagnostics: BuilderDiagnostics): number {
  return (
    diagnostics.trigger.length +
    diagnostics.general.length +
    Object.values(diagnostics.byStep).reduce(
      (sum, list) => sum + list.length,
      0,
    )
  );
}

export function triggerIssueCount(diagnostics: BuilderDiagnostics): number {
  return diagnostics.trigger.length;
}

export function stepIssueCount(
  diagnostics: BuilderDiagnostics,
  stepId: string,
): number {
  return diagnostics.byStep[stepId]?.length ?? 0;
}

/** Whether anything blocks publish (errors only; warnings never do). */
export function hasBlockingIssue(diagnostics: BuilderDiagnostics): boolean {
  const blocking = (entry: BuilderDiagnostic): boolean =>
    entry.severity === "error";
  return (
    diagnostics.trigger.some(blocking) ||
    diagnostics.general.some(blocking) ||
    Object.values(diagnostics.byStep).some((list) => list.some(blocking))
  );
}

// ── Path → card routing ─────────────────────────────────────────────────────

/**
 * Resolve a `steps.…` path (already split; the leading "steps" removed) to
 * the DEEPEST step it reaches in the live draft — e.g.
 * `["2", "branches", "1", "steps", "0", "args", "title"]` walks into the
 * nested step and the trailing `args.title` stays within it. Null when the
 * draft cannot resolve the path (stale index after an edit).
 */
function stepIdForPath(
  segments: readonly (string | number)[],
  steps: readonly PipelineStep[],
): string | null {
  let list: readonly PipelineStep[] = steps;
  let owner: string | null = null;
  let cursor = 0;

  while (cursor < segments.length) {
    const index = Number(segments[cursor]);
    const step = Number.isInteger(index) ? list[index] : undefined;
    if (step === undefined) return owner;
    owner = step.id;
    cursor += 1;

    const next = segments[cursor];
    if (step.kind === "for_each" && next === "steps") {
      list = step.steps;
      cursor += 1;
      continue;
    }
    if (step.kind === "branch" && next === "branches") {
      const lane = step.branches[Number(segments[cursor + 1])];
      if (lane === undefined || segments[cursor + 2] !== "steps") return owner;
      list = lane.steps;
      cursor += 3;
      continue;
    }
    if (step.kind === "branch" && next === "else" && step.else !== undefined) {
      list = step.else;
      cursor += 1;
      continue;
    }
    // The rest of the path addresses fields WITHIN this step.
    return owner;
  }
  return owner;
}

function routeByPath(
  diagnostics: BuilderDiagnostics,
  segments: readonly (string | number)[],
  entry: BuilderDiagnostic,
  steps: readonly PipelineStep[],
): void {
  const head = segments[0];
  if (head === "trigger") {
    diagnostics.trigger.push(entry);
    return;
  }
  if (head === "steps" && segments.length > 1) {
    const stepId = stepIdForPath(segments.slice(1), steps);
    if (stepId !== null) {
      push(diagnostics, stepId, entry);
      return;
    }
  }
  diagnostics.general.push(entry);
}

// ── Local (client-mirror) checks ────────────────────────────────────────────

export interface LocalCheckInputs {
  definition: WorkflowConfig;
  /**
   * Merged workspace+user connection inventory; null while loading (tool
   * steps' connection-existence checks skip — never flash "unknown" on a
   * slow fetch).
   */
  connections: readonly Pick<ConnectionDto, "id" | "name">[] | null;
  /** Workspace agent inventory; null while loading (agent checks skip). */
  agents: readonly AgentSummaryDto[] | null;
}

/** Every `$ref` scope path reachable from a template value, in order. */
function collectTemplateRefs(value: TemplateValue, into: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTemplateRefs(entry, into);
    return;
  }
  if ("$ref" in value && typeof value.$ref === "string" && Object.keys(value).length === 1) {
    into.push(value.$ref);
    return;
  }
  if ("$tpl" in value && typeof value.$tpl === "string" && Object.keys(value).length === 1) {
    return; // $tpl strings are markdown-checked by the caller.
  }
  for (const entry of Object.values(value)) collectTemplateRefs(entry, into);
}

/** Every `$tpl` template string reachable from a template value. */
function collectTemplateStrings(value: TemplateValue, into: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTemplateStrings(entry, into);
    return;
  }
  if ("$tpl" in value && typeof value.$tpl === "string" && Object.keys(value).length === 1) {
    into.push(value.$tpl);
    return;
  }
  for (const entry of Object.values(value)) collectTemplateStrings(entry, into);
}

/** Every `$ref` operand in a condition AST. */
function collectConditionRefs(condition: PipelineCondition, into: string[]): void {
  const operand = (value: unknown): void => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "$ref" in value &&
      typeof (value as { $ref: unknown }).$ref === "string"
    ) {
      into.push((value as { $ref: string }).$ref);
    }
  };
  if ("and" in condition) {
    for (const child of condition.and) collectConditionRefs(child, into);
  } else if ("or" in condition) {
    for (const child of condition.or) collectConditionRefs(child, into);
  } else if ("not" in condition) {
    collectConditionRefs(condition.not, into);
  } else if ("exists" in condition) {
    operand(condition.exists);
  } else if ("truthy" in condition) {
    operand(condition.truthy);
  } else if ("empty" in condition) {
    operand(condition.empty);
  } else {
    const pair = Object.values(condition)[0] as [unknown, unknown];
    operand(pair[0]);
    operand(pair[1]);
  }
}

/**
 * Flag the `@references` of one markdown surface against the step's sources.
 * Connection/skill refs are deliberately NOT judged here: they resolve
 * against the bound agent's published context, which this pure check does
 * not load — the server validator owns that verdict.
 */
function markdownRefIssues(
  markdown: string,
  sources: ReferenceSources,
  diagnostics: BuilderDiagnostics,
  stepId: string,
): void {
  const seen = new Set<string>();
  for (const ref of parseReferences(markdown)) {
    if (ref.kind === "connection" || ref.kind === "skill") continue;
    const reason = referenceProblem(ref, sources);
    if (reason === null || seen.has(ref.raw)) continue;
    seen.add(ref.raw);
    push(diagnostics, stepId, {
      severity: "warning",
      message: `${ref.raw} — ${reason}`,
    });
  }
}

/** Flag `$ref` scope paths (args, items, conditions, state writes). */
function scopeRefIssues(
  paths: readonly string[],
  sources: ReferenceSources,
  diagnostics: BuilderDiagnostics,
  stepId: string,
): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const reason = scopeRefProblem(path, sources);
    if (reason === null || seen.has(path)) continue;
    seen.add(path);
    push(diagnostics, stepId, { severity: "warning", message: reason });
  }
}

/**
 * Instant validation while typing — the server validator confirms on save,
 * but the cards must not wait a network round-trip to flag a removed
 * connection or an empty prompt.
 */
export function localDiagnostics(inputs: LocalCheckInputs): BuilderDiagnostics {
  const { definition, connections, agents } = inputs;
  const diagnostics = emptyDiagnostics();

  // Shape + tree integrity per the shared schema (dedup zod noise: one line
  // per distinct message per card).
  const parsed = workflowConfigSchema.safeParse(definition);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const key = `${String(issue.path[0] ?? "")}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routeByPath(
        diagnostics,
        issue.path as (string | number)[],
        { severity: "error", message: issue.message },
        definition.steps,
      );
    }
  }

  if (definition.steps.length === 0) {
    diagnostics.general.push({
      severity: "warning",
      message: "Add at least one step — required to publish.",
    });
  }

  for (const entry of walkSteps(definition.steps)) {
    const step = entry.step;
    const sources = referenceSourcesForStep(definition.steps, step.id, {
      trigger: definition.trigger,
      connections: [],
      skills: [],
    });

    if (step.slug === "") {
      push(diagnostics, step.id, {
        severity: "warning",
        message: "Give this step a slug — required to publish.",
      });
    }

    switch (step.kind) {
      case "tool": {
        if (step.connectionId === "") {
          push(diagnostics, step.id, {
            severity: "error",
            message: "Choose a connection for this tool call.",
          });
        } else if (
          connections !== null &&
          !connections.some((c) => c.id === step.connectionId)
        ) {
          push(diagnostics, step.id, {
            severity: "error",
            message: "The selected connection no longer exists — choose another.",
          });
        }
        if (step.tool === "") {
          push(diagnostics, step.id, {
            severity: "warning",
            message: "Pick a tool to call — required to publish.",
          });
        }
        const refs: string[] = [];
        const tpls: string[] = [];
        for (const value of Object.values(step.args)) {
          collectTemplateRefs(value, refs);
          collectTemplateStrings(value, tpls);
        }
        scopeRefIssues(refs, sources, diagnostics, step.id);
        for (const tpl of tpls) {
          markdownRefIssues(tpl, sources, diagnostics, step.id);
        }
        break;
      }

      case "infer": {
        if (step.prompt.markdown.trim().length === 0) {
          push(diagnostics, step.id, {
            severity: "warning",
            message: "The prompt is empty — required to publish.",
          });
        } else {
          markdownRefIssues(step.prompt.markdown, sources, diagnostics, step.id);
        }
        break;
      }

      case "agent": {
        if (step.agentId === null) {
          push(diagnostics, step.id, {
            severity: "error",
            message: "Choose an agent to do the work.",
          });
        } else if (agents !== null) {
          const agent = agents.find((a) => a.id === step.agentId);
          if (!agent) {
            push(diagnostics, step.id, {
              severity: "error",
              message: "The selected agent no longer exists — choose another.",
            });
          } else if (agent.publishedVersionId === null) {
            push(diagnostics, step.id, {
              severity: "error",
              message: `"${agent.name}" isn't published yet — publish it in Agents first.`,
            });
          }
        }
        if (step.session === "thread" && definition.trigger.type !== "slack") {
          push(diagnostics, step.id, {
            severity: "error",
            message: "Thread sessions require a Slack trigger.",
          });
        }
        if (step.session === "thread" && step.output !== undefined) {
          push(diagnostics, step.id, {
            severity: "error",
            message: "Thread sessions cannot declare an output schema.",
          });
        }
        if (step.instructions.markdown.trim().length === 0) {
          push(diagnostics, step.id, {
            severity: "warning",
            message: "Instructions are empty — required to publish.",
          });
        } else {
          markdownRefIssues(
            step.instructions.markdown,
            sources,
            diagnostics,
            step.id,
          );
        }
        break;
      }

      case "for_each":
        scopeRefIssues([step.items.$ref], sources, diagnostics, step.id);
        break;

      case "branch": {
        const refs: string[] = [];
        for (const lane of step.branches) collectConditionRefs(lane.when, refs);
        scopeRefIssues(refs, sources, diagnostics, step.id);
        break;
      }

      case "filter": {
        const refs: string[] = [];
        collectConditionRefs(step.where, refs);
        scopeRefIssues(refs, sources, diagnostics, step.id);
        break;
      }

      case "state": {
        const refs: string[] = [];
        const tpls: string[] = [];
        for (const value of Object.values(step.set)) {
          collectTemplateRefs(value, refs);
          collectTemplateStrings(value, tpls);
        }
        scopeRefIssues(refs, sources, diagnostics, step.id);
        for (const tpl of tpls) {
          markdownRefIssues(tpl, sources, diagnostics, step.id);
        }
        break;
      }
    }
  }

  return diagnostics;
}

// ── Server-finding distribution ─────────────────────────────────────────────

/**
 * Route the shared-validator findings that ride workflow GET/PATCH responses
 * ({@link WorkflowDiagnostics}) onto the cards. Paths are dot-strings rooted
 * at the config key ("trigger.fields.0.key", "steps.1.args.title"); `steps.*`
 * paths resolve to step ids through the LIVE draft, so findings survive
 * reorderings only as long as indices still line up — a stale path degrades
 * to the general bucket rather than mislabeling a card.
 */
export function serverDiagnostics(
  findings: WorkflowDiagnostics,
  steps: readonly PipelineStep[],
): BuilderDiagnostics {
  const diagnostics = emptyDiagnostics();
  for (const finding of findings) {
    routeByPath(
      diagnostics,
      finding.path === "" ? [] : finding.path.split("."),
      { severity: finding.severity, message: finding.message },
      steps,
    );
  }
  return diagnostics;
}
