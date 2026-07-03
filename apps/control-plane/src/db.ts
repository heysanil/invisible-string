/**
 * Product database client (postgres-js + drizzle), typed over the Better
 * Auth-managed tables re-exported from `@invisible-string/db` via
 * `./auth-schema` (canonical schema + migrations live in packages/db).
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
