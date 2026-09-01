/**
 * Workflows CRUD + publish (workspace-scoped). A workflow is a standing
 * PIPELINE — TRIGGER → STEPS — and compiles NOTHING: the control plane
 * interprets the steps (src/pipeline), and `agent` steps ride their bound
 * agent's current published version as child runs. Publish validates the
 * draft (shared workflow validator), snapshots `draft` → `published`
 * (+ `published_at`), and syncs the trigger row (type / slack binding rules /
 * form schema / cron + next_fire_at) — instant, no build.
 *
 * `published_agent_id` is no longer written (pipeline redesign amendment A1:
 * agents bind per STEP, not per workflow — the column survives only because
 * migrations are additive, and its delete-protection role moved to the agent
 * DELETE path's published-config scan in resources/agents.ts).
 *
 * Role rules are enforced at the route (member creates/edits/publishes;
 * owner/admin deletes). GET/PATCH/create answer validator diagnostics next to
 * the row (draft errors + published-snapshot staleness warnings) so the
 * builder gets validation without a second round-trip; diagnostics are
 * strictly best-effort on reads and never fail the request.
 *
 * Dispatch consumers (manual /run, trigger ingress, the schedule ticker) load
 * the snapshot through {@link loadPublishedWorkflow} /
 * {@link publishedWorkflowOf} and hand it to the pipeline runner.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createWorkflowRequestSchema,
  parseWorkflowConfig,
  updateWorkflowRequestSchema,
  walkSteps,
  WORKFLOW_SUMMARY_MAX_STEP_KINDS,
  type DeleteResourceResponse,
  type GetWorkflowResponse,
  type ListWorkflowsResponse,
  type PublishWorkflowResponse,
  type WorkflowConfig,
  type WorkflowDiagnostics,
  type WorkflowDto,
  type WorkflowSummaryDto,
} from "@invisible-string/shared";

import type { DbClient } from "../db";
import {
  nextScheduleFire,
  syncTriggerEnabled,
  syncTriggerForPublish,
} from "../integrations/service";
import { errors } from "../runtime/errors";
import { parseBody, type ResourceDeps } from "./common";
import {
  loadPipelineValidationResources,
  stalenessDiagnostics,
  validateWorkflowConfig,
  workflowValidationFailedError,
} from "./workflow-validator";

/** The acting workspace member (from the requireWorkspace macro). */
export interface WorkflowActor {
  organizationId: string;
  userId: string;
}

type Row = typeof schema.workflows.$inferSelect;

/** Deep cron check wired to the control-plane evaluator (validator option). */
const cronFires = (cron: string): boolean =>
  nextScheduleFire(cron, new Date()) !== null;

// ── DTO mappers ──────────────────────────────────────────────────────────────

