/**
 * Agents CRUD (workspace-scoped) — the first-class Agent entity (PERSONA ·
 * MODEL · CONTEXT). Role rules are enforced at the route (member
 * creates/edits; owner/admin deletes). `run_as_user_id` defaults to the
 * creator and must remain a workspace member (the compiler precondition,
 * spec §2). Draft updates additionally return dry-run-compile diagnostics so
 * the agent editor gets validation for free (reusing the shared dry-run
 * service). Lifecycle verbs (publish, build status, dry-run-compile,
 * sessions) live in runtime/routes.ts.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createAgentRequestSchema,
  updateAgentRequestSchema,
  type AgentDto,
  type AgentSummaryDto,
  type DeleteResourceResponse,
  type GetAgentResponse,
  type ListAgentsResponse,
  type UpdateAgentResponse,
} from "@invisible-string/shared";

import type { Db } from "../db";
import {
  dryRunCompile,
  type CompileServiceDeps,
  type DryRunResult,
} from "../runtime/compile-service";
import { errors } from "../runtime/errors";
import { parseBody, type ResourceDeps } from "./common";

/** The acting workspace member (from the requireWorkspace macro). */
export interface AgentActor {
  organizationId: string;
  userId: string;
}

type AgentRow = typeof schema.agents.$inferSelect;

export function agentDto(
  row: AgentRow,
  publishedDefinition: Record<string, unknown> | null,
): AgentDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    runAsUserId: row.runAsUserId,
    draft: (row.draft as Record<string, unknown>) ?? {},
    publishedVersionId: row.publishedVersionId,
    publishedDefinition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The CURRENT published version's definition (what dispatch and the workflow
 * validator resolve against) — null while unpublished. Served on the agent
 * DTO so the SPA can mirror dispatch-time reference resolution exactly.
 */
async function loadPublishedDefinition(
  db: Db,
  publishedVersionId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!publishedVersionId) return null;
  const rows = await db
    .select({ definition: schema.agentVersions.definition })
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.id, publishedVersionId))
    .limit(1);
  return (rows[0]?.definition as Record<string, unknown> | undefined) ?? null;
}

function compileDeps(deps: ResourceDeps): CompileServiceDeps {
  return {
    db: deps.db,
    masterKey: deps.masterKey,
    artifacts: deps.artifacts,
    compile: deps.compile,
  };
}

async function loadOwned(db: Db, organizationId: string, id: string): Promise<AgentRow> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("agent");
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

/** Agent names are unique per workspace (the slug feeds the content hash). */
async function assertNameFree(
  db: Db,
  organizationId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const rows = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.organizationId, organizationId), eq(schema.agents.name, name)))
    .limit(1);
  const clash = rows[0];
  if (clash && clash.id !== exceptId) throw errors.nameTaken("agent", name);
}

export async function listAgents(
  deps: ResourceDeps,
  organizationId: string,
): Promise<ListAgentsResponse> {
  // LEFT JOIN the published version for the card grid's publishedAt +
  // buildStatus chips (null while unpublished).
  const rows = await deps.db
    .select({
      agent: schema.agents,
      publishedAt: schema.agentVersions.createdAt,
      buildStatus: schema.agentVersions.buildStatus,
    })
    .from(schema.agents)
    .leftJoin(
      schema.agentVersions,
      eq(schema.agents.publishedVersionId, schema.agentVersions.id),
    )
    .where(eq(schema.agents.organizationId, organizationId))
    .orderBy(desc(schema.agents.updatedAt));

  const agents: AgentSummaryDto[] = rows.map(({ agent, publishedAt, buildStatus }) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    runAsUserId: agent.runAsUserId,
    publishedVersionId: agent.publishedVersionId,
    publishedAt: publishedAt?.toISOString() ?? null,
    buildStatus: buildStatus ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  }));
  return { agents };
}

