/**
 * Session list (chat surface). Workspace-wide, per-agent, or per-workflow,
 * ordered by last activity (max of session/latest-run update time), carrying
 * the latest run's status plus the agent name (identity header), the workflow
 * name (provenance chip; null for direct chat), the generated thread `title`
 * (null while the background titler in session-title.ts has not landed one,
 * and permanently null when it fails) and — so the sidebar's fallback is
 * reachable on a COLD load rather than only for threads this tab has opened —
 * a truncated preview of the thread's first user message. Session DETAIL,
 * message posting, run input, and SSE stay in the runtime plugin (they
 * dispatch to eve).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  listSessionsQuerySchema,
  SESSION_MESSAGE_PREVIEW_MAX_CHARS,
  type AgentSessionSummaryDto,
  type ListSessionsResponse,
  type RunStatus,
} from "@invisible-string/shared";

import { parseBody, type ResourceDeps } from "./common";

type SessionRow = typeof schema.agentSessions.$inferSelect;

/** What the list needs from a session's runs. */
interface SessionRunFacts {
  status: RunStatus;
  updatedAt: Date;
  /** First non-empty inbound message across the session's runs, truncated. */
  firstMessage: string | null;
}

/**
 * Per-session run facts (latest status/updatedAt + first-message preview),
 * keyed by session id.
 *
 * ONE round trip for the whole page of sessions — never a query per session.
 * The preview rides this same scan instead of a second one: the message lives
 * in `runs.trigger_event->>'message'` (the storage-only provenance envelope),
 * and `left(...)` truncates it IN POSTGRES so a list of long threads never
 * pulls whole message bodies over the wire.
 */
async function sessionRunFacts(
  deps: ResourceDeps,
  sessionIds: string[],
): Promise<Map<string, SessionRunFacts>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await deps.db
    .select({
      agentSessionId: schema.runs.agentSessionId,
      status: schema.runs.status,
      updatedAt: schema.runs.updatedAt,
      createdAt: schema.runs.createdAt,
      message: sql<string | null>`left(${schema.runs.triggerEvent} ->> 'message', ${SESSION_MESSAGE_PREVIEW_MAX_CHARS})`,
    })
    .from(schema.runs)
    .where(inArray(schema.runs.agentSessionId, sessionIds))
    .orderBy(asc(schema.runs.createdAt));
  const facts = new Map<string, SessionRunFacts>();
  for (const row of rows) {
    // agentSessionId is nullable (pipeline runs carry no session) — the
    // inArray filter above already excludes null rows in SQL; this narrows.
    if (row.agentSessionId === null) continue;
    // Ascending createdAt → the last write per session wins (the latest run),
    // while the FIRST non-empty message is kept: that is the thread's opener,
    // and a message-less lead run (a schedule fires with none) must not lock
    // the preview to null forever.
    const previous = facts.get(row.agentSessionId);
    const message = row.message?.trim() ?? "";
    facts.set(row.agentSessionId, {
      status: row.status,
      updatedAt: row.updatedAt,
      firstMessage:
        previous?.firstMessage ?? (message.length > 0 ? message : null),
    });
  }
  return facts;
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

  const runs = await sessionRunFacts(
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
        // Truncated in Postgres (see sessionRunFacts) — the row label's
        // fallback while `title` is null, which for a failed titling is
        // forever.
        firstMessagePreview: run?.firstMessage ?? null,
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
    // Null until the background titler lands one — and permanently null when
    // it fails (2026-08-11 spec D9). The sidebar then truncates
    // `firstMessagePreview` (shipped on this same row for exactly that
    // reason); it must never render "Untitled".
    title: row.title,
    eveSessionId: row.eveSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
