import { describe, expect, test } from "bun:test";
import postgres from "postgres";

import { DB_PACKAGE } from "./index";

test("exports the package marker", () => {
  expect(DB_PACKAGE).toBe("@invisible-string/db");
});

// DB-dependent tests are gated: they skip cleanly unless the integration
// stage provides TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)(
  "postgres connectivity (set TEST_DATABASE_URL to run)",
  () => {
    test("SELECT 1 round-trips", async () => {
      const sql = postgres(testDatabaseUrl!, { max: 1 });
      try {
        const rows = await sql`select 1 as one`;
        expect(rows[0]?.one).toBe(1);
      } finally {
        await sql.end();
      }
    });
  },
);
