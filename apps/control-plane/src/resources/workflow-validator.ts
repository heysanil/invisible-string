/**
 * Workflow validator — the publish gate and the builder's inline diagnostics
 * for PIPELINE configs (workflow-pipelines redesign; workflows compile
 * nothing, so this replaces the dry-run-compile path for the workflow
 * surface).
 *
 * Two entry points over one shared rule set:
 * - {@link validateWorkflowConfig}: DRAFT validation (returned on GET/PATCH,
 *   enforced at publish — `severity: "error"` blocks publish). Checks shape
 *   (the shared schema also guards tree integrity: duplicate ids/slugs,
 *   nested for_each), the step budget, non-empty unique slugs, tool steps
 *   against live workspace connections (exists + enabled + workspace-scoped —
 *   user-scoped rows cannot back unattended runs), agent steps against
 *   published agents (+ the `session:"thread"` legality rules), non-empty
 *   infer/agent prompts, `@reference` legality on every templated surface
 *   (markdown, `$tpl` strings, `$ref` paths, condition operands): `@trigger`
 *   per trigger type (ported from the retired compiler `validateTriggerPath`),
 *   `@steps` only naming an EARLIER step in a visible scope, `@item` only
 *   inside for_each — plus the condition depth cap and the
 *   `onComplete.slackReply`-needs-a-slack-trigger rule.
 * - {@link stalenessDiagnostics}: the PUBLISHED snapshot re-checked against
 *   the workspace's CURRENT agents/connections (a deleted connection or an
 *   unpublished agent strands a published step — dispatch fails that step at
 *   run time, so these are WARNINGS, never dispatch blockers). Paths are
 *   prefixed `published.` to keep them distinguishable from draft
 *   diagnostics.
 *
 * The one WARNING severity draft rule: a tool name absent from the
 * connection's cached `tools_cache` (the cache is advisory — the server stays
 * authoritative, so this never blocks publish).
 *
 * Diagnostic paths follow the shared `walkSteps` configPath grammar (zod
 * issue-path segments joined with dots), e.g.
 * `steps.0.branches.1.steps.2.args.title` — the same grammar shape errors
 * come back in, so the builder reshapes one vocabulary.
 *
 * The pure validators take resolved {@link PipelineValidationResources};
 * {@link loadPipelineValidationResources} resolves them from `agents` /
 * `connections` rows for the ids a config references.
 */
import { inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  MAX_CONDITION_DEPTH,
  parseReferences,
  walkSteps,
  workflowConfigSchema,
  type ConditionOperand,
  type PipelineCondition,
  type PipelineStep,
  type RefValue,
  type TemplateValue,
  type TriggerConfig,
  type WorkflowConfig,
  type WorkflowDiagnostic,
  type WorkflowDiagnostics,
} from "@invisible-string/shared";

import type { DbClient } from "../db";
import { RuntimeApiError } from "../runtime/errors";

/** Publish-blocking cap on DECLARED steps (instances expand at run time). */
export const MAX_DECLARED_STEPS = 50;

// ── Resource snapshots (what the rules need to know about the workspace) ────

export interface PipelineAgentSnapshot {
  id: string;
  name: string;
  /** True when the agent has a published version (the dispatchable bar). */
  published: boolean;
}

export interface PipelineConnectionSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * `workspace` rows back tool steps; `user` rows are REJECTED at publish —
   * unattended runs execute on workspace authority, never a member's
   * personal credential.
   */
  scope: "workspace" | "user";
  /**
   * Tool names from the last successful probe's `tools_cache`; null when the
   * connection has never cached a tool list. Advisory only (warning rule).
   */
  toolNames: ReadonlySet<string> | null;
}

/** Everything the pure rules resolve steps against. */
export interface PipelineValidationResources {
  /** Workspace agents by id (only ids some config referenced are loaded). */
  agents: ReadonlyMap<string, PipelineAgentSnapshot>;
  /**
   * Connections by id. Workspace-scoped rows of OTHER workspaces are absent
   * (indistinguishable from "not found" — existence must not leak across
   * workspaces); user-scoped rows are present with `scope: "user"` so the
   * rule can say WHY they are unusable.
   */
  connections: ReadonlyMap<string, PipelineConnectionSnapshot>;
}

const EMPTY_RESOURCES: PipelineValidationResources = {
  agents: new Map(),
  connections: new Map(),
};

/**
 * Resolve the agents + connections referenced by the given config blobs
 * (draft AND published in one load — pass both). Shape-invalid configs
 * contribute no ids (their shape diagnostics dominate anyway).
 */
