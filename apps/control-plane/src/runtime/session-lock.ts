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
 * decision point (the guarded remote cancel, the boot sweeps). Under the
 * lock:
 *   - no successor can be admitted while a dispatch's abandon decision is in
 *     flight, so "a successor exists" and "the unqualified cancel might hit a
 *     successor's turn" are both impossible for lock-holding dispatches;
 *   - a HOLDER is the session's exclusive owner: whatever the row predicates
 *     say, no other dispatch is in flight on it this instant — which is what
 *     lets a lock-holding dispatch close an abandoned eveless session inline
 *     instead of answering `session_busy` forever (dispatch.ts
 *     `healAbandonedEvelessSession`);
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
 * dispatch arm, the `remote_cancel_pending_at` obligation) deliberately
 * survive as the lock's crash-safe shadow.
 *
 * POOL DISCIPLINE (the D1 deadlock). The reserved connection comes from the
 * DEDICATED LOCK POOL (`Db.$lockClient`, db.ts) — never the root pool. A
 * holder pins its connection for the whole eve round-trip while its own
 * admission/marker/persist queries keep drawing from the ROOT pool; on one
 * shared pool, `max` concurrent dispatches reserved every connection and
 * then each waited for a `max+1`th that could never come — none reached its
 * `finally`. Two rules follow, both enforced here:
 *   1. the lock factory refuses to fall back onto `$client` (a `Db` without
 *      a lock pool gets a NO-OP factory, which only single-threaded fake-db
 *      unit fixtures ever see);
 *   2. `acquire()` MUST be called with NO open root-pool transaction — every
 *      caller takes the lock strictly before its `db.transaction(...)`. The
 *      reserve wait is BOUNDED (`SESSION_LOCK_RESERVE_TIMEOUT_MS`) and a
 *      saturated lock pool reads as contention (null → the caller's
 *      transient `session_busy`), never as a queue a root connection could
 *      be waiting in.
 *
 * Contention answers the platform's own TRANSIENT 409 `session_busy` (the
 * two-409s rule): the lock only widens what "busy" means — "a dispatch or its
 * settlement is in flight on this session" — it never changes the recovery
 * (wait, retry).
 *
 * Scope discipline: the lock is held across the eve call and its settlement
 * ONLY — never across a tail (startTail registers and returns; the tail runs
 * lock-free), and never across the OBSERVATION that follows a Stop
 * (runs/tailer.ts). There is no live-tail-Stop exception any more: that hold
 * existed so an UNQUALIFIED cancel could not land on a successor's turn once
 * admission reopened, and the live tail never sends one now — it issues a
 * turn-QUALIFIED cancel when it knows the turn and nothing otherwise, so a
 * late cancel can only ever name the settled run's own turn. The no-tail
 * Stop's obligation settlement (`settleRemoteCancelGuarded`) still
 * try-acquires the lock, purely to decide against a fresh session/run read
 * that no dispatch is mutating mid-flight.
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
   * a pure try). Null when the lock is still held at the deadline, OR when
   * the lock pool could not hand out a connection within
   * {@link SESSION_LOCK_RESERVE_TIMEOUT_MS} (capacity exhaustion is
   * transient and reads as contention). MUST be called outside any root-pool
   * transaction (module doc, pool discipline rule 2).
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
 * How long a NEW-session dispatch waits for its PRE-MINTED session's lock.
 * The id is minted app-side and nobody else can know it before the claim
 * transaction commits, so the lock is uncontended by construction — only
 * lock-pool pressure can delay it, and a timeout means NOTHING was created
 * (the caller answers the transient `session_busy` with nothing to undo).
 */
export const SESSION_LOCK_FRESH_SESSION_WAIT_MS = 2_000;

/**
 * How long a DEFERRED obligation settlement keeps trying in the background
 * when a dispatch holds the session (routes.ts `settleRemoteCancelGuarded`). Must
 * outlast the longest lock hold: ensure-agent (2 × 60 s cold boot) + the eve
 * call (60 s) + settlement. The obligation is ALSO durable
 * (`runs.remote_cancel_pending_at`), so a crash mid-deferral is finished by
 * boot reconciliation and the periodic remote-cancel sweep (reconcile.ts
 * `createRemoteCancelSweeper`, `REMOTE_CANCEL_SWEEP_MS`) — the background
 * chase is the fast path, not the guarantee. The wait GENUINELY spans this
 * bound: a saturated lock pool (N2) is retried with backoff until the
 * deadline, not abandoned after one reserve timeout.
 */
export const SESSION_LOCK_DEFERRED_CANCEL_WAIT_MS = 5 * 60 * 1000;

/**
 * Bound on ONE `reserve()` against the lock pool. Exhaustion (every lock
 * connection pinned by a holder) is transient — holders release at
 * settlement — so a waiter with no wait budget answers `session_busy`
 * rather than queueing; a waiter WITH a budget (the deferred chase) backs
 * off and reserves again until its deadline.
 */
