import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema> & { $client: Sql };

export interface CreateDbOptions {
  /** Max pool connections (default 10; use 1 for scripts/tests). */
  max?: number;
}

/**
 * Create a Drizzle client for the product database.
 * Callers own the lifecycle: `await db.$client.end()` when done.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Db {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return drizzle(client, { schema });
}
