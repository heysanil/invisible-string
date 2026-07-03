/**
 * Run/event persistence surface consumed by the tailer and SSE routes.
 * Interface-first so the tailer unit-tests against an in-memory fake; the
 * drizzle implementation is the production path.
 */
import { and, asc, count, eq, gt } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type {
  AgentSessionStatus,
  EveStreamEvent,
  RunStatus,
} from "@invisible-string/shared";

import type { Db } from "../db";

export interface StoredRunEvent {
  seq: number;
  event: EveStreamEvent;
  at: string;
}

export interface RunStatusPatch {
  status: RunStatus;
  error?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}

export interface RunStore {
  /** Append one normalized eve event; seq is caller-assigned (monotonic). */
  appendEvent(runId: string, seq: number, event: EveStreamEvent): Promise<StoredRunEvent>;
  /** Events persisted for THIS run (seq base for a resuming tailer). */
  countRunEvents(runId: string): Promise<number>;
  /** Events persisted across ALL runs of the session = eve `startIndex`. */
  countSessionEvents(agentSessionId: string): Promise<number>;
  listEventsAfter(runId: string, afterSeq: number): Promise<StoredRunEvent[]>;
  markRun(runId: string, patch: RunStatusPatch): Promise<void>;
  getRunStatus(runId: string): Promise<RunStatus | null>;
  markSession(agentSessionId: string, status: AgentSessionStatus): Promise<void>;
  updateSessionContinuation(
    agentSessionId: string,
    continuationToken: string,
  ): Promise<void>;
}

export function createDrizzleRunStore(db: Db): RunStore {
  return {
    async appendEvent(runId, seq, event) {
      const rows = await db
        .insert(schema.runEvents)
        .values({ runId, seq, event: event as unknown as Record<string, unknown> })
        .returning({ createdAt: schema.runEvents.createdAt });
      const at = rows[0]?.createdAt ?? new Date();
      return { seq, event, at: at.toISOString() };
    },

    async countRunEvents(runId) {
      const rows = await db
        .select({ value: count() })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId));
      return rows[0]?.value ?? 0;
    },

    async countSessionEvents(agentSessionId) {
      const rows = await db
        .select({ value: count() })
        .from(schema.runEvents)
        .innerJoin(schema.runs, eq(schema.runEvents.runId, schema.runs.id))
        .where(eq(schema.runs.agentSessionId, agentSessionId));
      return rows[0]?.value ?? 0;
    },

    async listEventsAfter(runId, afterSeq) {
      const rows = await db
        .select({
          seq: schema.runEvents.seq,
          event: schema.runEvents.event,
          createdAt: schema.runEvents.createdAt,
        })
        .from(schema.runEvents)
        .where(
          and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, afterSeq)),
        )
        .orderBy(asc(schema.runEvents.seq));
      return rows.map((row) => ({
        seq: row.seq,
        event: row.event as unknown as EveStreamEvent,
        at: row.createdAt.toISOString(),
      }));
    },

    async markRun(runId, patch) {
      await db
        .update(schema.runs)
        .set({
          status: patch.status,
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : {}),
        })
        .where(eq(schema.runs.id, runId));
    },

    async getRunStatus(runId) {
      const rows = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      return rows[0]?.status ?? null;
    },

    async markSession(agentSessionId, status) {
      await db
        .update(schema.agentSessions)
        .set({ status })
        .where(eq(schema.agentSessions.id, agentSessionId));
    },

    async updateSessionContinuation(agentSessionId, continuationToken) {
      await db
        .update(schema.agentSessions)
        .set({ continuationToken })
        .where(eq(schema.agentSessions.id, agentSessionId));
    },
  };
}
