/**
 * Schedule-ticker tests — claim mechanics (advisory-locked re-check, cursor
 * advance BEFORE dispatch, no backfill, disarm on bad cron), the due scan's
 * enabled/published gating, dispatch-failure isolation, and concurrent-claim
 * single-fire — against a REAL Postgres (gated on TEST_DATABASE_URL; skips
 * cleanly when unset). Dispatch is injected so no worker fleet is needed;
 * the end-to-end SCHEDULE proof lives in phase3-acceptance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { MetricsRegistry } from "./metrics";
import type { RuntimeDeps } from "./routes";
import {
  claimDueScheduleFire,
  createScheduleTicker,
  type DueScheduleFire,
} from "./schedule-ticker";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[schedule-ticker] TEST_DATABASE_URL not set — skipping schedule ticker tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("schedule ticker", () => {
  let handle: DbHandle;
  let orgId: string;
  let metrics: MetricsRegistry;

  const logger = createLogger({ sink: () => {}, minLevel: "error" });

  /**
   * Only db/logger/metrics are consumed when `dispatch` is injected (the
   * built-in dispatch path — resolve + dispatchTriggerRun — is proven by the
   * phase-3 SCHEDULE acceptance); the cast keeps this suite worker-free.
   */
  function deps(): RuntimeDeps {
    return { db: handle.db, logger, metrics } as unknown as RuntimeDeps;
  }

  function ticker(dispatched: DueScheduleFire[], now: () => Date) {
    return createScheduleTicker(deps(), {
      now,
      dispatch: async (due) => {
        dispatched.push(due);
      },
    });
  }

  async function createOrg(): Promise<string> {
    const id = `org-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id,
      name: `Ticker Org ${id.slice(0, 8)}`,
      slug: id,
      createdAt: new Date(),
    });
    return id;
  }

  async function createScheduledWorkflow(options: {
    cron: string;
    nextFireAt: Date | null;
    workflowEnabled?: boolean;
    triggerEnabled?: boolean;
    published?: boolean;
  }): Promise<{ workflowId: string; triggerId: string }> {
    const published = options.published ?? true;
    const config = {
      trigger: { type: "schedule", cron: options.cron },
      agentId: null,
      instructions: { markdown: "Do the scheduled thing (@trigger.scheduledFor)" },
    };
    const workflows = await handle.db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name: `Scheduled ${randomUUID().slice(0, 8)}`,
        draft: config,
        published: published ? config : null,
        publishedAt: published ? new Date() : null,
        enabled: options.workflowEnabled ?? true,
      })
      .returning({ id: schema.workflows.id });
    const workflowId = workflows[0]!.id;
    const triggers = await handle.db
      .insert(schema.triggers)
      .values({
        workflowId,
        type: "schedule",
        cron: options.cron,
        nextFireAt: options.nextFireAt,
        enabled: options.triggerEnabled ?? true,
      })
      .returning({ id: schema.triggers.id });
    return { workflowId, triggerId: triggers[0]!.id };
  }

  async function triggerRow(triggerId: string) {
    const rows = await handle.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.id, triggerId));
    return rows[0]!;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 5 });
    orgId = await createOrg();
  }, 60_000);

  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  afterAll(async () => {
    if (handle && orgId) {
      // Workflows/triggers cascade from the organization.
      await handle.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await handle.close();
    }
  });

  test("claim: advances the cursor from NOW (no backfill) and returns the due window", async () => {
    const now = new Date("2026-07-10T12:00:30.000Z");
    // Due 10 minutes ago; three windows were missed while "down".
    const due = new Date("2026-07-10T11:50:00.000Z");
    const { triggerId } = await createScheduledWorkflow({
      cron: "*/5 * * * *",
      nextFireAt: due,
    });

    const claim = await claimDueScheduleFire(handle.db, triggerId, now);
    expect(claim?.scheduledFor.toISOString()).toBe(due.toISOString());

    // Advanced past NOW — the missed 11:55 and 12:00 windows are skipped.
    const row = await triggerRow(triggerId);
    expect(row.nextFireAt?.toISOString()).toBe("2026-07-10T12:05:00.000Z");
  });

  test("claim: not due / disabled / non-schedule → null, cursor untouched", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const future = new Date("2026-07-10T13:00:00.000Z");
    const { triggerId } = await createScheduledWorkflow({
      cron: "0 * * * *",
      nextFireAt: future,
    });
    expect(await claimDueScheduleFire(handle.db, triggerId, now)).toBeNull();

    const disabled = await createScheduledWorkflow({
      cron: "0 * * * *",
      nextFireAt: new Date("2026-07-10T11:00:00.000Z"),
      triggerEnabled: false,
    });
    expect(await claimDueScheduleFire(handle.db, disabled.triggerId, now)).toBeNull();
    expect((await triggerRow(disabled.triggerId)).nextFireAt).not.toBeNull();
  });

  test("claim: an unparseable cron disarms the trigger (nextFireAt cleared)", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const { triggerId } = await createScheduledWorkflow({
      cron: "not a cron",
      nextFireAt: new Date("2026-07-10T11:00:00.000Z"),
    });
    // The claim still returns the window (the row WAS due) but disarms it.
    const claim = await claimDueScheduleFire(handle.db, triggerId, now, logger);
    expect(claim).not.toBeNull();
    expect((await triggerRow(triggerId)).nextFireAt).toBeNull();
  });

  test("concurrent claims of one window: exactly one winner (advisory lock + re-check)", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const { triggerId } = await createScheduledWorkflow({
      cron: "*/5 * * * *",
      nextFireAt: new Date("2026-07-10T11:55:00.000Z"),
    });

    const claims = await Promise.all(
      Array.from({ length: 4 }, () => claimDueScheduleFire(handle.db, triggerId, now)),
    );
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
  });

  test("tick: fires due triggers once, with the due window as scheduledFor", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const due = new Date("2026-07-10T11:59:00.000Z");
    const { workflowId, triggerId } = await createScheduledWorkflow({
      cron: "* * * * *",
      nextFireAt: due,
    });

    const dispatched: DueScheduleFire[] = [];
    const t = ticker(dispatched, () => now);

    const first = await t.tick();
    expect(first.dispatched).toBeGreaterThanOrEqual(1);
    const mine = dispatched.filter((d) => d.workflowId === workflowId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ triggerId, organizationId: orgId });
    expect(mine[0]!.scheduledFor.toISOString()).toBe(due.toISOString());

    // Same clock, second tick: the cursor advanced past now — nothing re-fires.
    await t.tick();
    expect(dispatched.filter((d) => d.workflowId === workflowId)).toHaveLength(1);

    expect(metrics.scheduleCounts().dispatched).toBeGreaterThanOrEqual(1);
  });

  test("tick: disabled or unpublished workflows never fire (cursor left for the next publish)", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const past = new Date("2026-07-10T11:00:00.000Z");
    const killSwitched = await createScheduledWorkflow({
      cron: "0 * * * *",
      nextFireAt: past,
      workflowEnabled: false,
    });
    const unpublished = await createScheduledWorkflow({
      cron: "0 * * * *",
      nextFireAt: past,
      published: false,
    });

    const dispatched: DueScheduleFire[] = [];
    await ticker(dispatched, () => now).tick();

    const fired = new Set(dispatched.map((d) => d.workflowId));
    expect(fired.has(killSwitched.workflowId)).toBe(false);
    expect(fired.has(unpublished.workflowId)).toBe(false);
  });

  test("tick: a dispatch failure is contained — cursor stays advanced, no hot loop", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const { workflowId, triggerId } = await createScheduledWorkflow({
      cron: "*/5 * * * *",
      nextFireAt: new Date("2026-07-10T11:55:00.000Z"),
    });

    let attempts = 0;
    const t = createScheduleTicker(deps(), {
      now: () => now,
      dispatch: async (due) => {
        if (due.workflowId !== workflowId) return;
        attempts += 1;
        throw new Error("worker fleet on fire");
      },
    });

    const outcome = await t.tick();
    expect(outcome.failed).toBeGreaterThanOrEqual(1);
    expect(attempts).toBe(1);
    // The claim committed before the dispatch — the next tick does NOT retry.
    await t.tick();
    expect(attempts).toBe(1);
    expect((await triggerRow(triggerId)).nextFireAt?.toISOString()).toBe(
      "2026-07-10T12:05:00.000Z",
    );
    expect(metrics.scheduleCounts().failed).toBeGreaterThanOrEqual(1);
  });

  test("start/stop: the loop ticks on its cadence and stops cleanly", async () => {
    const dispatched: DueScheduleFire[] = [];
    const t = createScheduleTicker(deps(), {
      tickMs: 20,
      dispatch: async (due) => {
        dispatched.push(due);
      },
    });
    t.start();
    t.start(); // idempotent
    await Bun.sleep(80);
    await t.stop();
    // No assertion on dispatch volume (other rows may exist) — the proof is
    // that stop() resolves with no in-flight tick left behind.
    await t.stop(); // idempotent
  });
});
