/**
 * Session list (chat surface). Workspace-wide, per-agent, or per-workflow,
 * ordered by last activity (max of session/latest-run update time), carrying
 * the latest run's status plus the agent name (identity header) and workflow
 * name (provenance chip; null for direct chat). Session DETAIL, message
 * posting, run input, and SSE stay in the runtime plugin (they dispatch to
 * eve).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  listSessionsQuerySchema,
  type AgentSessionSummaryDto,
  type ListSessionsResponse,
  type RunStatus,
} from "@invisible-string/shared";

import { parseBody, type ResourceDeps } from "./common";

type SessionRow = typeof schema.agentSessions.$inferSelect;

/** Latest run per session (status + updatedAt), keyed by session id. */
async function latestRuns(
  deps: ResourceDeps,
  sessionIds: string[],
): Promise<Map<string, { status: RunStatus; updatedAt: Date }>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await deps.db
    .select({
      agentSessionId: schema.runs.agentSessionId,
      status: schema.runs.status,
      updatedAt: schema.runs.updatedAt,
      createdAt: schema.runs.createdAt,
    })
    .from(schema.runs)
    .where(inArray(schema.runs.agentSessionId, sessionIds))
    .orderBy(asc(schema.runs.createdAt));
  const latest = new Map<string, { status: RunStatus; updatedAt: Date }>();
  for (const row of rows) {
    // Ascending createdAt → the last write per session wins (the latest run).
    latest.set(row.agentSessionId, { status: row.status, updatedAt: row.updatedAt });
  }
  return latest;
}

export async function listSessions(
  deps: ResourceDeps,
  organizationId: string,
  query: unknown,
): Promise<ListSessionsResponse> {
  const filters = parseBody(listSessionsQuerySchema, query ?? {});

  const conditions = [eq(schema.agentSessions.organizationId, organizationId)];
  if (filters.agentId) {
    conditions.push(eq(schema.agentSessions.agentId, filters.agentId));
  }
  if (filters.workflowId) {
    conditions.push(eq(schema.agentSessions.workflowId, filters.workflowId));
  }
  if (filters.status) {
    conditions.push(eq(schema.agentSessions.status, filters.status));
  }

  const rows = await deps.db
    .select({
      session: schema.agentSessions,
      agentName: schema.agents.name,
      workflowName: schema.workflows.name,
    })
    .from(schema.agentSessions)
    .innerJoin(schema.agents, eq(schema.agentSessions.agentId, schema.agents.id))
    // Workflow provenance is nullable (direct chat) and survives workflow
    // deletion as null (FK SET NULL) — hence the LEFT join.
    .leftJoin(schema.workflows, eq(schema.agentSessions.workflowId, schema.workflows.id))
    .where(and(...conditions));

  const runs = await latestRuns(
    deps,
    rows.map((r) => r.session.id),
  );

  const sessions: AgentSessionSummaryDto[] = rows.map(
    ({ session, agentName, workflowName }) => {
      const run = runs.get(session.id);
      const lastActivity =
        run && run.updatedAt > session.updatedAt ? run.updatedAt : session.updatedAt;
      return {
        ...sessionSummaryBase(session),
        agentName,
        workflowName: workflowName ?? null,
        lastRunStatus: run?.status ?? null,
        lastActivityAt: lastActivity.toISOString(),
      };
    },
  );

  sessions.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return { sessions };
}

function sessionSummaryBase(row: SessionRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersionId: row.agentVersionId,
    workflowId: row.workflowId,
    origin: row.origin,
    status: row.status,
    eveSessionId: row.eveSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
