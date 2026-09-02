import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import { ACTIVE_RUN_STATUSES, countActiveRuns, wouldExceedRunCap } from "./caps";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[caps] TEST_DATABASE_URL not set — skipping countActiveRuns join-audit tests",
  );
}

describe("run cap logic", () => {
  test("active statuses are queued/running/waiting (parked runs hold a slot)", () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(["queued", "running", "waiting"]);
  });

  test("under the cap: starting one more is allowed", () => {
    expect(wouldExceedRunCap(0, 5)).toBeFalse();
    expect(wouldExceedRunCap(4, 5)).toBeFalse();
  });

  test("at the cap: starting one more is rejected", () => {
    expect(wouldExceedRunCap(5, 5)).toBeTrue();
    expect(wouldExceedRunCap(6, 5)).toBeTrue();
  });

  test("cap of 1 permits exactly one active run", () => {
    expect(wouldExceedRunCap(0, 1)).toBeFalse();
    expect(wouldExceedRunCap(1, 1)).toBeTrue();
  });
});

/**
 * The pipelines join audit made real (DB-gated): `runs.agent_session_id` is
 * nullable now, so countActiveRuns must LEFT-join agent_sessions and
 * COALESCE workspace scope — an inner join would silently drop every
 * sessionless pipeline run, a workspace-cap bypass.
 */
describe.skipIf(!TEST_DATABASE_URL)("countActiveRuns — pipeline runs hold cap slots", () => {
  let handle: DbHandle;
  let orgA: string;
  let orgB: string;
  const nano = () => randomUUID().replace(/-/g, "").slice(0, 12);

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    const db = handle.db;
    orgA = `org-capA-${nano()}`;
    orgB = `org-capB-${nano()}`;
    for (const [id, slug] of [
      [orgA, `capa-${nano()}`],
      [orgB, `capb-${nano()}`],
    ] as const) {
      await db.insert(schema.organization).values({
        id,
        name: id,
        slug,
        createdAt: new Date(),
      });
    }

    // 1. Sessionless PIPELINE run in org A (active) — MUST hold a slot.
    await db.insert(schema.runs).values({
      agentSessionId: null,
      organizationId: orgA,
      mode: "pipeline",
      triggerEvent: {},
      status: "queued",
    });
    // 2. Terminal pipeline run in org A — must NOT hold a slot.
    await db.insert(schema.runs).values({
      agentSessionId: null,
      organizationId: orgA,
      mode: "pipeline",
      triggerEvent: {},
      status: "succeeded",
    });
    // 3. Active pipeline run in org B — must not leak into org A's count.
    await db.insert(schema.runs).values({
      agentSessionId: null,
      organizationId: orgB,
      mode: "pipeline",
      triggerEvent: {},
      status: "running",
    });

    // 4. Pre-column-style AGENT run in org A: runs.organization_id NULL, so
    //    the count must fall back to the session's org (the COALESCE arm).
    const userId = `user-cap-${nano()}`;
    await db.insert(schema.user).values({
      id: userId,
      name: "Cap Tester",
      email: `cap-${nano()}@example.com`,
    });
    const agent = await db
      .insert(schema.agents)
      .values({
        organizationId: orgA,
        name: "Cap Agent",
        runAsUserId: userId,
        draft: {},
      })
      .returning({ id: schema.agents.id });
    const version = await db
      .insert(schema.agentVersions)
      .values({
        agentId: agent[0]!.id,
        definition: {},
        contentHash: `hash-${nano()}`,
        compilerVersion: "test",
        eveVersion: "test",
        modelProvider: "openrouter",
        modelId: "test/model",
      })
      .returning({ id: schema.agentVersions.id });
    const session = await db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgA,
        agentId: agent[0]!.id,
        agentVersionId: version[0]!.id,
        origin: "chat",
        principal: { workspaceId: orgA, source: "test" },
      })
      .returning({ id: schema.agentSessions.id });
    await db.insert(schema.runs).values({
      agentSessionId: session[0]!.id,
      organizationId: null,
      mode: "agent",
      triggerEvent: {},
      status: "running",
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("counts sessionless pipeline runs AND legacy session-scoped runs", async () => {
    // org A: 1 active pipeline + 1 legacy agent run (terminal excluded).
    expect(await countActiveRuns(handle.db, orgA)).toBe(2);
    // org B: its own active pipeline run only.
    expect(await countActiveRuns(handle.db, orgB)).toBe(1);
  });
});
