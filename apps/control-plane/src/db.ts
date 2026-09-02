/**
 * Product database client (postgres-js + drizzle), typed over the FULL
 * canonical schema from `@invisible-string/db` (Better Auth tables + product
 * tables; migrations live there too). Better Auth's adapter still receives
 * the narrower `authSchema` map explicitly (see auth.ts) — widening the
 * client's schema does not change auth behavior.
 *
 * THREE POOLS, ONE DATABASE. Every query rides the ROOT pool (`$client`,
 * `DB_POOL_SIZE`-sized, default 10). SESSION-level advisory locks pin one
 * physical connection for the lock's LIFETIME, so they never ride the root
 * pool — each family of long-held lock has its own small pool used for
 * nothing but `reserve()` + `pg_try_advisory_lock`/`unlock`:
 *
 *   - the per-session DISPATCH critical section (runtime/session-lock.ts)
 *     rides the LOCK pool (`$lockClient`, `DB_LOCK_POOL_SIZE`, default 8) —
 *     one pinned connection per in-flight eve dispatch (minutes on a cold
 *     agent boot);
 *   - the per-run PIPELINE driver lock (pipeline/runner.ts) rides the
 *     PIPELINE LOCK pool (`$pipelineLockClient`, `DB_PIPELINE_LOCK_POOL_SIZE`,
 *     default 32) — one pinned connection per LIVE pipeline run, for the
 *     driver's whole lifetime (up to `PIPELINE_MAX_WALL_CLOCK_MS`).
 *
 * The split is load-bearing: a holder pins its connection while its own
 * admission/marker/ledger/persist queries keep drawing from the pool. On one
 * shared pool, `max` concurrent holders reserve every connection and then
 * each waits for a `max+1`th that can never come — none reaches its
 * `finally`, and the whole control plane wedges (the D1 pool deadlock for
 * dispatches; the N3 deadlock for pipelines, where ten long concurrent runs
 * pinned all ten default root connections and every driver then blocked on
 * its own ledger query). The two lock families are ALSO kept apart from each
 * other on purpose: a burst of pipeline runs must never starve a chat Stop's
 * lock chase, and vice versa. Holders never consume root-pool capacity, and
 * root-pool users never wait on a lock pool while holding a root connection
 * (every acquisition happens strictly OUTSIDE any transaction, with a
 * BOUNDED reserve wait — the lock factories' shared contract).
 *
 * EVERY STATEMENT IS BOUNDED. All three pools connect with a Postgres
 * `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`, default 30 s — a startup
 * parameter, so it is per connection and survives pool rotation). The
 * bound is a LIVENESS guarantee the run tailer builds on (runs/tailer.ts
 * `seizedWriteBoundMs`): a write a seized tail had already issued is either
 * landed or DEAD (`57014 query_canceled`) once the timeout plus a margin
 * has elapsed, so a successor that waited that long can take the session's
 * cursor over from the persisted counts without a late write drifting it.
 * The lock pools carry it too — harmlessly: they run nothing but
 * `pg_try_advisory_lock`/`pg_advisory_unlock`, which never wait (both lock
 * families poll the TRY variant; runner.ts, runtime/session-lock.ts). The
 * transaction-scoped `pg_advisory_xact_lock` waits on the root pool (caps,
 * the Slack thread-key claim, the schedule claim, the workflow-state write)
 * are bounded by their holders' own short transactions, whose every
 * statement is itself bounded — a wait outlasting the timeout means a
 * pathological pile-up, and failing it loudly beats wedging. Migrations run
 * on `packages/db`'s own client and are deliberately NOT bounded.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "@invisible-string/db";

export type Db = PostgresJsDatabase<typeof schema> & {
  /** The ROOT pool — every query. */
  $client: postgres.Sql;
  /**
   * The LOCK pool — session-level advisory locks ONLY (see the module doc).
   * Optional in the type because a drizzle instance built elsewhere carries
   * no lock pool; `createDb` always attaches one, and the lock factory
   * refuses to fall back onto `$client` (that would reintroduce the D1
   * deadlock) — it becomes a no-op factory instead, which only single-
   * threaded fake-`db` fixtures ever see.
   */
  $lockClient?: postgres.Sql;
  /**
   * The PIPELINE LOCK pool — the per-run pipeline driver lock ONLY (see the
   * module doc). Optional for the same reason as `$lockClient`; the runner
   * refuses to fall back onto `$client` (that is the N3 deadlock) and
   * demands an injected lock factory instead.
   */
  $pipelineLockClient?: postgres.Sql;
};

/** The transaction client `db.transaction(async (tx) => …)` hands out. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Query surface common to the root client and a transaction client. */
export type DbClient = Db | DbTx;

export interface DbHandle {
  db: Db;
  /** Underlying postgres-js ROOT client — call `close()` to end all pools. */
  sql: postgres.Sql;
  /** The dedicated session-dispatch LOCK pool (see the module doc). */
  lockSql: postgres.Sql;
  /** The dedicated PIPELINE LOCK pool (see the module doc). */
  pipelineLockSql: postgres.Sql;
  close(): Promise<void>;
}

