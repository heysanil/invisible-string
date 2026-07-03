/**
 * World isolation: ONE WORLD POSTGRES *DATABASE* PER WORKFLOW VERSION.
 *
 * Design correction #10 mandates "one world Postgres schema per workflow
 * version" because WORKFLOW_POSTGRES_JOB_PREFIX does NOT isolate agents
 * sharing a world DB (spike/REPORT.md finding 11: `reenqueueActiveRuns`
 * re-drives OTHER agents' runs on boot).
 *
 * MECHANISM NOTE — why a database and not a `search_path` pg schema:
 * `@workflow/world-postgres@5.0.0-beta.20` hardcodes its pg schema in the
 * drizzle table definitions (`pgSchema('workflow')` in dist/drizzle/schema.js
 * — verified against the installed package), so every query is
 * schema-QUALIFIED (`"workflow"."workflow_runs"`) and `search_path` cannot
 * redirect it; graphile-worker likewise installs into its own `graphile_worker`
 * schema. A per-version `CREATE SCHEMA ws_v_<hash12>` + search_path would
 * LOOK isolated while every version still shared `workflow.*` — silent
 * cross-agent re-enqueue, the exact bug we must prevent. A dedicated
 * DATABASE per version gives real isolation with the same naming contract.
 *
 * NOTE(integration): packages/compiler's WORLD-ISOLATION.md did not exist
 * when this was written (compiler is built in parallel). This module is the
 * control-plane implementation of the correction-#10 contract:
 *   WORKFLOW_POSTGRES_URL = <world server>/ws_v_<hash12>
 * If the compiler doc lands with a different mechanism, reconcile HERE (the
 * naming + provisioning entrypoints are the only touch points).
 *
 * Provisioning runs on the FIRST build of a version (build service step):
 *   1. CREATE DATABASE "ws_v_<hash12>" (idempotent via pg_database check)
 *   2. run @workflow/world-postgres setupDatabase against it (the built
 *      project's own node_modules — exact pinned beta), which creates the
 *      `workflow` schema tables + graphile_worker (REPORT finding 8).
 */
import { join } from "node:path";

import { SQL } from "bun";

/** ws_v_<first 12 hex chars> — stable, valid unquoted pg identifier. */
export function worldNameForHash(contentHash: string): string {
  const cleaned = contentHash.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length < 12) {
    throw new Error(`content hash too short for a world name: "${contentHash}"`);
  }
  return `ws_v_${cleaned.slice(0, 12)}`;
}

/** Point a world-server URL at a specific per-version database. */
export function worldUrlFor(worldServerUrl: string, worldName: string): string {
  const url = new URL(worldServerUrl);
  url.pathname = `/${worldName}`;
  return url.toString();
}

export interface WorldProvisioner {
  /**
   * Ensure the version's world database exists and is bootstrapped.
   * `projectDir` is the built agent project (its node_modules carries the
   * exact-pinned @workflow/world-postgres whose setupDatabase must run).
   */
  ensure(contentHash: string, projectDir: string): Promise<{ worldName: string; url: string }>;
}

export interface CreateWorldProvisionerOptions {
  /** Maintenance connection (WORLD_DATABASE_URL). */
  worldDatabaseUrl: string;
  /**
   * Runs world-postgres setupDatabase with WORKFLOW_POSTGRES_URL pointed at
   * the new database. Injectable so unit tests need no Postgres/node.
   */
  runSetupDatabase: (projectDir: string, worldUrl: string) => Promise<void>;
}

const VALID_WORLD_NAME = /^ws_v_[a-z0-9]{12}$/;

/** Ownership marker table inside each world database (collision guard). */
const WORLD_OWNER_TABLE = "_invisible_string_world_owner";

/**
 * Does the version's world database exist? Used by the build service's
 * cache-hit path: a retired-then-republished version whose world DB was
 * dropped must NOT short-circuit to the cached artifact — the agent would
 * boot against a nonexistent database (WORLD-ISOLATION cleanup story).
 */