/** `draft.trigger.type` for list chips (null when the draft has no trigger). */
function draftTriggerType(draft: unknown): string | null {
  if (typeof draft !== "object" || draft === null) return null;
  const trigger = (draft as { trigger?: unknown }).trigger;
  if (typeof trigger !== "object" || trigger === null) return null;
  const type = (trigger as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/**
 * The draft's step kinds in document order (pre-order walk), truncated to the
 * list chip's cap. Empty while the draft has no parseable pipeline shape.
 */
function draftStepKinds(draft: unknown): string[] {
  const config = parseWorkflowConfig(draft);
  if (!config) return [];
  return walkSteps(config.steps)
    .map((entry) => entry.step.kind)
    .slice(0, WORKFLOW_SUMMARY_MAX_STEP_KINDS);
}

/**
 * The agent a SOLE-agent-step pipeline delegates to (the list row renders its
 * name instead of a kind capsule); null for every other shape.
 */
function soleAgentStepAgentId(draft: unknown): string | null {
  const config = parseWorkflowConfig(draft);
  if (!config) return null;
  const entries = walkSteps(config.steps);
  const only = entries.length === 1 ? entries[0] : undefined;
  return only && only.step.kind === "agent" ? only.step.agentId : null;
}

export function workflowSummaryDto(
  row: Row,
  agentName: string | null,
): WorkflowSummaryDto {
  return {
    id: row.id,
    name: row.name,
    triggerType: draftTriggerType(row.draft),
    agentName,
    stepKinds: draftStepKinds(row.draft),
    enabled: row.enabled,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function workflowDto(row: Row): WorkflowDto {
  return {
    id: row.id,
    name: row.name,
    draft: (row.draft as Record<string, unknown>) ?? {},
    published: (row.published as Record<string, unknown> | null) ?? null,
    enabled: row.enabled,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Row loading + diagnostics ────────────────────────────────────────────────

async function loadOwned(
  db: DbClient,
  organizationId: string,
  id: string,
): Promise<Row> {
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, organizationId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.workflowNotFound();
  return row;
}

/**
 * Draft diagnostics + published-snapshot staleness warnings for one row.
 * Best-effort: reads must never fail because validation could not run
 * (`undefined` = omitted from the response, per the API contract).
 */
async function computeDiagnostics(
  db: DbClient,
  organizationId: string,
  row: Row,
): Promise<WorkflowDiagnostics | undefined> {
  try {
    // One resource load covers both configs — the validator resolves every
    // agent/connection id either one references.
    const resources = await loadPipelineValidationResources(db, organizationId, [
      row.draft,
      ...(row.published ? [row.published] : []),
    ]);
    const diagnostics = [
      ...validateWorkflowConfig(
        { config: row.draft, resources },
        { validateCron: cronFires },
      ),
    ];
    if (row.published) {
      diagnostics.push(...stalenessDiagnostics(row.published, resources));
    }
    return diagnostics;
  } catch {
    return undefined;
  }
}

function withDiagnostics(
  row: Row,
  diagnostics: WorkflowDiagnostics | undefined,
): GetWorkflowResponse {
  return { workflow: workflowDto(row), ...(diagnostics ? { diagnostics } : {}) };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listWorkflows(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListWorkflowsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.organizationId, organizationId))
    .orderBy(desc(schema.workflows.updatedAt));

  // Batched agent-name resolution for the list chips (sole-agent-step
  // pipelines render the delegated agent's name; multi-step rows render
  // their kind capsule instead).
  const agentIds = [
    ...new Set(
      rows
        .map((row) => soleAgentStepAgentId(row.draft))
        .filter((id): id is string => id !== null),
    ),
  ];
  const agentRows =
    agentIds.length > 0
      ? await deps.db
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.organizationId, organizationId),
              inArray(schema.agents.id, agentIds),
            ),
          )
      : [];
  const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]));

  return {
    workflows: rows.map((row) => {
      const agentId = soleAgentStepAgentId(row.draft);
      return workflowSummaryDto(
        row,
        agentId ? (agentNames.get(agentId) ?? null) : null,
      );
    }),
  };
}

export async function getWorkflow(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<GetWorkflowResponse> {
  const row = await loadOwned(deps.db, organizationId, id);
  return withDiagnostics(row, await computeDiagnostics(deps.db, organizationId, row));
}

export async function createWorkflow(
  deps: ResourceDeps,
  actor: WorkflowActor,
  body: unknown,
): Promise<GetWorkflowResponse> {
  const input = parseBody(createWorkflowRequestSchema, body);
  const rows = await deps.db
    .insert(schema.workflows)
    .values({
      organizationId: actor.organizationId,
      name: input.name,
      // Stored PARSED (schema defaults applied); omitted = empty draft the
      // editor fills in (shape diagnostics flag it until it takes form).
      draft: (input.draft as unknown as Record<string, unknown> | undefined) ?? {},
    })
    .returning();
  const row = rows[0]!;
  return withDiagnostics(
    row,
    await computeDiagnostics(deps.db, actor.organizationId, row),
  );
}

export async function updateWorkflow(
  deps: ResourceDeps,
  actor: WorkflowActor,
  id: string,
  body: unknown,
): Promise<GetWorkflowResponse> {
  const input = parseBody(updateWorkflowRequestSchema, body);
  const existing = await loadOwned(deps.db, actor.organizationId, id);

  const patch: Partial<typeof schema.workflows.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.draft !== undefined) {
    patch.draft = input.draft as unknown as Record<string, unknown>;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  const rows = await deps.db
    .update(schema.workflows)
    .set(patch)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, actor.organizationId)),
    )
    .returning();
  const workflow = rows[0]!;

  // The master switch also gates trigger dispatch — mirror it onto the
  // trigger row (schedules get their next-fire cursor set/cleared).
  if (input.enabled !== undefined && input.enabled !== existing.enabled) {
    await syncTriggerEnabled(
      deps.db,
      workflow.id,
      input.enabled,
      parseWorkflowConfig(workflow.published),
    );
  }

  return withDiagnostics(
    workflow,
    await computeDiagnostics(deps.db, actor.organizationId, workflow),
  );
}

