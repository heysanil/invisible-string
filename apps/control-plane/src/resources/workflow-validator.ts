/**
 * Workflow validator — the publish gate and the builder's inline diagnostics
 * (workflows compile nothing, so this replaces the old dry-run-compile path
 * for the workflow surface).
 *
 * Two entry points over one shared rule set:
 * - {@link validateWorkflowConfig}: DRAFT validation (returned on GET/PATCH,
 *   enforced at publish — `severity: "error"` blocks publish). Checks shape,
 *   agent named + exists + published, non-empty instructions, `@trigger`
 *   legality per trigger type (ported from the retired compiler
 *   `validateTriggerPath` — form/webhook/slack only; form paths must match a
 *   field key), and `@connection`/`@skill` refs ⊆ the agent's PUBLISHED
 *   context slugs.
 * - {@link stalenessDiagnostics}: the PUBLISHED snapshot re-checked against
 *   the agent's CURRENT published context (an agent republish can strand
 *   `@refs` — risk: dispatch degrades to prose literals, so these are
 *   WARNINGS, never dispatch failures). Paths are prefixed `published.` to
 *   keep them distinguishable from draft diagnostics.
 *
 * The pure validators take a resolved {@link AgentValidationSnapshot};
 * {@link loadAgentValidationSnapshot} resolves one from `agents` /
 * `agent_versions` / `mcp_connections` / `skills` rows (slug grammar =
 * `slugifyName`, the same mapping the compiler applies to persona `@refs`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  agentDefinitionSchema,
  parseReferences,
  workflowConfigSchema,
  type TriggerConfig,
  type WorkflowDiagnostic,
  type WorkflowDiagnostics,
} from "@invisible-string/shared";

import { slugifyName } from "../build/compiler-adapter";
import type { DbClient } from "../db";
import { RuntimeApiError } from "../runtime/errors";

// ── Agent snapshot (what the rules need to know about the agent) ────────────

export interface AgentValidationSnapshot {
  id: string;
  name: string;
  /** True when the agent has a published version (the publishable bar). */
  published: boolean;
  /** Slugs addressable as `@<slug>` — the published context's connections. */
  connectionSlugs: ReadonlySet<string>;
  /** Slugs addressable as `@skill.<slug>` — the published context's skills. */
  skillSlugs: ReadonlySet<string>;
}

/**
 * Resolve the agent named by a workflow config into a validation snapshot.
 * Context slugs come from the agent's PUBLISHED version definition (that is
 * what dispatch runs), resolved via `mcp_connections`/`skills` rows — a row
 * deleted after the agent published simply drops out of the set, so refs to
 * it are flagged. Returns null when the agent does not exist in this
 * workspace (workspace scoping: the id must be owned by `organizationId`).
 */
export async function loadAgentValidationSnapshot(
  db: DbClient,
  organizationId: string,
  agentId: string,
): Promise<AgentValidationSnapshot | null> {
  const agentRows = await db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      publishedVersionId: schema.agents.publishedVersionId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.organizationId, organizationId),
      ),
    )
    .limit(1);
  const agent = agentRows[0];
  if (!agent) return null;

  const connectionSlugs = new Set<string>();
  const skillSlugs = new Set<string>();

  if (agent.publishedVersionId) {
    const versionRows = await db
      .select({ definition: schema.agentVersions.definition })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, agent.publishedVersionId))
      .limit(1);
    const parsed = agentDefinitionSchema.safeParse(versionRows[0]?.definition);
    if (parsed.success) {
      const { mcpConnectionIds, skillIds } = parsed.data.context;
      if (mcpConnectionIds.length > 0) {
        const rows = await db
          .select({ name: schema.mcpConnections.name })
          .from(schema.mcpConnections)
          .where(inArray(schema.mcpConnections.id, mcpConnectionIds));
        for (const row of rows) {
          const slug = slugifyName(row.name);
          if (slug !== "") connectionSlugs.add(slug);
        }
      }
      if (skillIds.length > 0) {
        const rows = await db
          .select({ name: schema.skills.name })
          .from(schema.skills)
          .where(inArray(schema.skills.id, skillIds));
        for (const row of rows) {
          const slug = slugifyName(row.name);
          if (slug !== "") skillSlugs.add(slug);
        }
      }
    }
  }

  return {
    id: agent.id,
    name: agent.name,
    published: agent.publishedVersionId != null,
    connectionSlugs,
    skillSlugs,
  };
}

// ── Draft validation ─────────────────────────────────────────────────────────