export async function worldDatabaseExists(
  worldDatabaseUrl: string,
  contentHash: string,
): Promise<boolean> {
  const worldName = worldNameForHash(contentHash);
  const sql = new SQL(worldDatabaseUrl, { max: 1 });
  try {
    const rows = (await sql`
      select 1 as one from pg_database where datname = ${worldName}
    `) as unknown[];
    return rows.length > 0;
  } finally {
    await sql.close();
  }
}

/**
 * Record/verify which FULL content hash owns this world database.
 * worldNameForHash truncates to 12 hex chars (48 bits) — a truncation
 * collision between two versions would silently make them SHARE one world
 * (re-introducing the cross-version reenqueueActiveRuns bug the
 * database-per-version contract exists to prevent, REPORT finding 11).
 * Improbable, but the failure mode is silent and catastrophic — so ensure()
 * fails LOUDLY instead.
 */
async function assertWorldOwnership(worldUrl: string, contentHash: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(contentHash)) {
    throw new Error(`content hash contains unexpected characters: "${contentHash}"`);
  }
  const sql = new SQL(worldUrl, { max: 1 });
  try {
    await sql.unsafe(
      `create table if not exists "${WORLD_OWNER_TABLE}" (content_hash text primary key)`,
    );
    // Insert-if-empty, race-safe: concurrent first-provisioners both insert
    // their (identical) hash; conflict is ignored, then the row is re-read.
    await sql.unsafe(
      `insert into "${WORLD_OWNER_TABLE}" (content_hash)
       select '${contentHash}'
       where not exists (select 1 from "${WORLD_OWNER_TABLE}")
       on conflict do nothing`,
    );
    const rows = (await sql.unsafe(
      `select content_hash from "${WORLD_OWNER_TABLE}" limit 1`,
    )) as { content_hash: string }[];
    const owner = rows[0]?.content_hash;
    if (owner !== contentHash) {
      throw new Error(
        `world database ${worldNameForHash(contentHash)} is owned by version ` +
          `${owner ?? "(unknown)"} but version ${contentHash} resolved the same ` +
          `truncated name — 12-char world-name collision; refusing to share a world database`,
      );
    }
  } finally {
    await sql.close();
  }
}

export function createWorldProvisioner(
  options: CreateWorldProvisionerOptions,
): WorldProvisioner {
  return {
    async ensure(contentHash, projectDir) {
      const worldName = worldNameForHash(contentHash);
      if (!VALID_WORLD_NAME.test(worldName)) {
        throw new Error(`invalid world name: ${worldName}`);
      }
      const url = worldUrlFor(options.worldDatabaseUrl, worldName);

      const sql = new SQL(options.worldDatabaseUrl, { max: 1 });
      try {
        const existing = (await sql`
          select 1 as one from pg_database where datname = ${worldName}
        `) as unknown[];
        if (existing.length === 0) {
          // CREATE DATABASE cannot run in a transaction and has no
          // IF NOT EXISTS — a concurrent duplicate-create loses the race with
          // a unique violation, which we treat as "already provisioned".
          try {
            await sql.unsafe(`create database "${worldName}"`);
          } catch (error) {
            const recheck = (await sql`
              select 1 as one from pg_database where datname = ${worldName}
            `) as unknown[];
            if (recheck.length === 0) throw error;
          }
        }
      } finally {
        await sql.close();
      }

      // An existing pg_database row is NOT proof of ownership — verify the
      // full hash before touching it (loud failure on truncation collision).
      await assertWorldOwnership(url, contentHash);

      // setupDatabase is idempotent (drizzle migration journal + graphile
      // installSchema), safe to run on every first-build.
      await options.runSetupDatabase(projectDir, url);

      return { worldName, url };
    },
  };
}

/** Path of world-postgres' setup entrypoint inside a built project. */
export function worldSetupBinPath(projectDir: string): string {
  return join(projectDir, "node_modules", "@workflow", "world-postgres", "bin", "setup.js");
}
