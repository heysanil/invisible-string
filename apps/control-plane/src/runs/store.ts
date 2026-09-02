/**
 * Run/event persistence surface consumed by the tailer and SSE routes.
 * Interface-first so the tailer unit-tests against an in-memory fake; the
 * drizzle implementation is the production path.
 */
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
   * live-tail Stop records it here so no window exists in which the row
   * reads canceled while nobody owes eve the confirmation (a crash between
   * two statements used to leave the accepted turn with no obligation at
   * all). Only meaningful with a TERMINAL status — `canceled` for a Stop,
   * `failed` for the tail's wall-clock cap / shutdown; cleared by
   * {@link RunStore.clearRemoteCancelPending} on a CONFIRMED outcome only —
   * the run's own turn boundary on eve's stream, a session-terminal answer,
   * a proven successor, or a send that provably never happened.
   */
  remoteCancelPendingAt?: Date;
  /**
   * `runs.turn_id` — eve's acceptance proof for the run's LATEST send.
   * `null` here is the dispatch-attempt CAS resetting it before a (re)send
   * (`armDispatchAttempt`), so the column always describes the turn of the
   * most recent message; the tail writes the id itself through
   * {@link RunStore.setRunTurnId} when it observes the run's own
   * `turn.started`.
   */
  turnId?: string | null;
  /**
   * `runs.message_hash` — the turn correlator for the run's LATEST send
   * (runs/message-hash.ts): the digest of the message text, or `null` for a
   * content-less `inputResponses` send. Written by the dispatch-attempt CAS
   * together with the marker and the `turnId: null` reset, so the three
   * columns always describe the same send.
   */
  messageHash?: string | null;
}

/** One open remote-cancel obligation on a session (see listPendingRemoteCancels). */
export interface PendingRemoteCancel {
  runId: string;
  /**
   * The settled run's own turn id, when its turn has already been attributed
   * (a turn-QUALIFIED cancel can be issued for it); null when the turn has
   * not been seen to start — a later turn on the session's stream is this
   * run's iff its `message.received` matches `messageHash` (content-less
   * turns match content-less senders, in send order).
   */
  turnId: string | null;
  /** The correlator of the run's latest send (`runs.message_hash`). */
  messageHash: string | null;
  /** When the obligation was recorded (the observation clock starts here). */
  pendingAt: Date;
  /**
   * Set when the observation window elapsed without confirmation
   * (`runs.remote_cancel_unresolved_at`). Such an obligation STAYS
   * attributable — a late turn matching its content still claims it and
   * clears both columns on the boundary — but ranks after every pending one.
   */
  unresolvedAt: Date | null;
  /** Row age (`runs.created_at`) — the tie-breaker among identical texts. */
  createdAt: Date;
}

/** A live run on a session whose latest send has not been attributed a turn. */
export interface UnattributedLiveRun {
  runId: string;
  messageHash: string | null;
  createdAt: Date;
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
   * The run's turn/obligation state as persisted: its `turn_id` (eve's
   * acceptance proof for the latest send, null until the tail observed the
   * run's own `turn.started`) and whether a remote-cancel obligation is
   * still open on it. Read by a starting tail to decide whether its own
   * turn boundary has already been seen (a resume after a crash) — the
   * durable column, never `seq > 0`, which a predecessor's drained leftovers
   * also satisfy.
   */
  getRunTurnState(runId: string): Promise<{
    status: RunStatus;
    turnId: string | null;
    /** The correlator of the run's latest send (`runs.message_hash`). */
    messageHash: string | null;
    remoteCancelPendingAt: Date | null;
  } | null>;
  /**
   * Record eve's acceptance proof: the run's own `turn.started.data.turnId`.
   * CAS — writes only while `turn_id` is NULL or already this id (a
   * re-read after a reconnect/crash is idempotent); a different id already
   * present is refused and reported false. Written BEFORE the event itself
   * is persisted, so a crash in between leaves the proof (the event is
   * re-read on resume and recognized as the run's own).
   */
  setRunTurnId(runId: string, turnId: string): Promise<boolean>;
  /**
   * The session's OPEN remote-cancel obligations — runs carrying
   * `remote_cancel_pending_at` (settled `canceled` by a Stop, or `failed` by
   * the tail's wall-clock cap / shutdown), UNRESOLVED ones INCLUDED — in
   * attribution priority: pending (not yet unresolved) before unresolved,
   * oldest first within each. A tail attributes every turn it consumes by
   * CONTENT — the first obligation with a null `turnId` whose `messageHash`
   * equals the digest of the turn's `message.received` (or, for a
   * content-less turn, whose `messageHash` is null) claims it; only when
   * none matches may the turn be the tail's own, a live successor's, or
   * foreign (runs/tailer.ts). A tail started in observation mode for one of
   * these runs handles the whole list the same way.
   */
  listPendingRemoteCancels(agentSessionId: string): Promise<PendingRemoteCancel[]>;
  /**
   * Live (queued/running/waiting) runs on the session whose dispatch-attempt
   * marker is set and whose latest send has no `turn_id` yet — a successor
   * admitted after an observation tail attached, whose own tail has not yet
   * taken the stream over. An observation tail that sees a content turn no
   * obligation claims looks here: a hash match writes that run's `turn_id`
   * (eve's proof it moved on — every obligation on the session is over) and
   * the successor's tail then reads its own turn from the column instead of
   * waiting for a `turn.started` that was drained under the observed run.
   */
  listUnattributedLiveRuns(agentSessionId: string): Promise<UnattributedLiveRun[]>;
  /**
   * Meet a run's remote-cancel obligation: clears `remote_cancel_pending_at`
   * AND `remote_cancel_unresolved_at` (a late confirmation resolves an
   * honest residual). Only on a CONFIRMED outcome (see the schema doc);
   * returns whether a pending row was cleared.
   */
  clearRemoteCancelPending(runId: string): Promise<boolean>;
  /**
   * Declare a run's obligation UNRESOLVED (`remote_cancel_unresolved_at`):
   * the observation window elapsed with no confirmation from eve. The
   * pending marker is left in place (the obligation is honestly unmet), but
   * the sweeper stops re-opening observation for it. CAS on a still-pending,
   * not-yet-unresolved row; returns whether this call did it.
   */
  markRemoteCancelUnresolved(runId: string): Promise<boolean>;
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
          ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
          ...(patch.messageHash !== undefined
            ? { messageHash: patch.messageHash }
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

    async getRunTurnState(runId) {
      const rows = await db
        .select({
          status: schema.runs.status,
          turnId: schema.runs.turnId,
          messageHash: schema.runs.messageHash,
          remoteCancelPendingAt: schema.runs.remoteCancelPendingAt,
        })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);
      return rows[0] ?? null;
    },

