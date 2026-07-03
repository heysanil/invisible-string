/**
 * Apply pending migrations (idempotent). Defers to the canonical migrator in
 * `@invisible-string/db` (Better Auth tables + product tables live there).
 */
import { migrateDatabase } from "@invisible-string/db/migrate";

export async function runMigrations(databaseUrl: string): Promise<void> {
  await migrateDatabase(databaseUrl);
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