export async function loadPipelineValidationResources(
  db: DbClient,
  organizationId: string,
  configs: readonly unknown[],
): Promise<PipelineValidationResources> {
  const agentIds = new Set<string>();
  const connectionIds = new Set<string>();
  for (const raw of configs) {
    const parsed = workflowConfigSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const { step } of walkSteps(parsed.data.steps)) {
      if (step.kind === "agent" && step.agentId) agentIds.add(step.agentId);
      if (step.kind === "tool" && step.connectionId !== "") {
        connectionIds.add(step.connectionId);
      }
    }
  }

  const agents = new Map<string, PipelineAgentSnapshot>();
  if (agentIds.size > 0) {
    const rows = await db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        organizationId: schema.agents.organizationId,
        publishedVersionId: schema.agents.publishedVersionId,
      })
      .from(schema.agents)
      .where(inArray(schema.agents.id, [...agentIds]));
    for (const row of rows) {
      // Workspace scoping: a foreign workspace's agent reads as "not found".
      if (row.organizationId !== organizationId) continue;
      agents.set(row.id, {
        id: row.id,
        name: row.name,
        published: row.publishedVersionId != null,
      });
    }
  }

  const connections = new Map<string, PipelineConnectionSnapshot>();
  if (connectionIds.size > 0) {
    const rows = await db
      .select({
        id: schema.connections.id,
        name: schema.connections.name,
        scope: schema.connections.scope,
        organizationId: schema.connections.organizationId,
        enabled: schema.connections.enabled,
        toolsCache: schema.connections.toolsCache,
      })
      .from(schema.connections)
      .where(inArray(schema.connections.id, [...connectionIds]));
    for (const row of rows) {
      // A workspace row of another org must read "not found" (no leak);
      // user-scoped rows are kept so the rule can name the real problem.
      if (row.scope === "workspace" && row.organizationId !== organizationId) {
        continue;
      }
      connections.set(row.id, {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        scope: row.scope,
        toolNames: row.toolsCache
          ? new Set(row.toolsCache.map((tool) => tool.name))
          : null,
      });
    }
  }

  return { agents, connections };
}

// ── Draft validation ─────────────────────────────────────────────────────────

export interface WorkflowValidationInput {
  /** The stored config blob (`workflows.draft`, as stored). */
  config: unknown;
  /** Resolved snapshots for every agent/connection the config references. */
  resources: PipelineValidationResources;
}

export interface ValidateWorkflowOptions {
  /**
   * Deep cron check for schedule triggers (the shared schema is shape-only).
   * Wire it to the control-plane cron evaluator (`nextScheduleFire(cron, now)
   * !== null`); omitted = shape check only.
   */
  validateCron?: (cron: string) => boolean;
}

function error(path: string, message: string): WorkflowDiagnostic {
  return { path, message, severity: "error" };
}

function warning(path: string, message: string): WorkflowDiagnostic {
  return { path, message, severity: "warning" };
}

/** Trigger types whose dispatch envelope carries `data` for `@trigger.*`. */
function triggerCarriesData(trigger: TriggerConfig): boolean {
  return (
    trigger.type === "form" ||
    trigger.type === "webhook" ||
    trigger.type === "slack"
  );
}

function listOr(values: Iterable<string>, empty: string): string {
  const joined = [...values].join(", ");
  return joined.length > 0 ? joined : empty;
}

/** Where in the pipeline a templated surface sits (drives ref legality). */
interface RefPosition {
  trigger: TriggerConfig;
  /** Slugs addressable as `@steps.<slug>` FROM this surface (earlier steps). */
  visibleSlugs: ReadonlySet<string>;
  /** True inside a for_each body — the only place `@item` resolves. */
  inForEach: boolean;
}

/**
 * `@trigger.<path>` legality for a trigger type (ported semantics of the
 * retired compiler `validateTriggerPath` — diagnostics instead of throws).
 */
function triggerRefDiagnostics(
  trigger: TriggerConfig,
  diagnosticPath: string,
  refPath: string,
  raw: string,
): WorkflowDiagnostic[] {
  if (refPath === "") {
    return [
      error(
        diagnosticPath,
        `bare "@trigger" reference — name a data path like "@trigger.email"`,
      ),
    ];
  }
  if (!triggerCarriesData(trigger)) {
    return [
      error(
        diagnosticPath,
        `"${raw}" cannot be used with a "${trigger.type}" trigger — it carries no dispatch data`,
      ),
    ];
  }
  if (trigger.type === "form") {
    const head = refPath.split(".")[0] ?? "";
    if (!trigger.fields.some((field) => field.key === head)) {
      return [
        error(
          diagnosticPath,
          `"${raw}" does not match any form field key (fields: ${trigger.fields
            .map((field) => field.key)
            .join(", ")})`,
        ),
      ];
    }
  }
  return [];
}

