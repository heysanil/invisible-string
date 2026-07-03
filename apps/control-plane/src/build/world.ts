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
