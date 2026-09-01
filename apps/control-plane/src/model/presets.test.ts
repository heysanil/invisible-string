/**
 * Shared preset resolution (extracted from the session titler when `infer`
 * steps became the second caller). The slug guard runs ungated — it must
 * short-circuit BEFORE the pgEnum comparison, or an unknown slug becomes a
 * Postgres enum error instead of "not found". Row resolution is DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { createDb, type Db, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import { resolvePresetModel } from "./presets";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("resolvePresetModel slug guard", () => {
  test("an unknown slug resolves null without touching the db", async () => {
    // The poisoned db proves the query was never issued.
    const poisonedDb = null as unknown as Db;
    expect(await resolvePresetModel(poisonedDb, "org", "warp-speed")).toBeNull();
    expect(await resolvePresetModel(poisonedDb, "org", "")).toBeNull();
  });
});

if (!TEST_DATABASE_URL) {
  console.warn(
    "[model-presets] TEST_DATABASE_URL not set — skipping preset resolution tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("resolvePresetModel", () => {
  let handle: DbHandle;
  let orgId: string;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    orgId = `org-presets-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Presets Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await handle.db.insert(schema.modelPresets).values({
      organizationId: orgId,
      slug: "quick",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });
  }, 30_000);

  afterAll(async () => {
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.close();
  }, 15_000);

  test("resolves provider, model id AND reasoning effort — all three are the preset", async () => {
    expect(await resolvePresetModel(handle.db, orgId, "quick")).toEqual({
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });
  });

  test("a valid slug with no row resolves null (workspace never seeded it)", async () => {
    expect(await resolvePresetModel(handle.db, orgId, "powerful")).toBeNull();
  });

  test("presets are workspace-scoped — another org's quick is invisible", async () => {
    expect(
      await resolvePresetModel(handle.db, `org-other-${randomUUID()}`, "quick"),
    ).toBeNull();
  });
});
