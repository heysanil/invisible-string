/**
 * Programmatic migrator. Applies the SQL migrations committed under
 * packages/db/migrations (generated with `bun run generate` / drizzle-kit).
 *
 * CLI: DATABASE_URL=postgres://… bun run src/migrate.ts
 */
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { createDb, type Db } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** Apply all pending migrations using an existing client. Idempotent. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Create the URL's database when the server does not have it yet. No-op when
 * it exists. Covers first boots where image-level init never ran (e.g. a
 * postgres volume initialized while the init script was missing) and restores
 * of one database without its siblings. Creation goes through a maintenance
 * database on the same server: the role's own DB (postgres-image convention),
 * then `postgres`. Managed servers where the databases are pre-created never
 * reach the CREATE path.
 */
export async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!dbName) return;

  const probe = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    return;
  } catch (error) {
    // 3D000 invalid_catalog_name = "database does not exist"; anything else
    // (server down, bad credentials) is the caller's problem.
    if ((error as { code?: string }).code !== "3D000") throw error;
  } finally {
    await probe.end({ timeout: 5 });
  }

  const candidates = [
    ...new Set([decodeURIComponent(target.username) || "postgres", "postgres"]),
  ];
  const failures: string[] = [];
  for (const maintenanceDb of candidates) {
    const maintenanceUrl = new URL(url);
    maintenanceUrl.pathname = `/${maintenanceDb}`;
    const sql = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => {},
    });
    try {
      await sql.unsafe(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
      return;
    } catch (error) {
      // 42P04 duplicate_database: another boot created it concurrently — done.
      if ((error as { code?: string }).code === "42P04") return;
      failures.push(
        `via "${maintenanceDb}": ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  throw new Error(
    `database "${dbName}" does not exist and could not be created (${failures.join("; ")})`,
  );
}

/**
 * Connect to `url`, apply all pending migrations, and close the connection.
 * Creates the database first when the server lacks it (see above).
 */
export async function migrateDatabase(url: string): Promise<void> {
  await ensureDatabaseExists(url);
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