/**
 * Legality of one `$ref` dot path (the structured grammar: heads `trigger` /
 * `steps` / `state` / `item` / `now`, per `resolveScopePath`).
 */
function refPathDiagnostics(
  refPath: string,
  diagnosticPath: string,
  position: RefPosition,
): WorkflowDiagnostic[] {
  if (refPath === "") {
    return [
      error(
        diagnosticPath,
        `empty "$ref" path — reference scope values like "steps.<slug>.result"`,
      ),
    ];
  }
  const segments = refPath.split(".");
  const head = segments[0] ?? "";
  switch (head) {
    case "trigger": {
      const rest = segments.slice(1).join(".");
      // A bare "trigger" names the whole data record — legal on every type
      // (it resolves {} when the trigger carries nothing).
      if (rest === "") return [];
      return triggerRefDiagnostics(
        position.trigger,
        diagnosticPath,
        rest,
        `$ref: ${refPath}`,
      );
    }
    case "steps": {
      const slug = segments[1] ?? "";
      if (slug === "") {
        return [
          error(
            diagnosticPath,
            `"$ref: steps" needs a step slug — reference an earlier step like "steps.<slug>.result"`,
          ),
        ];
      }
      if (!position.visibleSlugs.has(slug)) {
        return [
          error(
            diagnosticPath,
            `"steps.${slug}" does not name an earlier step (earlier steps: ${listOr(position.visibleSlugs, "none")})`,
          ),
        ];
      }
      return [];
    }
    case "state":
      return []; // any key is legal — unset state resolves null at run time
    case "item":
      if (!position.inForEach) {
        return [
          error(
            diagnosticPath,
            `"item" references are only available inside a for_each step`,
          ),
        ];
      }
      return [];
    case "now":
      if (segments.length > 1) {
        return [error(diagnosticPath, `"now" takes no path — use "now" alone`)];
      }
      return [];
    default:
      return [
        error(
          diagnosticPath,
          `unknown reference head "${head}" — expected trigger, steps, state, item or now`,
        ),
      ];
  }
}

/** Legality of every `@reference` in one markdown surface. */
function markdownRefDiagnostics(
  markdown: string,
  diagnosticPath: string,
  position: RefPosition,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const ref of parseReferences(markdown)) {
    if (ref.kind === "trigger") {
      diagnostics.push(
        ...triggerRefDiagnostics(position.trigger, diagnosticPath, ref.path, ref.raw),
      );
    } else if (ref.kind === "step") {
      if (ref.slug === "") {
        diagnostics.push(
          error(
            diagnosticPath,
            `bare "@steps" reference — name an earlier step like "@steps.search.result"`,
          ),
        );
      } else if (!position.visibleSlugs.has(ref.slug)) {
        diagnostics.push(
          error(
            diagnosticPath,
            `"${ref.raw}" does not name an earlier step (earlier steps: ${listOr(position.visibleSlugs, "none")})`,
          ),
        );
      }
    } else if (ref.kind === "item" && !position.inForEach) {
      diagnostics.push(
        error(
          diagnosticPath,
          `"${ref.raw}" is only available inside a for_each step`,
        ),
      );
    }
    // state/now: always legal. connection/skill: render as prose literals on
    // pipeline surfaces (no agent context to check against) — never flagged.
  }
  return diagnostics;
}

function isRefValue(value: unknown): value is RefValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}

/** Walk one {@link TemplateValue} tree, checking `$ref` paths + `$tpl` refs. */
function templateValueDiagnostics(
  value: TemplateValue,
  diagnosticPath: string,
  position: RefPosition,
): WorkflowDiagnostic[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      templateValueDiagnostics(entry, `${diagnosticPath}.${index}`, position),
    );
  }
  const record = value as Record<string, TemplateValue>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "$ref" && typeof record["$ref"] === "string") {
    return refPathDiagnostics(record["$ref"], diagnosticPath, position);
  }
  if (keys.length === 1 && keys[0] === "$tpl" && typeof record["$tpl"] === "string") {
    return markdownRefDiagnostics(record["$tpl"], diagnosticPath, position);
  }
  return Object.entries(record).flatMap(([key, entry]) =>
    templateValueDiagnostics(entry, `${diagnosticPath}.${key}`, position),
  );
}

