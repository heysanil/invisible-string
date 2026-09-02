/**
 * Product database client (postgres-js + drizzle), typed over the FULL
 * canonical schema from `@invisible-string/db` (Better Auth tables + product
 * tables; migrations live there too). Better Auth's adapter still receives
 * the narrower `authSchema` map explicitly (see auth.ts) — widening the
 * client's schema does not change auth behavior.
 *
 * TWO POOLS, ONE DATABASE. Every query rides the ROOT pool (`$client`,
 * `DB_POOL_SIZE`-sized, default 10). SESSION-level advisory locks — the
 * per-session dispatch critical section (runtime/session-lock.ts) — ride a
 * SEPARATE, small LOCK pool (`$lockClient`, `DB_LOCK_POOL_SIZE`, default 8)
 * used for nothing but `reserve()` + `pg_try_advisory_lock`/`unlock`. The
 * split is load-bearing: a session lock pins one physical connection for
 * the lock's lifetime (a dispatch's whole eve round-trip, minutes on a cold
 * agent boot) while the holder's own admission/marker/persist queries keep
 * drawing from the pool. On one shared pool, `max` concurrent dispatches
 * reserve every connection and then each waits for a `max+1`th that can
 * never come — none reaches its `finally`, and the whole control plane wedges
 * (the D1 pool deadlock). With the lock pool apart, holders never consume
 * root-pool capacity, and root-pool users never wait on the lock pool while
 * holding a root connection (acquisition happens strictly OUTSIDE any
 * transaction — the lock factory's contract).
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
};

/** The transaction client `db.transaction(async (tx) => …)` hands out. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Query surface common to the root client and a transaction client. */
export type DbClient = Db | DbTx;

export interface DbHandle {
  db: Db;
  /** Underlying postgres-js ROOT client — call `close()` to end both pools. */
  sql: postgres.Sql;
  /** The dedicated LOCK pool (see the module doc). */
  lockSql: postgres.Sql;
  close(): Promise<void>;
}

/** Root-pool size when `DB_POOL_SIZE`/`options.max` is absent. */
export const DEFAULT_DB_POOL_SIZE = 10;
/** Lock-pool size when `DB_LOCK_POOL_SIZE`/`options.lockMax` is absent. */
export const DEFAULT_DB_LOCK_POOL_SIZE = 8;

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

/** `DB_POOL_SIZE` from an environment map — same rules as the lock pool. */
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
 * Create a drizzle client over postgres-js. Connections open lazily on BOTH
 * pools; `close()` ends both.
 */
export function createDb(
  databaseUrl: string,
  options?: { max?: number; lockMax?: number },
): DbHandle {
  const sql = postgres(databaseUrl, {
    max: options?.max ?? DEFAULT_DB_POOL_SIZE,
    onnotice: () => {}, // silence NOTICE chatter (e.g. from migrations)
  });
  const lockSql = postgres(databaseUrl, {
    max: options?.lockMax ?? DEFAULT_DB_LOCK_POOL_SIZE,
    onnotice: () => {},
  });
  const db = Object.assign(drizzle(sql, { schema }), { $lockClient: lockSql });
  return {
    db,
    sql,
    lockSql,
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), lockSql.end({ timeout: 5 })]);
    },
  };
}
