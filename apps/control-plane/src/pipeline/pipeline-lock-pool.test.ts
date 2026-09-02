/**
 * Pipeline lock-pool tests (N3) — gated on TEST_DATABASE_URL (skip cleanly
 * when unset; the compose integration stage provides it).
 *
 * N3 — PIPELINE RUN LOCKS PINNED THE ROOT POOL: the per-run session-level
 *      advisory lock reserved a ROOT-pool connection for the driver's whole
 *      lifetime (up to PIPELINE_MAX_WALL_CLOCK_MS). Ten long concurrent
 *      pipelines reserved all ten default root connections, and every driver
 *      then blocked on its own ledger/status query — the whole control plane
 *      wedged. The lock now rides a DEDICATED pipeline lock pool
 *      (`Db.$pipelineLockClient`, `DB_PIPELINE_LOCK_POOL_SIZE`), separate
 *      from both the root pool and the session-dispatch lock pool, with a
 *      BOUNDED reserve: exhaustion is a typed, transient, fast refusal
 *      (`{started:false, reason:"lock_pool_exhausted"}`, nothing created)
 *      taken BEFORE the run row exists (lock-before-claim on a pre-minted
 *      id), and boot adoption of an orphan simply waits for the next sweep.
 *
 * This file uses only entry points that predate the fix (`startPipelineRun`,
 * `PipelineRunner.resume`, `createDb`), so it runs verbatim against the
 * pre-fix runner and FAILS there — the reversion proof: with the lock on the
 * root pool, a root pool of 3 and 8 concurrent long-running pipelines never
 * all reach their step executor (the fan-out deadline fires).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  newId,
  newStepId,
  workflowConfigSchema,
  type Logger,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { createGuardedFetch } from "../net/guarded-fetch";
import { RunEventBus } from "../runs/bus";
import { createDrizzleRunStore, type RunStore } from "../runs/store";
import { PIPELINE_TRIGGER_AGENT_ID } from "../runtime/dispatch";
import { MetricsRegistry } from "../runtime/metrics";
import {
  createPipelineRunner,
  startPipelineRun,
  type PipelineRunner,
} from "./runner";
import {
  createDrizzleRunStepStore,
  createDrizzleWorkflowStateStore,
} from "./step-store";
import type { StepExecutor } from "./types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[pipeline-lock-pool] skipped: TEST_DATABASE_URL not set");
}

const logger: Logger = createLogger({ sink: () => {}, minLevel: "error" });
const guardedFetch = createGuardedFetch({ allowPrivate: true });

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** Reject after `ms` — the deadlock detector. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

describe.skipIf(!GATE)("pipeline lock pool (N3)", () => {
  // A deliberately SMALL root pool: the N3 deadlock needs more concurrent
  // drivers (each pinning a lock connection) than root connections.
  const ROOT_POOL = 3;
  const CONCURRENT_PIPELINES = ROOT_POOL + 5;

  let handle: DbHandle;
  let orgId: string;
  let runStore: RunStore;
  const bus = new RunEventBus();
  const connectionId = newId("cn");

  /** The step executor: every run parks here until the test opens the gate. */
  const entered: string[] = [];
  let gate = deferred();
  const holdExecutor: StepExecutor = async (ctx) => {
    entered.push(ctx.run.id);
    await gate.promise;
    return { status: "succeeded", output: { held: true } };
  };

  function makeRunner(db: DbHandle, metrics?: MetricsRegistry): PipelineRunner {
    return createPipelineRunner({
      db: db.db,
      runStore: createDrizzleRunStore(db.db),
      stepStore: createDrizzleRunStepStore(db.db),
      stateStore: createDrizzleWorkflowStateStore(db.db),
      bus,
      logger,
      executors: { tool: holdExecutor },
      executorDeps: { db: db.db, logger, masterKey: undefined, fetchImpl: guardedFetch },
      config: {
        maxWallClockMs: 120_000,
        maxExecutedStepsPerRun: 200,
        maxStepOutputBytes: 262_144,
        childPollMs: 100,
      },
      workspaceRunCap: 64,
      ...(metrics ? { metrics } : {}),
    });
  }

  function holdConfig(): WorkflowConfig {
    return workflowConfigSchema.parse({
      version: 2,
      trigger: { type: "webhook" },
      overlap: "allow",
      steps: [
        {
          id: newStepId(),
          slug: "hold",
          kind: "tool",
          connectionId,
          tool: "hold",
          args: {},
        },
      ],
    });
  }

  async function insertWorkflow(config: WorkflowConfig): Promise<string> {
    const rows = await handle.db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name: `Lock pool ${randomUUID().slice(0, 8)}`,
        draft: config as unknown as Record<string, unknown>,
        published: config as unknown as Record<string, unknown>,
        publishedAt: new Date(),
      })
      .returning({ id: schema.workflows.id });
    return rows[0]!.id;
  }

  function triggerEventFor(workflowId: string): TriggerEvent {
    return {
      agentId: PIPELINE_TRIGGER_AGENT_ID,
      workflowId,
      triggerType: "webhook",
      message: "",
      data: {},
      principal: { workspaceId: orgId, source: "webhook" },
    };
  }

  async function runsOf(workflowId: string) {
    return handle.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.workflowId, workflowId));
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, {
      max: ROOT_POOL,
      lockMax: 4,
      pipelineLockMax: 16,
    });
    runStore = createDrizzleRunStore(handle.db);
    orgId = `org-plp-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Pipeline Lock Pool Org",
      slug: orgId,
      createdAt: new Date(),
    });
  }, 30_000);

  afterAll(async () => {
    gate.resolve();
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.close();
  }, 15_000);

  test(
    "N3 — more concurrent long-running pipelines than ROOT-pool connections all progress and complete: drivers never pin root-pool capacity",
    async () => {
      const config = holdConfig();
      const workflowId = await insertWorkflow(config);
      const runner = makeRunner(handle);
      gate = deferred();
      entered.length = 0;

      // Every run's step parks inside the executor, so each driver holds its
      // run lock (a pinned connection) for the whole fan-out while the OTHER
      // drivers still need root connections to create their row and claim
      // their ledger frontier. Pre-fix the lock lived on the root pool:
      // ROOT_POOL drivers pinned every connection, their own ledger claims
      // waited for a connection that could never come, and the remaining
      // starts never even inserted their row.
      const starting = Array.from({ length: CONCURRENT_PIPELINES }, () =>
        startPipelineRun(runner, {
          organizationId: orgId,
          workflow: { id: workflowId, config },
          triggerEvent: triggerEventFor(workflowId),
          origin: "webhook",
        }),
      );
      try {
        await withDeadline(
          until(
            () => (entered.length >= CONCURRENT_PIPELINES ? true : undefined),
            "every driver to reach its step executor",
            15_000,
          ),
          16_000,
          "the pipeline fan-out",
        );
      } finally {
        gate.resolve();
      }
      const results = await withDeadline(Promise.all(starting), 15_000, "the starts settling");
      expect(results.every((r) => r.started)).toBeTrue();
      const runIds = results.map((r) => (r as { run: { id: string } }).run.id);
      expect(new Set(runIds).size).toBe(CONCURRENT_PIPELINES);
      await Promise.all([...runner.handles.values()].map((h) => h.done));
      for (const runId of runIds) {
        await until(
          async () =>
            (await runStore.getRunStatus(runId))?.status === "succeeded" ? true : undefined,
          `run ${runId} to succeed`,
        );
      }
    },
    45_000,
  );

  test(
    "N3 — pipeline lock-pool exhaustion is a typed, transient, FAST refusal with nothing created: no run row, no cap slot, a metric; and it clears once the pool frees",
    async () => {
      const config = holdConfig();
      const workflowId = await insertWorkflow(config);
      // A pool with exactly ONE pipeline lock connection — and the test pins
      // it, so the runner's bounded reserve times out.
      const starved = createDb(TEST_DATABASE_URL!, { max: 3, lockMax: 2, pipelineLockMax: 1 });
      const pinned = await starved.pipelineLockSql.reserve();
      const metrics = new MetricsRegistry();
      const runner = makeRunner(starved, metrics);
      try {
        const startedAt = Date.now();
        const refused = await withDeadline(
          startPipelineRun(runner, {
            organizationId: orgId,
            workflow: { id: workflowId, config },
            triggerEvent: triggerEventFor(workflowId),
            origin: "webhook",
          }),
          10_000,
          "the refused start",
        );
        expect(refused).toEqual({ started: false, reason: "lock_pool_exhausted" });
        // Fast: one bounded reserve, never a queue behind live drivers.
        expect(Date.now() - startedAt).toBeLessThan(6_000);
        // NOTHING was created — the lock is taken before the claim.
        expect(await runsOf(workflowId)).toHaveLength(0);
        expect(metrics.pipelineDispatchCounts()).toEqual({
          started: 0,
          overlapSkipped: 0,
          lockPoolExhausted: 1,
        });

        // Boot adoption on an exhausted pool defers (counted "locked"), never
        // throws and never fails the orphan.
        const orphan = await handle.db
          .insert(schema.runs)
          .values({
            agentSessionId: null,
            organizationId: orgId,
            workflowId,
            mode: "pipeline",
            triggerEvent: triggerEventFor(workflowId) as unknown as Record<string, unknown>,
            status: "queued",
          })
          .returning();
        expect(await runner.resume(orphan[0]!)).toBe("locked");
        expect((await runStore.getRunStatus(orphan[0]!.id))?.status).toBe("queued");
        await runStore.markRun(orphan[0]!.id, {
          status: "canceled",
          error: "test cleanup",
          completedAt: new Date(),
        });

        // The pool frees ⇒ the same dispatch goes through (transient).
        pinned.release();
        gate = deferred();
        const started = await startPipelineRun(runner, {
          organizationId: orgId,
          workflow: { id: workflowId, config },
          triggerEvent: triggerEventFor(workflowId),
          origin: "webhook",
        });
        expect(started.started).toBeTrue();
        gate.resolve();
        await Promise.all([...runner.handles.values()].map((h) => h.done));
        expect(metrics.pipelineDispatchCounts().started).toBe(1);
      } finally {
        gate.resolve();
        await starved.close();
      }
    },
    30_000,
  );
});