/** Root-pool size when `DB_POOL_SIZE`/`options.max` is absent. */
export const DEFAULT_DB_POOL_SIZE = 10;
/** Lock-pool size when `DB_LOCK_POOL_SIZE`/`options.lockMax` is absent. */
export const DEFAULT_DB_LOCK_POOL_SIZE = 8;
/**
 * Pipeline-lock-pool size when `DB_PIPELINE_LOCK_POOL_SIZE`/
 * `options.pipelineLockMax` is absent. Sized comfortably above a realistic
 * number of CONCURRENT live pipeline runs on one control plane: the pool
 * bounds them (a saturated pool refuses a new run fast — `startPipelineRun`
 * answers the transient `lock_pool_exhausted` skip — and defers boot
 * adoption to the next sweep), so it must sit above the workspace caps'
 * plausible sum, not at it.
 */
export const DEFAULT_DB_PIPELINE_LOCK_POOL_SIZE = 32;
/**
 * Per-statement bound when `DB_STATEMENT_TIMEOUT_MS`/`options.statementTimeoutMs`
 * is absent (module doc). Generous for any statement the control plane
 * issues (single-row CAS writes, a few-row reads by session id, short
 * advisory-locked transactions) while still bounding a seized tail's last
 * write to well under a minute.
 */
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * `DB_STATEMENT_TIMEOUT_MS` from an environment map — a positive integer,
 * else the default. There is deliberately no "off" value: the run tailer's
 * takeover bound is DERIVED from this number, and an unbounded statement
 * would void the guarantee it derives.
 */
export function statementTimeoutFromEnv(
  env: Record<string, string | undefined>,
): number {
  return positiveIntOr(env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_DB_STATEMENT_TIMEOUT_MS);
}

/**
 * `DB_LOCK_POOL_SIZE` from an environment map — a positive integer, else the
 * default. Bounds how many session dispatch critical sections one control
 * plane can hold at once; a saturated lock pool answers the transient
 * `session_busy` (the reserve is bounded, never a queue), so size it at or
 * above the expected number of concurrent eve dispatches.
 */
export function lockPoolSizeFromEnv(
  env: Record<string, string | undefined>,
): number {
  return positiveIntOr(env.DB_LOCK_POOL_SIZE, DEFAULT_DB_LOCK_POOL_SIZE);
}

/**
 * `DB_PIPELINE_LOCK_POOL_SIZE` from an environment map — a positive integer,
 * else the default. Bounds how many pipeline runs one control plane drives
 * at once; exhaustion is a fast, typed, transient refusal
 * (pipeline/runner.ts), never a queue and never a root-pool wait.
 */
export function pipelineLockPoolSizeFromEnv(
  env: Record<string, string | undefined>,
): number {
  return positiveIntOr(
    env.DB_PIPELINE_LOCK_POOL_SIZE,
    DEFAULT_DB_PIPELINE_LOCK_POOL_SIZE,
  );
}

/** `DB_POOL_SIZE` from an environment map — same rules as the lock pools. */
export function poolSizeFromEnv(
  env: Record<string, string | undefined>,
): number {
  return positiveIntOr(env.DB_POOL_SIZE, DEFAULT_DB_POOL_SIZE);
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Create a drizzle client over postgres-js. Connections open lazily on ALL
 * three pools; `close()` ends them together. Every connection of every pool
 * carries the `statement_timeout` startup parameter (module doc).
 */
export function createDb(
  databaseUrl: string,
  options?: {
    max?: number;
    lockMax?: number;
    pipelineLockMax?: number;
    statementTimeoutMs?: number;
  },
): DbHandle {
  const statementTimeoutMs =
    options?.statementTimeoutMs ?? DEFAULT_DB_STATEMENT_TIMEOUT_MS;
  // A startup parameter, not a per-session SET: postgres-js sends it in the
  // StartupMessage of every connection it opens, so a rotated or re-opened
  // pool connection is bounded from its first statement (milliseconds — a
  // bare integer is what Postgres reads the GUC as).
  const connection = { statement_timeout: statementTimeoutMs };
  const sql = postgres(databaseUrl, {
    max: options?.max ?? DEFAULT_DB_POOL_SIZE,
    connection,
    onnotice: () => {}, // silence NOTICE chatter (e.g. from migrations)
  });
  const lockSql = postgres(databaseUrl, {
    max: options?.lockMax ?? DEFAULT_DB_LOCK_POOL_SIZE,
    connection,
    onnotice: () => {},
  });
  const pipelineLockSql = postgres(databaseUrl, {
    max: options?.pipelineLockMax ?? DEFAULT_DB_PIPELINE_LOCK_POOL_SIZE,
    connection,
    onnotice: () => {},
  });
  const db = Object.assign(drizzle(sql, { schema }), {
    $lockClient: lockSql,
    $pipelineLockClient: pipelineLockSql,
  });
  return {
    db,
    sql,
    lockSql,
    pipelineLockSql,
    close: async () => {
      await Promise.all([
        sql.end({ timeout: 5 }),
        lockSql.end({ timeout: 5 }),
        pipelineLockSql.end({ timeout: 5 }),
      ]);
    },
  };
}
