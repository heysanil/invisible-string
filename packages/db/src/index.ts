/**
 * @invisible-string/db — product database package.
 *
 * - `schema/*`: Drizzle schema (Better Auth tables + product tables, spec §9)
 * - `client`: `createDb(url)` typed drizzle client factory
 * - `migrate`: programmatic migrator over ./migrations (drizzle-kit output)
 * - `seed`: idempotent workspace seeds (`seedWorkspace`) + demo bootstrap
 */
export * as schema from "./schema";
export * from "./client";
export {
  ensureDatabaseExists,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  runMigrations,
} from "./migrate";
export {
  DEFAULT_AGENT_PRESETS,
  DEFAULT_MODEL_PRESETS,
  DEMO_ORG,
  DEMO_USER,
  buildAgentPresetRows,
  buildAllowlistRows,
  buildModelPresetRows,
  seedDemo,
  seedWorkspace,
  type AgentPresetSeed,
  type ModelPresetSeed,
} from "./seed";