export interface WorkflowValidationInput {
  /** The stored config blob (`workflows.draft`, as stored). */
  config: unknown;
  /**
   * Snapshot for `config.agentId`; null when the config names no agent OR the
   * named agent does not exist in the workspace (the rules distinguish the
   * two by whether `agentId` is set).
   */
  agent: AgentValidationSnapshot | null;
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

/**
 * `@trigger.<path>` legality for a trigger type (ported semantics of the
 * retired compiler `validateTriggerPath` — diagnostics instead of throws).
 */
function triggerRefDiagnostics(
  trigger: TriggerConfig,
  path: string,
  raw: string,
): WorkflowDiagnostic[] {
  if (path === "") {
    return [
      error(
        "instructions.markdown",
        `bare "@trigger" reference — name a data path like "@trigger.email"`,
      ),
    ];
  }
  if (!triggerCarriesData(trigger)) {
    return [
      error(
        "instructions.markdown",
        `"${raw}" cannot be used with a "${trigger.type}" trigger — it carries no dispatch data`,
      ),
    ];
  }
  if (trigger.type === "form") {
    const head = path.split(".")[0] ?? "";
    if (!trigger.fields.some((field) => field.key === head)) {
      return [
        error(
          "instructions.markdown",
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
 * Validate a workflow DRAFT. Every returned diagnostic has `severity:
 * "error"` — all draft rules are publish-blocking (publish refuses while any
 * remain; the builder renders them inline before that).
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

  // AGENT: named + exists in this workspace + published.
  const agent = input.agent;
  if (config.agentId === null) {
    diagnostics.push(
      error("agentId", "choose an agent to handle this workflow's runs"),
    );
  } else if (!agent) {
    diagnostics.push(error("agentId", "agent not found in this workspace"));
  } else if (!agent.published) {
    diagnostics.push(
      error(
        "agentId",
        `agent "${agent.name}" has no published version — publish it first`,
      ),
    );
  }

  // INSTRUCTIONS: non-empty at publish.
  const markdown = config.instructions.markdown;
  if (markdown.trim().length === 0) {
    diagnostics.push(
      error(
        "instructions.markdown",
        "instructions are empty — a publishable workflow needs instructions",
      ),
    );
  }

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

  // @references in the instructions.
  const publishedAgent = agent && agent.published ? agent : null;
  for (const ref of parseReferences(markdown)) {
    if (ref.kind === "trigger") {
      diagnostics.push(...triggerRefDiagnostics(config.trigger, ref.path, ref.raw));
    } else if (ref.kind === "skill") {
      if (ref.slug === "") {
        diagnostics.push(
          error(
            "instructions.markdown",
            `bare "@skill" reference — name a skill like "@skill.release-notes"`,
          ),
        );
      } else if (publishedAgent && !publishedAgent.skillSlugs.has(ref.slug)) {
        // Only checkable against a published agent; the agentId diagnostics
        // above already block publish otherwise.
        diagnostics.push(
          error(
            "instructions.markdown",
            `"${ref.raw}" does not match any skill in agent "${publishedAgent.name}"'s published context (skills: ${listOr(publishedAgent.skillSlugs, "none")})`,
          ),
        );
      }
    } else if (publishedAgent && !publishedAgent.connectionSlugs.has(ref.name)) {
      diagnostics.push(
        error(
          "instructions.markdown",
          `"${ref.raw}" does not match any connection in agent "${publishedAgent.name}"'s published context (connections: ${listOr(publishedAgent.connectionSlugs, "none")}). Prose "@words" count as references — rephrase or add the connection to the agent.`,
        ),
      );
    }
  }

  return diagnostics;
}

// ── Published-snapshot staleness ─────────────────────────────────────────────

/**
 * Re-check a PUBLISHED snapshot against the agent's CURRENT published
 * context. An agent republish (or deletion of a context row) can strand
 * `@connection`/`@skill` refs after workflow publish — dispatch degrades
 * gracefully (prose literals), so everything here is a WARNING surfaced on
 * workflow GET/PATCH, never a dispatch failure. Trigger-ref legality is not
 * re-checked: trigger and instructions were snapshotted together and cannot
 * drift apart.
 */
export function stalenessDiagnostics(
  publishedConfig: unknown,
  agent: AgentValidationSnapshot | null,
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
  const config = parsed.data;
  const diagnostics: WorkflowDiagnostic[] = [];

  if (!agent) {
    return [
      warning(
        "published.agentId",
        "the published workflow's agent no longer exists — republish with another agent",
      ),
    ];
  }
  if (!agent.published) {
    return [
      warning(
        "published.agentId",
        `agent "${agent.name}" is no longer published — dispatches will fail until it is published again`,
      ),
    ];
  }

  for (const ref of parseReferences(config.instructions.markdown)) {
    if (ref.kind === "skill") {
      if (ref.slug !== "" && !agent.skillSlugs.has(ref.slug)) {
        diagnostics.push(
          warning(
            "published.instructions.markdown",
            `"${ref.raw}" is no longer in agent "${agent.name}"'s published context — dispatch renders it as literal text`,
          ),
        );
      }
    } else if (ref.kind === "connection" && !agent.connectionSlugs.has(ref.name)) {
      diagnostics.push(
        warning(
          "published.instructions.markdown",
          `"${ref.raw}" is no longer in agent "${agent.name}"'s published context — dispatch renders it as literal text`,
        ),
      );
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
