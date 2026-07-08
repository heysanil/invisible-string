/**
 * ensureDatabaseExists round-trip (gated like integration.test.ts: runs only
 * when TEST_DATABASE_URL is set, skips cleanly otherwise).
 *
 * The scenario it guards: a postgres volume that initialized WITHOUT the
 * image-level init script (docker created a directory over the script path),
 * leaving the server up but the target database missing — the migrator must
 * create it instead of failing with 3D000.
 */
import { describe, expect, test } from "bun:test";
import postgres from "postgres";

import { ensureDatabaseExists } from "./migrate";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.info(
    "[db] TEST_DATABASE_URL not set — skipping ensureDatabaseExists tests (integration stage provides it)",
  );
}

describe.if(Boolean(testDatabaseUrl))("ensureDatabaseExists", () => {
  test("creates a missing database, then no-ops when it exists", async () => {
    const dbName = `ensure_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const target = new URL(testDatabaseUrl!);
    target.pathname = `/${dbName}`;
    const url = target.toString();
    try {
      await ensureDatabaseExists(url); // creates
      await ensureDatabaseExists(url); // idempotent no-op

      const sql = postgres(url, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 as one`;
      expect(row?.one).toBe(1);
      await sql.end({ timeout: 5 });
    } finally {
      const maint = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
      await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await maint.end({ timeout: 5 });
    }
  });
});