/** Depth cap + `$ref` operand legality for one condition AST. */
function conditionDiagnostics(
  condition: PipelineCondition,
  diagnosticPath: string,
  position: RefPosition,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  let depthFlagged = false;
  const visitOperand = (operand: ConditionOperand): void => {
    if (isRefValue(operand)) {
      diagnostics.push(
        ...refPathDiagnostics(operand.$ref, diagnosticPath, position),
      );
    }
  };
  const visit = (node: PipelineCondition, depth: number): void => {
    if (depth > MAX_CONDITION_DEPTH) {
      // The evaluator THROWS past the cap at run time — one blocking
      // diagnostic here, not one per over-deep node.
      if (!depthFlagged) {
        depthFlagged = true;
        diagnostics.push(
          error(
            diagnosticPath,
            `condition nesting exceeds the depth cap of ${MAX_CONDITION_DEPTH}`,
          ),
        );
      }
      return;
    }
    if ("and" in node) {
      node.and.forEach((child) => visit(child, depth + 1));
    } else if ("or" in node) {
      node.or.forEach((child) => visit(child, depth + 1));
    } else if ("not" in node) {
      visit(node.not, depth + 1);
    } else if ("exists" in node) {
      visitOperand(node.exists);
    } else if ("truthy" in node) {
      visitOperand(node.truthy);
    } else if ("empty" in node) {
      visitOperand(node.empty);
    } else {
      // Every remaining member is an operand pair keyed by its operator.
      const pair = Object.values(node)[0] as [ConditionOperand, ConditionOperand];
      visitOperand(pair[0]);
      visitOperand(pair[1]);
    }
  };
  visit(condition, 1);
  return diagnostics;
}

