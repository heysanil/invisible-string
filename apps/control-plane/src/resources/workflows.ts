/**
 * Workflows CRUD (workspace-scoped). Role rules are enforced at the route
 * (member creates/edits; owner/admin deletes). `run_as_user_id` defaults to
 * the creator and must remain a workspace member (the compiler precondition,
 * spec §9). Draft updates additionally return dry-run-compile diagnostics so
 * the builder gets validation for free (reusing the shared dry-run service).
 */
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  type DeleteResourceResponse,
  type GetWorkflowResponse,
  type ListWorkflowsResponse,
} from "@invisible-string/shared";

import type { Db } from "../db";
import {
  dryRunCompile,
  type CompileServiceDeps,
  type DryRunResult,
} from "../runtime/compile-service";
import { errors } from "../runtime/errors";
import { parseBody, workflowDto, workflowSummaryDto, type ResourceDeps } from "./common";

/** The acting workspace member (from the requireWorkspace macro). */
export interface WorkflowActor {
  organizationId: string;
  userId: string;
}

/** PATCH response includes dry-run diagnostics when the draft changed. */
export interface UpdateWorkflowResult extends GetWorkflowResponse {
  diagnostics?: DryRunResult;
}

type Row = typeof schema.workflows.$inferSelect;

function compileDeps(deps: ResourceDeps): CompileServiceDeps {
  return {
    db: deps.db,
    masterKey: deps.masterKey,
    artifacts: deps.artifacts,
    compile: deps.compile,
  };
}

async function loadOwned(db: Db, organizationId: string, id: string): Promise<Row> {
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, organizationId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("workflow");
  return row;
}

/** run_as user must be a member of this workspace (compiler precondition). */
async function assertRunAsMember(
  deps: ResourceDeps,
  organizationId: string,
  userId: string,
): Promise<void> {
  const membership = await deps.workspaceDeps.getMembership(userId, organizationId);
  if (!membership) throw errors.runAsUserNotMember(userId);
}

export async function listWorkflows(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListWorkflowsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.organizationId, organizationId))
    .orderBy(desc(schema.workflows.updatedAt));
  return { workflows: rows.map(workflowSummaryDto) };
}

export async function getWorkflow(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<GetWorkflowResponse> {
  const row = await loadOwned(deps.db, organizationId, id);
  return { workflow: workflowDto(row) };
}

export async function createWorkflow(
  deps: ResourceDeps,
  actor: WorkflowActor,
  body: unknown,
): Promise<GetWorkflowResponse> {
  const input = parseBody(createWorkflowRequestSchema, body);
  const runAsUserId = input.runAsUserId ?? actor.userId;
  if (runAsUserId !== actor.userId) {
    await assertRunAsMember(deps, actor.organizationId, runAsUserId);
  }
  const rows = await deps.db
    .insert(schema.workflows)
    .values({
      organizationId: actor.organizationId,
      name: input.name,
      runAsUserId,
      draft: (input.draft as Record<string, unknown> | undefined) ?? {},
    })
    .returning();
  return { workflow: workflowDto(rows[0]!) };
}

export async function updateWorkflow(
  deps: ResourceDeps,
  actor: WorkflowActor,
  id: string,
  body: unknown,
): Promise<UpdateWorkflowResult> {
  const input = parseBody(updateWorkflowRequestSchema, body);
  const existing = await loadOwned(deps.db, actor.organizationId, id);

  const runAsUserId = input.runAsUserId ?? existing.runAsUserId;
  if (input.runAsUserId !== undefined && input.runAsUserId !== existing.runAsUserId) {
    await assertRunAsMember(deps, actor.organizationId, runAsUserId);
  }

  const patch: Partial<typeof schema.workflows.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.runAsUserId !== undefined) patch.runAsUserId = runAsUserId;
  if (input.draft !== undefined) {
    patch.draft = input.draft as unknown as Record<string, unknown>;
  }

  const rows = await deps.db
    .update(schema.workflows)
    .set(patch)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, actor.organizationId)),
    )
    .returning();
  const workflow = rows[0]!;

  // Draft edits get inline validation for free (the builder renders it next to
  // the pillar cards; a dedicated dry-run endpoint exists for polling too).
  // The persist above already succeeded — diagnostics are strictly best-effort
  // and must never fail the save (e.g. if the object store is briefly down).
  let diagnostics: DryRunResult | undefined;
  if (input.draft !== undefined) {
    try {
      diagnostics = await dryRunCompile(
        compileDeps(deps),
        actor.organizationId,
        workflow.runAsUserId,
        workflow.name,
        input.draft,
      );
    } catch {
      diagnostics = undefined;
    }
  }

  return { workflow: workflowDto(workflow), ...(diagnostics ? { diagnostics } : {}) };
}

export async function deleteWorkflow(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<DeleteResourceResponse> {
  await loadOwned(deps.db, organizationId, id);
  // FKs cascade to versions/sessions/runs; publishedVersionId self-reference is
  // dropped with the row.
  await deps.db
    .delete(schema.workflows)
    .where(
      and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, organizationId)),
    );
  return { id, deleted: true };
}
