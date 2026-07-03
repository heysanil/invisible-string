/**
 * Dead-worker sweeper tests — gated on TEST_DATABASE_URL (skip cleanly when
 * unset; the compose integration stage provides it).
 *
 * Proves the Phase-3 liveness state machine + failover (docs/PLAN.md task 1+2):
 *  - a heartbeat-stale worker is marked `dead`;
 *  - a PARKED (waiting) session's affinity is CLEARED so its approval
 *    reschedules onto a different worker (the headline acceptance);
 *  - a RUNNING run stranded on a dead worker is handed to `resumeRun`
 *    (production wiring re-ensures the agent + re-tails elsewhere);
 *  - a run whose session never got an eve session is failed.
 *
 * `resumeRun` is injected as a spy so the DB decisions are asserted without a
 * fake worker/agent (the full ensure+re-tail path is covered by the runtime
 * integration suite).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import { createDrizzleRunStore } from "../runs/store";
import type { RuntimeConfig } from "./config";
import type { RuntimeDeps } from "./routes";
import { createWorkerSweeper, type ResumeRunFn } from "./worker-sweeper";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TTL_MS = 30_000;
const NOW = new Date("2026-07-03T12:00:00Z");
const STALE = new Date(NOW.getTime() - 5 * TTL_MS); // well past the TTL
const FRESH = new Date(NOW.getTime() - 1_000);

if (!TEST_DATABASE_URL) {
  console.warn(
    "[sweeper] TEST_DATABASE_URL not set — skipping sweeper tests (integration stage provides it)",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("worker sweeper failover", () => {
  let handle: DbHandle;
  let db: DbHandle["db"];
  const suffix = randomUUID().slice(0, 8);
  const orgId = `org-sw-${suffix}`;
  const userId = `user-sw-${suffix}`;
  let workflowId: string;
  let versionId: string;
  const contentHash = `sweephash${suffix}`;

  function runtime(): RuntimeConfig {
    return {
      workerHeartbeatTtlMs: TTL_MS,
      workerSweepIntervalMs: TTL_MS,
      maxAgentsPerWorker: 20,
    } as RuntimeConfig;
  }

  function deps(): RuntimeDeps {
    return {
      db,
      runtime: runtime(),
      runStore: createDrizzleRunStore(db),
    } as unknown as RuntimeDeps;
  }

  function sweeperWith(resumeRun: ResumeRunFn) {
    return createWorkerSweeper(deps(), { resumeRun });
  }

  const createdWorkers: string[] = [];
  async function insertWorker(status: "live" | "draining" | "dead", heartbeat: Date): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.workers).values({
      id,
      address: `http://worker-${id}:8080`,
      status,
      lastHeartbeatAt: heartbeat,
      capacity: {},
    });
    createdWorkers.push(id);
    return id;
  }

  async function insertSessionRun(opts: {
    affinityWorkerId: string;
    sessionStatus: "active" | "waiting";
    runStatus: "queued" | "running" | "waiting";
    eveSessionId: string | null;
  }): Promise<{ sessionId: string; runId: string }> {
    const sessionRows = await db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        workflowId,
        workflowVersionId: versionId,
        eveSessionId: opts.eveSessionId,
        continuationToken: opts.eveSessionId ? "cont-token" : null,
        origin: "chat",
        principal: { workspaceId: orgId, source: "chat" },
        affinityWorkerId: opts.affinityWorkerId,
        status: opts.sessionStatus,
      })
      .returning();
    const runRows = await db
      .insert(schema.runs)
      .values({
        agentSessionId: sessionRows[0]!.id,
        triggerEvent: { workflowId, triggerType: "manual", data: {}, principal: {} },
        status: opts.runStatus,
      })
      .returning();
    return { sessionId: sessionRows[0]!.id, runId: runRows[0]!.id };
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!, { max: 4 });
    db = handle.db;
    await runMigrations(TEST_DATABASE_URL!);
    await db.insert(schema.user).values({
      id: userId,
      name: "Sweeper Tester",
      email: `sw-${suffix}@invisible-string.local`,
    });
    await db.insert(schema.organization).values({
      id: orgId,
      name: `SW ${suffix}`,
      slug: `sw-${suffix}`,
      createdAt: NOW,
    });
    const wf = await db
      .insert(schema.workflows)
      .values({ organizationId: orgId, name: "sweeper wf", runAsUserId: userId, draft: {} })
      .returning();
    workflowId = wf[0]!.id;
    const ver = await db
      .insert(schema.workflowVersions)
      .values({
        workflowId,
        config: { pillars: true },
        contentHash,
        compilerVersion: "stub",
        eveVersion: "0.19.0",
        buildStatus: "succeeded",
      })
      .returning();
    versionId = ver[0]!.id;
  });

  afterAll(async () => {
    // Clean up so sibling suites (esp. boot-reconcile, which counts ALL
    // queued/running runs globally) don't see this suite's orphaned rows.
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId)); // cascades sessions + runs
    if (createdWorkers.length > 0) {
      await db.delete(schema.workers).where(inArray(schema.workers.id, createdWorkers));
    }
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle?.close();
  });

  test("marks a heartbeat-stale live worker dead", async () => {
    const staleId = await insertWorker("live", STALE);
    const spy: ResumeRunFn = async () => "resumed";
    const outcome = await sweeperWith(spy).sweepOnce(NOW);
    expect(outcome.markedDead).toBeGreaterThanOrEqual(1);
    const row = await db.select().from(schema.workers).where(eq(schema.workers.id, staleId));
    expect(row[0]!.status).toBe("dead");
  });

  test("a PARKED session's affinity is cleared (resumes on a different worker via input)", async () => {
    const deadWorker = await insertWorker("live", STALE); // becomes dead this pass
    await insertWorker("live", FRESH); // a live worker exists to reschedule onto
    const { sessionId, runId } = await insertSessionRun({
      affinityWorkerId: deadWorker,
      sessionStatus: "waiting",
      runStatus: "waiting",
      eveSessionId: `eve-${randomUUID()}`,
    });

    const calls: string[] = [];
    const spy: ResumeRunFn = async ({ run }) => {
      calls.push(run.id);
      return "resumed";
    };
    const outcome = await sweeperWith(spy).sweepOnce(NOW);

    // A parked run is NOT actively re-dispatched — it waits for the user's
    // approval, which reschedules via the (now null) affinity.
    expect(calls).not.toContain(runId);
    expect(outcome.cleared).toBeGreaterThanOrEqual(1);
    const session = await db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId));
    expect(session[0]!.affinityWorkerId).toBeNull();
  });

  test("a RUNNING run stranded on a dead worker is handed to resumeRun", async () => {
    const deadWorker = await insertWorker("dead", STALE);
    const eveSessionId = `eve-${randomUUID()}`;
    const { runId } = await insertSessionRun({
      affinityWorkerId: deadWorker,
      sessionStatus: "active",
      runStatus: "running",
      eveSessionId,
    });

    const seen: { runId: string; contentHash: string; eveSessionId: string }[] = [];
    const spy: ResumeRunFn = async (input) => {
      seen.push({
        runId: input.run.id,
        contentHash: input.contentHash,
        eveSessionId: input.eveSessionId,
      });
      return "resumed";
    };
    const outcome = await sweeperWith(spy).sweepOnce(NOW);

    expect(seen).toContainEqual({ runId, contentHash, eveSessionId });
    expect(outcome.resumed).toBeGreaterThanOrEqual(1);
  });

  test("no live worker → a running run is deferred (kept for a later pass), not failed", async () => {
    const deadWorker = await insertWorker("dead", STALE);
    const { runId } = await insertSessionRun({
      affinityWorkerId: deadWorker,
      sessionStatus: "active",
      runStatus: "running",
      eveSessionId: `eve-${randomUUID()}`,
    });
    const spy: ResumeRunFn = async () => "no_worker";
    const outcome = await sweeperWith(spy).sweepOnce(NOW);
    expect(outcome.deferred).toBeGreaterThanOrEqual(1);
    const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    // Still running — a durable turn is never abandoned just because capacity
    // is momentarily unavailable.
    expect(run[0]!.status).toBe("running");
  });

  test("a running run whose session never got an eve session is failed", async () => {
    const deadWorker = await insertWorker("dead", STALE);
    const { runId, sessionId } = await insertSessionRun({
      affinityWorkerId: deadWorker,
      sessionStatus: "active",
      runStatus: "running",
      eveSessionId: null,
    });
    const spy: ResumeRunFn = async () => "resumed";
    const outcome = await sweeperWith(spy).sweepOnce(NOW);
    expect(outcome.failed).toBeGreaterThanOrEqual(1);
    const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run[0]!.status).toBe("failed");
    const session = await db
      .select()
      .from(schema.agentSessions)
      .where(
        and(eq(schema.agentSessions.id, sessionId)),
      );
    expect(session[0]!.affinityWorkerId).toBeNull();
  });
});