/** Per-kind rules for one step at its position in the tree. */
function stepDiagnostics(
  step: PipelineStep,
  basePath: string,
  position: RefPosition,
  resources: PipelineValidationResources,
  trigger: TriggerConfig,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];

  // SLUG: the `@steps.<slug>` handle — publish requires it (uniqueness and
  // charset are schema-guarded).
  if (step.slug === "") {
    diagnostics.push(
      error(
        `${basePath}.slug`,
        `step needs a slug — it is the "@steps.<slug>" handle later steps reference`,
      ),
    );
  }

  switch (step.kind) {
    case "tool": {
      const connection =
        step.connectionId === ""
          ? undefined
          : resources.connections.get(step.connectionId);
      if (step.connectionId === "") {
        diagnostics.push(
          error(`${basePath}.connectionId`, "choose a connection for this tool step"),
        );
      } else if (!connection) {
        diagnostics.push(
          error(
            `${basePath}.connectionId`,
            "connection not found in this workspace",
          ),
        );
      } else if (connection.scope === "user") {
        diagnostics.push(
          error(
            `${basePath}.connectionId`,
            "user-scoped connections cannot back workflow steps — unattended runs use workspace authority; add a workspace connection instead",
          ),
        );
      } else if (!connection.enabled) {
        diagnostics.push(
          error(
            `${basePath}.connectionId`,
            `connection "${connection.name}" is disabled — enable it or pick another`,
          ),
        );
      }
      if (step.tool === "") {
        diagnostics.push(error(`${basePath}.tool`, "choose a tool to call"));
      } else if (
        connection &&
        connection.scope === "workspace" &&
        connection.enabled &&
        connection.toolNames &&
        !connection.toolNames.has(step.tool)
      ) {
        // WARNING only: the cache is advisory (the server stays
        // authoritative; a cache miss at run time still calls).
        diagnostics.push(
          warning(
            `${basePath}.tool`,
            `tool "${step.tool}" is not in connection "${connection.name}"'s cached tool list (${listOr(connection.toolNames, "empty")}) — check the name or re-probe the connection`,
          ),
        );
      }
      for (const [key, value] of Object.entries(step.args)) {
        diagnostics.push(
          ...templateValueDiagnostics(value, `${basePath}.args.${key}`, position),
        );
      }
      break;
    }
    case "infer": {
      if (step.prompt.markdown.trim().length === 0) {
        diagnostics.push(
          error(`${basePath}.prompt.markdown`, "infer step needs a prompt"),
        );
      } else {
        diagnostics.push(
          ...markdownRefDiagnostics(
            step.prompt.markdown,
            `${basePath}.prompt.markdown`,
            position,
          ),
        );
      }
      break;
    }
    case "agent": {
      const agent = step.agentId ? resources.agents.get(step.agentId) : undefined;
      if (step.agentId === null) {
        diagnostics.push(
          error(`${basePath}.agentId`, "choose an agent for this step"),
        );
      } else if (!agent) {
        diagnostics.push(
          error(`${basePath}.agentId`, "agent not found in this workspace"),
        );
      } else if (!agent.published) {
        diagnostics.push(
          error(
            `${basePath}.agentId`,
            `agent "${agent.name}" has no published version — publish it first`,
          ),
        );
      }
      if (step.instructions.markdown.trim().length === 0) {
        diagnostics.push(
          error(
            `${basePath}.instructions.markdown`,
            "agent step needs instructions",
          ),
        );
      } else {
        diagnostics.push(
          ...markdownRefDiagnostics(
            step.instructions.markdown,
            `${basePath}.instructions.markdown`,
            position,
          ),
        );
      }
      if (step.session === "thread") {
        if (trigger.type !== "slack") {
          diagnostics.push(
            error(
              `${basePath}.session`,
              `session "thread" continues a Slack thread — it needs a slack trigger (got "${trigger.type}")`,
            ),
          );
        }
        if (step.output) {
          diagnostics.push(
            error(
              `${basePath}.session`,
              `session "thread" cannot take an output schema — a continued conversation has no single structured result`,
            ),
          );
        }
      }
      break;
    }
    case "for_each": {
      // `items` renders BEFORE the loop body runs, so `@item` is illegal in
      // it even though the step nests a body (position.inForEach reflects the
      // loop step's own position, which is what we want here).
      diagnostics.push(
        ...refPathDiagnostics(step.items.$ref, `${basePath}.items`, position),
      );
      break;
    }
    case "branch": {
      step.branches.forEach((branch, lane) => {
        diagnostics.push(
          ...conditionDiagnostics(
            branch.when,
            `${basePath}.branches.${lane}.when`,
            position,
          ),
        );
      });
      break;
    }
    case "filter": {
      diagnostics.push(
        ...conditionDiagnostics(step.where, `${basePath}.where`, position),
      );
      break;
    }
    case "state": {
      for (const [key, value] of Object.entries(step.set)) {
        diagnostics.push(
          ...templateValueDiagnostics(value, `${basePath}.set.${key}`, position),
        );
      }
      break;
    }
  }

  return diagnostics;
}

/**
 * Validate a workflow DRAFT. Every returned diagnostic except the advisory
 * tools-cache check has `severity: "error"` — publish refuses while any
 * error remains; the builder renders them inline before that.
 */
