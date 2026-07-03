/**
 * Programmatic migrator. Applies the SQL migrations committed under
 * packages/db/migrations (generated with `bun run generate` / drizzle-kit).
 *
 * CLI: DATABASE_URL=postgres://… bun run src/migrate.ts
 */
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDb, type Db } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** Apply all pending migrations using an existing client. Idempotent. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Connect to `url`, apply all pending migrations, and close the connection. */
export async function migrateDatabase(url: string): Promise<void> {
  const db = createDb(url, { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set to run migrations");
    process.exit(1);
  }
  await migrateDatabase(url);
  console.log("migrations applied");
}