export const SESSION_LOCK_RESERVE_TIMEOUT_MS = 2_000;

/** Longest pause between two reserve attempts on an exhausted lock pool. */
export const SESSION_LOCK_EXHAUSTED_BACKOFF_MAX_MS = 1_000;

const DEFAULT_POLL_MS = 25;

function lockKey(agentSessionId: string): string {
  return `session-dispatch:${agentSessionId}`;
}

type Reserved = Awaited<ReturnType<postgres.Sql["reserve"]>>;

/**
 * `sql.reserve()` bounded by `timeoutMs`. postgres-js queues reservations
 * indefinitely when the pool is exhausted; here a late reservation is
 * released the moment it arrives and the caller sees null instead. Shared
 * with the pipeline runner's per-run lock factory (pipeline/runner.ts) —
 * every long-held advisory lock in the control plane reserves through this
 * bound, so no pool wait is ever open-ended.
 */
export async function reserveBounded(
  sql: postgres.Sql,
  timeoutMs: number,
): Promise<Reserved | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = sql.reserve();
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const won = await Promise.race([pending, timeout]);
    if (won !== null) return won;
    // Lost the race: whenever the queued reservation lands, hand it straight
    // back — nobody is waiting for it any more.
    void pending.then((late) => late.release()).catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production factory: `pg_try_advisory_lock(hashtext(key)::bigint)` on a
 * reserved connection of the LOCK pool, polled until acquired or the deadline
 * passes. The reservation is released the moment acquisition fails, and on
 * `release()` after the unlock.
 */
export function createPgSessionDispatchLocks(
  lockSql: postgres.Sql,
  logger?: Logger,
  options: { reserveTimeoutMs?: number } = {},
): SessionDispatchLockFactory {
  const reserveTimeoutMs =
    options.reserveTimeoutMs ?? SESSION_LOCK_RESERVE_TIMEOUT_MS;
  return {
    async acquire(agentSessionId, options) {
      const waitMs = options?.waitMs ?? 0;
      const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
      const key = lockKey(agentSessionId);
      const deadline = Date.now() + waitMs;
      // Reserve PER ATTEMPT, not for the whole wait: a waiter (notably the
      // guarded cancel's deferred background chase) must not pin a lock-pool
      // connection for the minutes a lock hold can last — only the WINNING
      // attempt keeps its reservation, for the lock's lifetime.
      let reserved: Reserved | null = null;
      let exhaustedBackoffMs = pollMs;
      for (;;) {
        const attempt = await reserveBounded(lockSql, reserveTimeoutMs);
        if (!attempt) {
          // POOL EXHAUSTED (N2): every lock connection is pinned by a holder.
          // A waiter with no budget left reads it as contention; a waiter
          // with budget — the deferred remote-cancel chase, bounded at
          // minutes — backs off and reserves again, so the chase genuinely
          // spans its bound instead of giving up after one reserve timeout
          // and stranding the obligation until the sweep or a restart.
          if (Date.now() >= deadline) {
            logger?.warn("session.dispatch_lock_pool_exhausted", {
              sessionId: agentSessionId,
              fields: { reserveTimeoutMs, waitMs },
            });
            return null;
          }
          logger?.debug("session.dispatch_lock_pool_exhausted_retry", {
            sessionId: agentSessionId,
            fields: { backoffMs: exhaustedBackoffMs },
          });
          await Bun.sleep(exhaustedBackoffMs);
          exhaustedBackoffMs = Math.min(
            exhaustedBackoffMs * 2,
            SESSION_LOCK_EXHAUSTED_BACKOFF_MAX_MS,
          );
          continue;
        }
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

/** One pg factory per lock pool (the deps object is rebuilt per test). */
const FACTORIES = new WeakMap<postgres.Sql, SessionDispatchLockFactory>();

/**
 * The dispatch surface's lock source: the pg factory over the runtime deps'
 * DEDICATED lock pool (`Db.$lockClient`, attached by db.ts `createDb`). A
 * `db` without a lock pool — focused unit fixtures that cast a fake `db`
 * into `RuntimeDeps` — gets a NO-OP factory: they are single-threaded fakes
 * with no concurrency to serialize. Deliberately NO fallback onto
 * `$client`: locks on the root pool are the D1 deadlock (module doc).
 */
export function sessionDispatchLocksOf(deps: {
  db: unknown;
  logger: Logger;
}): SessionDispatchLockFactory {
  const lockClient = (deps.db as { $lockClient?: postgres.Sql } | undefined)
    ?.$lockClient;
  if (lockClient && typeof lockClient.reserve === "function") {
    let factory = FACTORIES.get(lockClient);
    if (!factory) {
      factory = createPgSessionDispatchLocks(lockClient, deps.logger);
      FACTORIES.set(lockClient, factory);
    }
    return factory;
  }
  return NOOP_LOCKS;
}
