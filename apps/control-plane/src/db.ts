/**
 * Product database client (postgres-js + drizzle).
 *
 * Currently carries the Better Auth-managed tables from `./auth-schema`;
 * when `packages/db` lands the full product schema + migrator, this switches
 * to importing the schema from there (single source of truth).
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { authSchema } from "./auth-schema";

export type Db = PostgresJsDatabase<typeof authSchema>;

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
  const db = drizzle(sql, { schema: authSchema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
