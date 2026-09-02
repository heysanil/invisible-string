/**
 * Product-DB client: the per-statement bound every pool connects with
 * (`DB_STATEMENT_TIMEOUT_MS`, db.ts module doc). The run tailer's takeover
 * and drain-eviction bounds are DERIVED from this number, so the proof that
 * it actually reaches the server — on every pool, as milliseconds, killing
 * a statement with `57014` and leaving the connection healthy — is the
 * foundation the tailer's liveness guarantee stands on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  createDb,
  statementTimeoutFromEnv,
  type DbHandle,
} from "./db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn("[db] TEST_DATABASE_URL not set — skipping the statement_timeout wire tests");
}

describe("statementTimeoutFromEnv", () => {
  test("a positive integer wins; anything else is the default — there is no off value", () => {
    expect(statementTimeoutFromEnv({ DB_STATEMENT_TIMEOUT_MS: "12000" })).toBe(12_000);
    expect(statementTimeoutFromEnv({ DB_STATEMENT_TIMEOUT_MS: " 7 " })).toBe(7);
    expect(statementTimeoutFromEnv({})).toBe(DEFAULT_DB_STATEMENT_TIMEOUT_MS);
    expect(statementTimeoutFromEnv({ DB_STATEMENT_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    );
    expect(statementTimeoutFromEnv({ DB_STATEMENT_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    );
    expect(statementTimeoutFromEnv({ DB_STATEMENT_TIMEOUT_MS: "off" })).toBe(
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)("createDb — every pool connects with statement_timeout", () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL!, {
      max: 1,
      lockMax: 1,
      pipelineLockMax: 1,
      statementTimeoutMs: 250,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  test("the bound is a startup parameter on the root, lock and pipeline-lock pools, in milliseconds", async () => {
    for (const sql of [handle.sql, handle.lockSql, handle.pipelineLockSql]) {
      const rows = await sql`show statement_timeout`;
      expect(rows[0]?.["statement_timeout"]).toBe("250ms");
    }
  });

  test("a statement outliving the bound dies with 57014 and the connection stays usable", async () => {
    const outcome = await handle.sql`select pg_sleep(2)`.then(
      () => "landed",
      (error: unknown) => (error as { code?: string }).code ?? "unknown",
    );
    expect(outcome).toBe("57014");
    const rows = await handle.sql`select 1 as ok`;
    expect(rows[0]?.["ok"]).toBe(1);
  });

  test("the default is DEFAULT_DB_STATEMENT_TIMEOUT_MS when no option is passed", async () => {
    const defaulted = createDb(TEST_DATABASE_URL!, { max: 1, lockMax: 1, pipelineLockMax: 1 });
    try {
      const rows = await defaulted.sql`show statement_timeout`;
      expect(rows[0]?.["statement_timeout"]).toBe(`${DEFAULT_DB_STATEMENT_TIMEOUT_MS / 1000}s`);
    } finally {
      await defaulted.close();
    }
  });
});
