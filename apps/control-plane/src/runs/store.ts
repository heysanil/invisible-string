/**
 * Run/event persistence surface consumed by the tailer and SSE routes.
 * Interface-first so the tailer unit-tests against an in-memory fake; the
 * drizzle implementation is the production path.
 */
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
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
  /**
   * The run's DURABLE remote-cancel obligation (`runs.remote_cancel_pending_at`),
   * written in the SAME statement that settles the row `canceled` — the
   * live-tail Stop whose remote leg was skipped or failed in transport
   * records it here so no window exists in which the row reads canceled
   * while nobody owes eve the cancel (a crash between two statements used
   * to leave the accepted turn with no obligation at all). Only meaningful
   * with `status: "canceled"`; cleared by the guarded chase
   * (runtime/routes.ts `cancelEveTurnGuarded`) on a confirmed outcome.
   */
  remoteCancelPendingAt?: Date;
}

export interface RunStore {
  /** Append one normalized eve event; seq is caller-assigned (monotonic). */
  appendEvent(runId: string, seq: number, event: EveStreamEvent): Promise<StoredRunEvent>;
  /** Events persisted for THIS run (seq base for a resuming tailer). */
  countRunEvents(runId: string): Promise<number>;
  /**
   * Stable eve `meta.id`s already persisted for THIS run — the tailer's
   * resume-overlap dedupe key (eve 0.31 stamps an `evt_`-prefixed ULID on
   * every event, identical across reconnects, rewinds and full replays).
   *
   * Id-less rows (pre-0.31 history) contribute nothing and are simply absent
   * from the result; the tailer falls back to index arithmetic for those.
   * Run-scoped on purpose: this answers "did THIS tail already persist this
   * event", which is the reconnect-overlap question. Cross-run leftover
   * drain is a different problem, handled by the turn gate in the tailer.
   */
  listEventIds(runId: string): Promise<string[]>;
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
  /**
   * Settle a run's outbound-reply obligation (Slack today): flips
   * `delivery_status` from `pending` to delivered/failed. CAS like markRun —
   * only a PENDING delivery is settled (racing settlers — the live tailer
   * hook vs the boot-time recovery sweep — resolve to one winner), and the
   * return value says whether this call was it. Runs with no delivery owed
   * (`delivery_status` null) are never touched.
   */
  markDelivery(
    runId: string,
    status: "delivered" | "failed",
    error?: string | null,
  ): Promise<boolean>;
  /**
   * Update a session's status. Transitioning to a TERMINAL status
   * (closed/error) also releases the session's `slack_thread_key`: a terminal
   * session can never continue its Slack thread (findSlackThreadSession skips
   * it), so keeping the key would permanently block the partial unique index
   * slot — every later message in that thread would 409 `session_busy` and be
   * silently dropped, with no recovery path. The release covers BOTH key
   * shapes — the bare ingress key and an agent-qualified derivative
   * (`<bareKey>:agent:<agentId>`, pipeline/steps/agent.ts) — the column is
   * simply nulled either way. Note the thread stays KNOWN to the Slack
   * ingress while any OTHER continuable session (bare or qualified) survives
   * (`isKnownSlackThread`, runtime/dispatch.ts).
   *
   * Under eve 0.31 that status-driven release is NO LONGER SUFFICIENT on its
   * own: eve's truth can diverge from this column indefinitely (a 30-day
   * `sessionTimeoutMs` emits `session.completed` into a stream nobody is
   * tailing; a `reset` retires the id) — in both the row stays
   * `active`/`waiting`. (A task-mode token-budget breach would be a third,
   * but the platform never sends eve's session `mode`, so every session is
   * conversation mode and parks on a `session-limit` input request instead of
   * failing — see eveSessionModeSchema.) The SECOND release trigger
   * is therefore eve's 409 `session_not_active` on a dispatch: the caller
   * marks the session `closed` here, which frees the key (see
   * runtime/routes.ts `failEveDispatch`).
   */
  markSession(agentSessionId: string, status: AgentSessionStatus): Promise<void>;
}
// NOTE: `updateSessionContinuation` is gone with eve 0.31's ID-addressed
// session API. `agent_sessions.continuation_token` stays in the schema
// (nullable, plus its partial index) and is simply never written again —
// dropping it would need a destructive migration, which the additive-migrations
// rule forbids. Tracked as a residual for a later cleanup pass.

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

    async listEventIds(runId) {
      const rows = await db
        .select({
          // jsonb path — no extra column, no migration. NULL for events that
          // carry no meta.id (pre-0.31 rows).
          eventId: sql<
            string | null
          >`${schema.runEvents.event} -> 'meta' ->> 'id'`,
        })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId));
      return rows
        .map((row) => row.eventId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
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
          // Same statement as the status flip (see RunStatusPatch): the
          // obligation and the terminal status commit together or not at all.
          ...(patch.remoteCancelPendingAt !== undefined
            ? { remoteCancelPendingAt: patch.remoteCancelPendingAt }
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

    async markDelivery(runId, status, error) {
      const updated = await db
        .update(schema.runs)
        .set({
          deliveryStatus: status,
          deliveryError: error ?? null,
        })
        .where(
          and(
            eq(schema.runs.id, runId),
            // Only a pending obligation is settled (see RunStore.markDelivery).
            eq(schema.runs.deliveryStatus, "pending"),
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
        .set({
          status,
          // Terminal sessions release their Slack thread key (see the
          // interface doc) so the next thread message can mint a fresh
          // session instead of being dropped forever.
          ...(status === "closed" || status === "error"
            ? { slackThreadKey: null }
            : {}),
        })
        .where(eq(schema.agentSessions.id, agentSessionId));
    },
  };
}