export async function getAgent(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<GetAgentResponse> {
  const row = await loadOwned(deps.db, organizationId, id);
  return {
    agent: agentDto(
      row,
      await loadPublishedDefinition(deps.db, row.publishedVersionId),
    ),
  };
}

export async function createAgent(
  deps: ResourceDeps,
  actor: AgentActor,
  body: unknown,
): Promise<GetAgentResponse> {
  const input = parseBody(createAgentRequestSchema, body);
  const runAsUserId = input.runAsUserId ?? actor.userId;
  if (runAsUserId !== actor.userId) {
    await assertRunAsMember(deps, actor.organizationId, runAsUserId);
  }
  await assertNameFree(deps.db, actor.organizationId, input.name);
  const rows = await deps.db
    .insert(schema.agents)
    .values({
      organizationId: actor.organizationId,
      name: input.name,
      description: input.description ?? null,
      runAsUserId,
      draft: (input.draft as Record<string, unknown> | undefined) ?? {},
    })
    .returning();
  // A freshly created agent is never published.
  return { agent: agentDto(rows[0]!, null) };
}

export async function updateAgent(
  deps: ResourceDeps,
  actor: AgentActor,
  id: string,
  body: unknown,
): Promise<UpdateAgentResponse> {
  const input = parseBody(updateAgentRequestSchema, body);
  const existing = await loadOwned(deps.db, actor.organizationId, id);

  const runAsUserId = input.runAsUserId ?? existing.runAsUserId;
  if (input.runAsUserId !== undefined && input.runAsUserId !== existing.runAsUserId) {
    await assertRunAsMember(deps, actor.organizationId, runAsUserId);
  }
  if (input.name !== undefined && input.name !== existing.name) {
    await assertNameFree(deps.db, actor.organizationId, input.name, id);
  }

  const patch: Partial<typeof schema.agents.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.runAsUserId !== undefined) patch.runAsUserId = runAsUserId;
  if (input.draft !== undefined) {
    patch.draft = input.draft as unknown as Record<string, unknown>;
  }

  const rows = await deps.db
    .update(schema.agents)
    .set(patch)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, actor.organizationId)))
    .returning();
  const agent = rows[0]!;

  // Draft edits get inline validation for free (the editor renders it next
  // to the section cards; the dedicated dry-run endpoint exists for polling
  // too). The persist above already succeeded — diagnostics are strictly
  // best-effort and must never fail the save (e.g. if the object store is
  // briefly down).
  let diagnostics: DryRunResult | undefined;
  if (input.draft !== undefined) {
    try {
      diagnostics = await dryRunCompile(
        compileDeps(deps),
        actor.organizationId,
        agent.runAsUserId,
        agent.name,
        input.draft,
      );
    } catch {
      diagnostics = undefined;
    }
  }

  return {
    agent: agentDto(
      agent,
      await loadPublishedDefinition(deps.db, agent.publishedVersionId),
    ),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * Everything that still depends on this agent — the DELETE guard. Workflows
 * count when their published snapshot points at the agent (denormalized
 * `published_agent_id`) OR their draft names it; sessions count always
 * (deleting the agent would cascade away whole conversations + run history).
 */
export async function agentReferences(
  db: Db,
  organizationId: string,
  agentId: string,
): Promise<{ workflows: string[]; sessions: number }> {
  const [workflowRows, sessionRows] = await Promise.all([
    db
      .select({ name: schema.workflows.name })
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.organizationId, organizationId),
          sql`(${schema.workflows.publishedAgentId} = ${agentId} OR ${schema.workflows.draft} ->> 'agentId' = ${agentId})`,
        ),
      )
      .orderBy(schema.workflows.name),
    db
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.agentId, agentId)),
  ]);
  return {
    workflows: workflowRows.map((row) => row.name),
    sessions: sessionRows.length,
  };
}

export async function deleteAgent(
  deps: ResourceDeps,
  organizationId: string,
  id: string,
): Promise<DeleteResourceResponse> {
  await loadOwned(deps.db, organizationId, id);
  const refs = await agentReferences(deps.db, organizationId, id);
  if (refs.workflows.length > 0 || refs.sessions > 0) {
    throw errors.agentInUse(refs.workflows, refs.sessions);
  }
  // No sessions ⇒ the cascade only removes this agent's own versions.
  await deps.db
    .delete(schema.agents)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, organizationId)));
  return { id, deleted: true };
}
