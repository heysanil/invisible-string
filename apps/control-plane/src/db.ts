/**
 * Product database client (postgres-js + drizzle), typed over the FULL
 * canonical schema from `@invisible-string/db` (Better Auth tables + product
 * tables; migrations live there too). Better Auth's adapter still receives
 * the narrower `authSchema` map explicitly (see auth.ts) — widening the
 * client's schema does not change auth behavior.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "@invisible-string/db";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/** The transaction client `db.transaction(async (tx) => …)` hands out. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Query surface common to the root client and a transaction client. */
export type DbClient = Db | DbTx;

export interface DbHandle {
  db: Db;
  /** Underlying postgres-js client — call `end()` to close connections. */
  sql: postgres.Sql;
  close(): Promise<void>;
}

/** Create a drizzle client over postgres-js. Connections open lazily. */
export function createDb(
  databaseUrl: string,
  options?: { max?: number },
): DbHandle {
  const sql = postgres(databaseUrl, {
    max: options?.max ?? 10,
    onnotice: () => {}, // silence NOTICE chatter (e.g. from migrations)
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