export async function deleteWorkflow(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<DeleteResourceResponse> {
  await loadOwned(deps.db, organizationId, id);
  // Trigger rows and workflow_state cascade with the workflow; sessions and
  // runs survive with workflowId nulled (provenance outlives the delegation).
  await deps.db
    .delete(schema.workflows)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, organizationId)),
    );
  return { id, deleted: true };
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * Publish = validate → snapshot → sync trigger row. No compile, no build:
 * the response is the updated row, immediately dispatchable (agent steps keep
 * FLOATING bindings — dispatch resolves each bound agent's current published
 * version). Error-severity diagnostics block with 422
 * `workflow_validation_failed` (diagnostics in `details`); warnings (e.g. the
 * advisory tools-cache check) never block.
 */
export async function publishWorkflow(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<PublishWorkflowResponse> {
  const row = await loadOwned(deps.db, organizationId, id);

  const resources = await loadPipelineValidationResources(
    deps.db,
    organizationId,
    [row.draft],
  );
  const diagnostics = validateWorkflowConfig(
    { config: row.draft, resources },
    { validateCron: cronFires },
  );
  const blocking = diagnostics.filter((d) => d.severity === "error");
  if (blocking.length > 0) throw workflowValidationFailedError(blocking);

  // Shape-guarded by the validator above; parse to the canonical config the
  // snapshot stores and the pipeline runner interprets.
  const config = parseWorkflowConfig(row.draft);
  if (!config) {
    // Unreachable after validation — belt and braces for TS narrowing.
    throw workflowValidationFailedError([
      { path: "config", message: "workflow draft does not parse", severity: "error" },
    ]);
  }

  // Snapshot + trigger sync are one atomic step: a republished snapshot must
  // never run against a stale trigger row (e.g. old slack routing rules).
  // NOTE: published_agent_id is deliberately NOT written (amendment A1).
  const published = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.workflows)
      .set({
        published: config as unknown as Record<string, unknown>,
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workflows.id, row.id),
          eq(schema.workflows.organizationId, organizationId),
        ),
      )
      .returning();
    const workflow = updated[0]!;
    await syncTriggerForPublish(
      tx,
      { id: workflow.id, enabled: workflow.enabled },
      config,
    );
    return workflow;
  });

  return { workflow: workflowDto(published) };
}

// ── Published-workflow loader (dispatch surface) ─────────────────────────────

/** A workflow's published snapshot, ready for the pipeline runner. */
export interface PublishedWorkflow {
  workflow: Row;
  /** The parsed `published` snapshot (dispatch reads THIS, never the draft). */
  config: WorkflowConfig;
}

/**
 * Pure view of an already-loaded workflow row as a dispatchable published
 * workflow (Slack routing already holds rows from its integration join).
 * Throws 409 `workflow_not_published` when there is no (parseable) snapshot.
 * Callers own the `enabled` check — surfaces differ (ingress 404s, manual
 * run may be allowed).
 */
export function publishedWorkflowOf(row: Row): PublishedWorkflow {
  if (!row.published) throw errors.workflowNotPublished();
  const config = parseWorkflowConfig(row.published);
  if (!config) throw errors.workflowNotPublished();
  return { workflow: row, config };
}

/**
 * Load a workflow's published snapshot for dispatch (manual /run, trigger
 * ingress, the schedule ticker). Workspace-scoped: 404 when the row is not
 * owned by `organizationId`; 409 `workflow_not_published` when never
 * published.
 */
export async function loadPublishedWorkflow(
  db: DbClient,
  organizationId: string,
  workflowId: string,
): Promise<PublishedWorkflow> {
  const row = await loadOwned(db, organizationId, workflowId);
  return publishedWorkflowOf(row);
}