    async setRunTurnId(runId, turnId) {
      const updated = await db
        .update(schema.runs)
        .set({ turnId })
        .where(
          and(
            eq(schema.runs.id, runId),
            or(isNull(schema.runs.turnId), eq(schema.runs.turnId, turnId)),
          ),
        )
        .returning({ id: schema.runs.id });
      return updated.length > 0;
    },

    async listPendingRemoteCancels(agentSessionId) {
      const rows = await db
        .select({
          runId: schema.runs.id,
          turnId: schema.runs.turnId,
          messageHash: schema.runs.messageHash,
          pendingAt: schema.runs.remoteCancelPendingAt,
          unresolvedAt: schema.runs.remoteCancelUnresolvedAt,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.agentSessionId, agentSessionId),
            // The marker alone defines an obligation: a Stop settles the row
            // `canceled`, the wall-clock cap / shutdown settle it `failed`
            // — both owe eve the same confirmation. Unresolved rows stay in
            // the list (still attributable), ranked last.
            isNotNull(schema.runs.remoteCancelPendingAt),
          ),
        )
        .orderBy(
          sql`${schema.runs.remoteCancelUnresolvedAt} IS NOT NULL`,
          asc(schema.runs.createdAt),
        );
      return rows.map((row) => ({
        runId: row.runId,
        turnId: row.turnId,
        messageHash: row.messageHash,
        pendingAt: row.pendingAt ?? new Date(0),
        unresolvedAt: row.unresolvedAt,
        createdAt: row.createdAt,
      }));
    },

    async listUnattributedLiveRuns(agentSessionId) {
      return db
        .select({
          runId: schema.runs.id,
          messageHash: schema.runs.messageHash,
          createdAt: schema.runs.createdAt,
        })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.agentSessionId, agentSessionId),
            inArray(schema.runs.status, ["queued", "running", "waiting"]),
            isNotNull(schema.runs.startedAt),
            isNull(schema.runs.turnId),
          ),
        )
        .orderBy(asc(schema.runs.createdAt));
    },

    async clearRemoteCancelPending(runId) {
      const updated = await db
        .update(schema.runs)
        .set({ remoteCancelPendingAt: null, remoteCancelUnresolvedAt: null })
        .where(
          and(eq(schema.runs.id, runId), isNotNull(schema.runs.remoteCancelPendingAt)),
        )
        .returning({ id: schema.runs.id });
      return updated.length > 0;
    },

    async markRemoteCancelUnresolved(runId) {
      const updated = await db
        .update(schema.runs)
        .set({ remoteCancelUnresolvedAt: new Date() })
        .where(
          and(
            eq(schema.runs.id, runId),
            isNotNull(schema.runs.remoteCancelPendingAt),
            isNull(schema.runs.remoteCancelUnresolvedAt),
          ),
        )
        .returning({ id: schema.runs.id });
      return updated.length > 0;
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
