/**
 * Per-session DISPATCH CRITICAL SECTION (crash-window review family, final
 * fix): three decisions about one agent session used to race each other
 * because each was a separate read-then-act — successor ADMISSION (busy check
 * + run insert), the canceled-dispatch ABANDON (count successors → maybe
 * unqualified eve cancel), and the boot sweep CLOSE (nominate by ledger →
 * guarded UPDATE). The concrete failures: an abandon that found a successor
 * already admitted skipped its remote cancel and LEAKED the accepted eve turn;
 * a successor admitted after the count but before the unqualified
 * session-level cancel reached eve had ITS turn killed instead; and the sweep
 * could close a session a run had just been admitted into.
 *
 * The fix is a SESSION-level Postgres advisory lock keyed on the agent
 * session id, held by every dispatch that will call eve for that session
 * (create-on-session, continuation, post-reset create, HITL resume) from
 * before its admission/busy check through eve-return + persist +
 * terminal-recheck/abandon settlement — and TRY-acquired by every other
 * decision point (the guarded remote cancel, the boot sweep's eveless close).
 * Under the lock:
 *   - no successor can be admitted while a dispatch's abandon decision is in
 *     flight, so "a successor exists" and "the unqualified cancel might hit a
 *     successor's turn" are both impossible for lock-holding dispatches;
 *   - the sweep can never close a session whose dispatch is mid-flight (and
 *     its guarded UPDATE additionally re-asserts the ledger atomically).
 *
 * MECHANICS (the repo precedent is the pipeline runner's per-run lock,
 * pipeline/runner.ts `createPgPipelineLockFactory`): a SESSION-level advisory
 * lock lives on one physical Postgres connection, and postgres.js rotates
 * pool connections per query — so acquire and release ride a connection
 * RESERVED for the lock's lifetime (`sql.reserve()`). A session-level lock
 * dies with its connection, so a crashed control plane self-heals: the row
 * state the crash left behind is then owned by boot reconciliation, whose
 * predicates (dispatch-attempt marker, `countDispatchingRuns`' canceled-mid-
 * dispatch arm) deliberately survive as the lock's crash-safe shadow.
 *
 * Contention answers the platform's own TRANSIENT 409 `session_busy` (the
 * two-409s rule): the lock only widens what "busy" means — "a dispatch or its
 * settlement is in flight on this session" — it never changes the recovery
 * (wait, retry).
 *
 * Scope discipline: the lock is held across the eve call and its settlement
 * ONLY — never across a tail (startTail registers and returns; the tail runs
 * lock-free).
 */
import type postgres from "postgres";
import type { Logger } from "@invisible-string/shared";

/** A held per-session dispatch lock. `release()` is idempotent. */
export interface SessionDispatchLock {
  release(): Promise<void>;
}

export interface SessionDispatchLockFactory {
  /**
   * Acquire the session's dispatch lock, waiting up to `waitMs` (default 0 —
   * a pure try). Null when the lock is still held at the deadline.
   */
  acquire(
    agentSessionId: string,
    options?: { waitMs?: number; pollMs?: number },
  ): Promise<SessionDispatchLock | null>;
}

/**
 * How long an ADMISSION-path acquire waits before answering `session_busy`.
 * Short on purpose: a holder is mid-dispatch (possibly a long agent boot),
 * and the caller's recovery is the ordinary transient-409 retry — the wait
 * only absorbs sub-second settlement tails.
 */
export const SESSION_LOCK_ADMISSION_WAIT_MS = 250;

/**
 * How long a NEW-session dispatch waits for its own just-inserted session's
 * lock. Contenders here can only be dispatchers that found the fresh row
 * (e.g. via its Slack thread key) after commit; each fails its own busy check
 * against the queued run and releases within one transaction, so a couple of
 * seconds is generous.
 */
export const SESSION_LOCK_FRESH_SESSION_WAIT_MS = 2_000;

/**
 * How long a DEFERRED guarded remote cancel keeps trying in the background
 * when a dispatch holds the session (routes.ts `cancelEveTurnGuarded`). Must
 * outlast the longest lock hold: ensure-agent (2 × 60 s cold boot) + the eve
 * call (60 s) + settlement.
 */
export const SESSION_LOCK_DEFERRED_CANCEL_WAIT_MS = 5 * 60 * 1000;

const DEFAULT_POLL_MS = 25;

function lockKey(agentSessionId: string): string {
  return `session-dispatch:${agentSessionId}`;
}

/**
 * The production factory: `pg_try_advisory_lock(hashtext(key)::bigint)` on a
 * reserved postgres-js connection, polled until acquired or the deadline
 * passes. The reservation is released the moment acquisition fails, and on
 * `release()` after the unlock.
 */
export function createPgSessionDispatchLocks(
  sql: postgres.Sql,
  logger?: Logger,
): SessionDispatchLockFactory {
  return {
    async acquire(agentSessionId, options) {
      const waitMs = options?.waitMs ?? 0;
      const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
      const key = lockKey(agentSessionId);
      const deadline = Date.now() + waitMs;
      // Reserve PER ATTEMPT, not for the whole wait: a waiter (notably the
      // guarded cancel's deferred background chase) must not pin a pool
      // connection for the minutes a lock hold can last — only the WINNING
      // attempt keeps its reservation, for the lock's lifetime.
      let reserved: Awaited<ReturnType<postgres.Sql["reserve"]>> | null = null;
      for (;;) {
        const attempt = await sql.reserve();
        let locked = false;
        try {
          const rows =
            await attempt`select pg_try_advisory_lock(hashtext(${key})::bigint) as locked`;
          locked = rows[0]?.["locked"] === true;
        } finally {
          if (!locked) attempt.release();
        }
        if (locked) {
          reserved = attempt;
          break;
        }
        if (Date.now() >= deadline) break;
        await Bun.sleep(pollMs);
      }
      if (!reserved) {
        logger?.debug("session.dispatch_lock_contended", {
          sessionId: agentSessionId,
          fields: { waitMs },
        });
        return null;
      }
      logger?.debug("session.dispatch_lock_acquired", {
        sessionId: agentSessionId,
      });
      const held = reserved;
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await held`select pg_advisory_unlock(hashtext(${key})::bigint)`;
          } finally {
            held.release();
          }
          logger?.debug("session.dispatch_lock_released", {
            sessionId: agentSessionId,
          });
        },
      };
    },
  };
}

/** Always-succeeding no-op locks — see {@link sessionDispatchLocksOf}. */
const NOOP_LOCKS: SessionDispatchLockFactory = {
  async acquire() {
    return { async release() {} };
  },
};

/**
 * The dispatch surface's lock source: the pg factory over the runtime deps'
 * own postgres-js client. Focused unit fixtures that cast a fake `db` into
 * `RuntimeDeps` (no `$client.reserve`) get a NO-OP factory — they are
 * single-threaded fakes with no concurrency to serialize; every DB-gated and
 * production path carries a real `Db`, whose type guarantees `$client`.
 */
export function sessionDispatchLocksOf(deps: {
  db: unknown;
  logger: Logger;
}): SessionDispatchLockFactory {
  const client = (deps.db as { $client?: postgres.Sql } | undefined)?.$client;
  if (client && typeof client.reserve === "function") {
    return createPgSessionDispatchLocks(client, deps.logger);
  }
  return NOOP_LOCKS;
}
