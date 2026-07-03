/**
 * Apply pending drizzle migrations (idempotent). Used by integration tests
 * and at deploy time. Once `packages/db` ships the product schema + its own
 * migrator, this defers to that package's migrations instead.
 */
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("migrations applied");
}
