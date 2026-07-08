/**
 * Apply pending migrations (idempotent). Defers to the canonical migrator in
 * `@invisible-string/db` (Better Auth tables + product tables live there).
 */
import {
  ensureDatabaseExists,
  migrateDatabase,
} from "@invisible-string/db/migrate";

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
  // The world maintenance DB carries no migrations of its own — it just has
  // to exist before the runtime's world provisioner first connects.
  const worldUrl = process.env.WORLD_DATABASE_URL;
  if (worldUrl) await ensureDatabaseExists(worldUrl);
  console.log("migrations applied");
}
