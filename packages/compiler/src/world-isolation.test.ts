/**
 * Gated proof of the world-isolation contract (design correction #10 /
 * WORLD-ISOLATION.md): ONE WORLD POSTGRES **DATABASE** PER WORKFLOW VERSION.
 *
 * @workflow/world-postgres@5.0.0-beta.20 hard-qualifies every identifier to
 * the `workflow` schema (drizzle `pgSchema("workflow")`; migrations run
 * `CREATE TABLE "workflow"."…"`), so a connection-string `search_path`
 * CANNOT redirect it — this test PROVES that, then proves that separate
 * databases on the same server DO isolate the run state that
 * `reenqueueActiveRuns` scans at boot.
 *
 * Gates: TEST_DATABASE_URL (compose Postgres; the user must be allowed to
 * CREATE DATABASE — the dev compose user is) + an installed
 * @workflow/world-postgres to run the real bootstrap. Resolution order:
 * WORLD_POSTGRES_PACKAGE_DIR env override, then spike/agent-project/
 * node_modules (committed lockfile installs it).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { SQL } from "bun";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const WORLD_POSTGRES_DIR =
  process.env.WORLD_POSTGRES_PACKAGE_DIR ??
  join(REPO_ROOT, "spike", "agent-project", "node_modules", "@workflow", "world-postgres");
const SETUP_BIN = join(WORLD_POSTGRES_DIR, "bin", "setup.js");

const GATE = Boolean(TEST_DATABASE_URL) && existsSync(SETUP_BIN);
const SKIP_REASON = !TEST_DATABASE_URL
  ? "requires TEST_DATABASE_URL (integration stage provides it)"
    : `requires @workflow/world-postgres at ${WORLD_POSTGRES_DIR} (npm ci spike/agent-project, or set WORLD_POSTGRES_PACKAGE_DIR)`;

function nodeBin(): string {
  const override = process.env.SPIKE_NODE24_BIN;
  if (override !== undefined && override.length > 0) return override;
  const installs = `${process.env.HOME}/.local/share/mise/installs/node`;
  if (existsSync(installs)) {
    const v24 = readdirSync(installs)
      .filter((dir) => dir.startsWith("24."))
      .sort()
      .at(-1);
    if (v24 !== undefined) return join(installs, v24, "bin", "node");
  }
  return "node";
}

function dbUrl(database: string, params = ""): string {
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = params;
  return url.toString();
}

async function adminSql<T>(query: string): Promise<T[]> {
  const sql = new SQL(TEST_DATABASE_URL!, { max: 1 });
  try {
    return (await sql.unsafe(query)) as T[];
  } finally {
    await sql.close();
  }
}

async function querySql<T>(url: string, query: string): Promise<T[]> {
  const sql = new SQL(url, { max: 1 });
  try {
    return (await sql.unsafe(query)) as T[];
  } finally {
    await sql.close();
  }
}

async function bootstrapWorld(worldUrl: string): Promise<void> {
  const proc = Bun.spawn([nodeBin(), SETUP_BIN], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: worldUrl, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`world-postgres bootstrap failed (${exitCode}):\n${stdout}\n${stderr}`);
  }
}

const RUN = Date.now().toString(36);
const DB_A = `wi_a_${RUN}`;
const DB_B = `wi_b_${RUN}`;

if (!GATE) console.log(`[world-isolation] skipped: ${SKIP_REASON}`);

describe.skipIf(!GATE)("world isolation (gated)", () => {
  afterAll(async () => {
    if (!GATE) return;
    for (const db of [DB_A, DB_B]) {
      await adminSql(`drop database if exists "${db}" with (force)`).catch(() => {});
    }
  });

  test(
    "search_path does NOT relocate world-postgres; a dedicated database DOES isolate",
    async () => {
      await adminSql(`create database "${DB_A}"`);
      await adminSql(`create database "${DB_B}"`);

      // ── Part 1: search_path is ignored by the qualified DDL ────────────
      // Pin search_path to a would-be per-version schema, then bootstrap.
      // ("<schema>,public" — with the pinned schema ALONE the bootstrap
      // crashes outright on the migration's unqualified enum-type reference,
      // which already disproves search_path isolation; including public lets
      // it finish so we can show where the tables actually land.)
      const pinnedSchema = "ws_v_deadbeef0000";
      await querySql(dbUrl(DB_A), `create schema "${pinnedSchema}"`);
      await bootstrapWorld(
        dbUrl(
          DB_A,
          `?options=${encodeURIComponent(`-csearch_path=${pinnedSchema},public`)}`,
        ),
      );

      const tables = await querySql<{ table_schema: string }>(
        dbUrl(DB_A),
        `select table_schema from information_schema.tables where table_name = 'workflow_runs'`,
      );
      // Tables land in the hard-coded "workflow" schema, NOT the pinned one:
      // schema-per-version via search_path is NOT honored by world-postgres.
      expect(tables.map((t) => t.table_schema)).toEqual(["workflow"]);
      const pinnedTables = await querySql<{ count: string | number }>(
        dbUrl(DB_A),
        `select count(*)::int as count from information_schema.tables where table_schema = '${pinnedSchema}'`,
      );
      expect(Number(pinnedTables[0]?.count)).toBe(0);

      // ── Part 2: database-per-version isolates boot re-enqueue state ────
      await bootstrapWorld(dbUrl(DB_B));
      // Plant an ACTIVE run in A — exactly what reenqueueActiveRuns re-drives
      // on every `eve start` boot, prefix or not (spike/REPORT.md finding 11).
      await querySql(
        dbUrl(DB_A),
        `insert into "workflow"."workflow_runs" (id, deployment_id, status, name, input)
         values ('run_isolation_proof', 'dep_a', 'running', 'wkf_test', '[]'::jsonb)`,
      );
      const inA = await querySql<{ count: string | number }>(
        dbUrl(DB_A),
        `select count(*)::int as count from "workflow"."workflow_runs" where status in ('pending', 'running')`,
      );
      const inB = await querySql<{ count: string | number }>(
        dbUrl(DB_B),
        `select count(*)::int as count from "workflow"."workflow_runs" where status in ('pending', 'running')`,
      );
      expect(Number(inA[0]?.count)).toBe(1);
      // A booting agent pointed at ITS OWN database sees no foreign runs.
      expect(Number(inB[0]?.count)).toBe(0);
    },
    300_000,
  );
});