export function validateWorkflowConfig(
  input: WorkflowValidationInput,
  options: ValidateWorkflowOptions = {},
): WorkflowDiagnostics {
  const parsed = workflowConfigSchema.safeParse(input.config);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      error(issue.path.join(".") || "config", issue.message),
    );
  }
  const config = parsed.data;
  const diagnostics: WorkflowDiagnostic[] = [];

  // TRIGGER: deep cron check (shape is already schema-guarded).
  if (
    config.trigger.type === "schedule" &&
    options.validateCron &&
    !options.validateCron(config.trigger.cron)
  ) {
    diagnostics.push(
      error(
        "trigger.cron",
        `cron expression "${config.trigger.cron}" never fires — check the five UTC fields (minute hour day-of-month month day-of-week)`,
      ),
    );
  }

  const entries = walkSteps(config.steps);

  // STEPS: a publishable pipeline has 1..MAX_DECLARED_STEPS declared steps.
  if (entries.length === 0) {
    diagnostics.push(
      error("steps", "pipeline has no steps — add at least one step"),
    );
  } else if (entries.length > MAX_DECLARED_STEPS) {
    diagnostics.push(
      error(
        "steps",
        `pipeline declares ${entries.length} steps — the cap is ${MAX_DECLARED_STEPS}`,
      ),
    );
  }

  // Per-step rules, with visibility computed in ONE document-order pass:
  // a step sees every step strictly before it minus its own ancestors (the
  // same set `stepsBefore` computes — kept incremental here so validation
  // stays linear).
  const seenInOrder: { id: string; slug: string }[] = [];
  for (const entry of entries) {
    const basePath = ["steps", ...entry.configPath].join(".");
    const ancestorIds = new Set(entry.ancestors.map((ancestor) => ancestor.id));
    const visibleSlugs = new Set(
      seenInOrder
        .filter((seen) => !ancestorIds.has(seen.id) && seen.slug !== "")
        .map((seen) => seen.slug),
    );
    const position: RefPosition = {
      trigger: config.trigger,
      visibleSlugs,
      inForEach: entry.ancestors.some((ancestor) => ancestor.kind === "for_each"),
    };
    diagnostics.push(
      ...stepDiagnostics(
        entry.step,
        basePath,
        position,
        input.resources,
        config.trigger,
      ),
    );
    seenInOrder.push({ id: entry.step.id, slug: entry.step.slug });
  }

  // onComplete.slackReply: renders against the FINAL scope (every slug
  // visible, no loop item) and delivers into the triggering Slack thread —
  // meaningless on any other trigger, so publish blocks it (a config that
  // silently never delivers is worse than a red diagnostic).
  if (config.onComplete?.slackReply) {
    if (config.trigger.type !== "slack") {
      diagnostics.push(
        error(
          "onComplete.slackReply",
          `a Slack reply on completion needs a slack trigger (got "${config.trigger.type}") — there is no thread to reply into`,
        ),
      );
    }
    const finalPosition: RefPosition = {
      trigger: config.trigger,
      visibleSlugs: new Set(
        entries.map((entry) => entry.step.slug).filter((slug) => slug !== ""),
      ),
      inForEach: false,
    };
    diagnostics.push(
      ...markdownRefDiagnostics(
        config.onComplete.slackReply.template.markdown,
        "onComplete.slackReply.template.markdown",
        finalPosition,
      ),
    );
  }

  return diagnostics;
}

// ── Published-snapshot staleness ─────────────────────────────────────────────

/**
 * Re-check a PUBLISHED snapshot against the workspace's CURRENT agents and
 * connections. Deleting/unpublishing an agent or deleting/disabling a
 * connection after workflow publish strands the referencing step — the
 * affected step fails at dispatch (the rest of the run is untouched), so
 * everything here is a WARNING surfaced on workflow GET/PATCH, never a
 * dispatch blocker. `@reference` legality is not re-checked: refs were
 * validated against the snapshot's own steps/trigger, which cannot drift
 * apart.
 */
export function stalenessDiagnostics(
  publishedConfig: unknown,
  resources: PipelineValidationResources,
): WorkflowDiagnostics {
  const parsed = workflowConfigSchema.safeParse(publishedConfig);
  if (!parsed.success) {
    // Publish validated the snapshot, so this indicates out-of-band edits.
    return [
      warning(
        "published",
        "published snapshot no longer parses as a workflow config — republish this workflow",
      ),
    ];
  }
  const config: WorkflowConfig = parsed.data;
  const diagnostics: WorkflowDiagnostic[] = [];

  for (const entry of walkSteps(config.steps)) {
    const basePath = ["published", "steps", ...entry.configPath].join(".");
    const step = entry.step;
    if (step.kind === "agent" && step.agentId !== null) {
      const agent = resources.agents.get(step.agentId);
      if (!agent) {
        diagnostics.push(
          warning(
            `${basePath}.agentId`,
            "this step's agent no longer exists — the step will fail at dispatch; republish with another agent",
          ),
        );
      } else if (!agent.published) {
        diagnostics.push(
          warning(
            `${basePath}.agentId`,
            `agent "${agent.name}" is no longer published — the step will fail at dispatch until it is published again`,
          ),
        );
      }
    } else if (step.kind === "tool" && step.connectionId !== "") {
      const connection = resources.connections.get(step.connectionId);
      if (!connection || connection.scope === "user") {
        diagnostics.push(
          warning(
            `${basePath}.connectionId`,
            "this step's connection is no longer available in this workspace — the step will fail at dispatch",
          ),
        );
      } else if (!connection.enabled) {
        diagnostics.push(
          warning(
            `${basePath}.connectionId`,
            `connection "${connection.name}" is disabled — the step will fail at dispatch until it is enabled`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

// ── Publish gate error ───────────────────────────────────────────────────────

/** 422 thrown by publish while error-severity diagnostics remain. */
export function workflowValidationFailedError(
  diagnostics: WorkflowDiagnostics,
): RuntimeApiError {
  return new RuntimeApiError(
    422,
    "workflow_validation_failed",
    "workflow draft failed publish validation",
    { diagnostics },
  );
}
