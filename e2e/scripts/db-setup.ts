/**
 * Fresh-database setup for the E2E harness — run under BUN.
 *
 *   drop + recreate the product DB → ensure the world maintenance DB →
 *   apply migrations → seed the demo user/org + locked workspace defaults.
 *
 * By default the product DB is CREATED IF MISSING and reused across boots so
 * the workflow_builds cache stays warm — the second of two consecutive
 * acceptance runs then hits the cache (a fast, idempotent republish) instead
 * of rebuilding. Set E2E_FRESH_DB=1 to drop + recreate it for a clean slate.
 * Fresh users/orgs per spec avoid cross-run data bleed either way; stale dead
 * worker rows are ignored by the scheduler's heartbeat TTL. World DBs
 * (ag_v_<hash>) persist and are content-addressed.
 *
 * Admin DDL goes through `createDb().$client` — the workspace db package's
 * postgres-js instance. (Bun's built-in SQL cannot open a socket to the
 * OrbStack-published port on this platform; postgres-js connects fine, and
 * routing through the db package keeps `postgres` out of e2e's direct deps.)
 */
import { createDb, migrateDatabase, seedDemo } from "@invisible-string/db";

import {
  ADMIN_DATABASE_URL,
  PRODUCT_DATABASE_URL,
  PRODUCT_DB_NAME,
} from "../config.ts";

const fresh = process.env.E2E_FRESH_DB === "1";
const admin = createDb(ADMIN_DATABASE_URL, { max: 1 });
try {
  if (fresh) {
    await admin.$client.unsafe(
      `drop database if exists "${PRODUCT_DB_NAME}" with (force)`,
    );
  }
  const product = await admin.$client.unsafe(
    `select 1 as one from pg_database where datname = '${PRODUCT_DB_NAME}'`,
  );
  if (product.length === 0) {
    await admin.$client.unsafe(`create database "${PRODUCT_DB_NAME}"`);
  }
  const world = await admin.$client.unsafe(
    `select 1 as one from pg_database where datname = 'world'`,
  );
  if (world.length === 0) await admin.$client.unsafe(`create database "world"`);
} finally {
  await admin.$client.end();
}

await migrateDatabase(PRODUCT_DATABASE_URL);

const db = createDb(PRODUCT_DATABASE_URL, { max: 1 });
try {
  const orgId = await seedDemo(db);
  console.log(`[e2e:db-setup] product DB ready + seeded demo org ${orgId}`);
} finally {
  await db.$client.end();
}
