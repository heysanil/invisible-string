/**
 * Run/event persistence surface consumed by the tailer and SSE routes.
 * Interface-first so the tailer unit-tests against an in-memory fake; the
 * drizzle implementation is the production path.
 */
import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
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
  /**
   * Compare-and-swap status transition: terminal statuses (succeeded/failed/
   * canceled) are STICKY — the update only applies while the run is still
   * queued/running/waiting, and the return value says whether it did. This is
   * the guard against split-brain transitions: a sweeper-failed run cannot be
   * resurrected to `running` by a late dispatch tail, and a canceled run
   * cannot be stomped to `failed` by a dying tail.
   */
  markRun(runId: string, patch: RunStatusPatch): Promise<boolean>;
  /** Status + failure detail — the SSE snapshot terminal frame must carry
   *  the run's error to late subscribers, not just the bare status. */
  getRunStatus(
    runId: string,
  ): Promise<{ status: RunStatus; error: string | null } | null>;
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
      const updated = await db
        .update(schema.runs)
        .set({
          status: patch.status,
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : {}),
        })
        .where(
          and(
            eq(schema.runs.id, runId),
            // Terminal statuses are sticky (see RunStore.markRun).
            inArray(schema.runs.status, ["queued", "running", "waiting"]),
          ),
        )
        .returning({ id: schema.runs.id });
      return updated.length > 0;
    },

    async getRunStatus(runId) {
      const rows = await db
        .select({ status: schema.runs.status, error: schema.runs.error })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      return rows[0] ?? null;
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
