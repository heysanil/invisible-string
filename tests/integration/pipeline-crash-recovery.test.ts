/**
 * PIPELINE CRASH RECOVERY (plan §Verification "crash drill") — kill the
 * driver mid-`for_each`, reboot, and prove the reboot resumes from the
 * `run_steps` LEDGER with no duplicate `at_most_once` execution:
 *
 *   1. a real PipelineRunner (drizzle stores, the REAL pg advisory-lock
 *      factory on this database) drives a for_each over 5 items whose body is
 *      one `tool` step against an in-process stub MCP server;
 *   2. the stub BLOCKS item 2's call and the runner is interrupted there
 *      (`stopAll()` — the graceful-shutdown path: abort in-flight, NO
 *      terminal writes, exactly the state a control-plane crash/deploy
 *      leaves behind);
 *   3. the ledger now shows items 0–1 `succeeded`, item 2 `running`, the run
 *      still `running` — visible, recoverable, unfinished work;
 *   4. a SECOND runner (the rebooted process) adopts the run through
 *      `recoverPipelineRuns` (advisory lock free ⇒ acquirable) and replays:
 *      terminal rows are ADOPTED (their side effects NOT re-executed), the
 *      interrupted `sideEffect: "at_most_once"` instance fails honest
 *      (`interrupted`, never re-called — the stub's per-item call counts
 *      stay exactly 1), the frontier (items 3–4) actually runs, the loop
 *      aggregates, and the post-loop `state` step still writes.
 *   5. the contrast case: an interrupted `at_least_once` tool step RETRIES on
 *      recovery (call count 2, ledger attempt 2) and the run fully succeeds —
 *      the runs/delivery.ts at-least-once stance.
 *   6. snapshot fidelity: a for_each over `@state.items` whose collection is
 *      MUTATED between crash and recovery still finishes on the ORIGINAL
 *      items — the loop row's persisted input snapshot is replayed verbatim,
 *      never a re-resolve (no mixed-array processing).
 *   7. budget fidelity: rebooting under an exactly-consumed
 *      `maxExecutedStepsPerRun` completes — the seed counts only TERMINAL
 *      non-skipped rows, and each interrupted instance is charged once, at
 *      its re-execution (no double count, no spurious `step_budget_exceeded`).
 *
 * Gated on TEST_DATABASE_URL (the AGENTS.md DB-gated lane). Shares the plain
 * test database like the other control-plane DB-gated suites: rows live
 * under this suite's own organization (deleted in afterAll, cascading), and
 * the recovery sweep runs with an INJECTED `listRuns` scoped to this suite's
 * run ids so it can never adopt another suite's orphans.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, gte, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  newId,
  newStepId,
  workflowConfigSchema,
  type Logger,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { createDb, type DbHandle } from "../../apps/control-plane/src/db";
import { createLogger } from "../../apps/control-plane/src/log";
import { runMigrations } from "../../apps/control-plane/src/migrate";
import { createGuardedFetch } from "../../apps/control-plane/src/net/guarded-fetch";
import { RunEventBus } from "../../apps/control-plane/src/runs/bus";
import { createDrizzleRunStore } from "../../apps/control-plane/src/runs/store";
import {
  createPipelineRunner,
  startPipelineRun,
  type PipelineRunner,
  type PipelineRunnerConfig,
} from "../../apps/control-plane/src/pipeline/runner";
import { recoverPipelineRuns } from "../../apps/control-plane/src/pipeline/recovery";
import {
  createDrizzleRunStepStore,
  createDrizzleWorkflowStateStore,
} from "../../apps/control-plane/src/pipeline/step-store";
import { executeToolStep } from "../../apps/control-plane/src/pipeline/steps/tool";
import { PIPELINE_TRIGGER_AGENT_ID } from "../../apps/control-plane/src/runtime/dispatch";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[pipeline-crash-recovery] skipped: TEST_DATABASE_URL not set");
}

const guardedFetch = createGuardedFetch({ allowPrivate: true });
const logger: Logger = createLogger({ sink: () => {}, minLevel: "error" });

// ── blocking stub MCP server ────────────────────────────────────────────────
//
// Each tool records per-item call counts and blocks its FIRST call for one
// armed item index (holding the HTTP response open) — the deterministic
// "mid-for_each" crash point. The gate resolves only at teardown; the
// interrupt reaches the runner as an aborted in-flight attempt.

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

interface BlockingTool {
  /** tools/call count per item idx. */
  counts: Map<number, number>;
  /** Resolves when the armed item's call ENTERS the handler (now blocked). */
  entered: Deferred;
  /** Released at teardown so the hung handler can finish. */
  gate: Deferred;
  blockAt: number;
  armed: boolean;
}

function blockingTool(blockAt: number): BlockingTool {
  return { counts: new Map(), entered: deferred(), gate: deferred(), blockAt, armed: true };
}

function startStubMcp(tools: Record<string, BlockingTool>): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as {
        id?: number | string;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      let result: Record<string, unknown> = {};
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-crash", version: "1.0.0" },
        };
      } else if (body.method === "tools/call") {
        const tool = tools[body.params?.name ?? ""];
        if (!tool) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "unknown tool" },
          });
        }
        const idx = Number(body.params?.arguments?.["idx"]);
        tool.counts.set(idx, (tool.counts.get(idx) ?? 0) + 1);
        if (idx === tool.blockAt && tool.armed) {
          tool.armed = false;
          tool.entered.resolve();
          await tool.gate.promise; // held until teardown; the client aborts first
        }
        result = { content: [{ type: "text", text: `ok-${idx}` }] };
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

// ── the suite ───────────────────────────────────────────────────────────────

describe.skipIf(!GATE)("pipeline crash recovery — resume from the run_steps ledger", () => {
  const atMostOnceTool = blockingTool(2);
  const atLeastOnceTool = blockingTool(1);
  const snapshotTool = blockingTool(11); // blocks on item VALUE idx 11
  const budgetTool = blockingTool(2);
  const mcp = GATE
    ? startStubMcp({
        record_amo: atMostOnceTool,
        record_alo: atLeastOnceTool,
        record_snap: snapshotTool,
        record_budget: budgetTool,
      })
    : null!;

  let handle: DbHandle;
  let orgId: string;
  let connectionId: string;
  const bus = new RunEventBus();

  function makeRunner(
    configOver: Partial<PipelineRunnerConfig> = {},
  ): PipelineRunner {
    return createPipelineRunner({
      db: handle.db,
      runStore: createDrizzleRunStore(handle.db),
      stepStore: createDrizzleRunStepStore(handle.db),
      stateStore: createDrizzleWorkflowStateStore(handle.db),
      bus,
      logger,
      executors: { tool: executeToolStep },
      executorDeps: {
        db: handle.db,
        logger,
        masterKey: undefined,
        fetchImpl: guardedFetch,
      },
      config: {
        maxWallClockMs: 120_000,
        maxExecutedStepsPerRun: 200,
        maxStepOutputBytes: 262_144,
        childPollMs: 100,
        ...configOver,
      },
      workspaceRunCap: 10,
    });
  }

  /** A for_each(record tool) → state pipeline over `itemsRef`. */
  function crashConfig(
    tool: string,
    sideEffect: "at_least_once" | "at_most_once",
    ids: { loop: string; record: string; wrap: string },
    itemsRef = "trigger.items",
  ): WorkflowConfig {
    return workflowConfigSchema.parse({
      version: 2,
      trigger: { type: "webhook" },
      steps: [
        {
          id: ids.loop,
          slug: "fanout",
          kind: "for_each",
          items: { $ref: itemsRef },
          maxItems: 10,
          onItemError: "continue",
          steps: [
            {
              id: ids.record,
              slug: "record",
              kind: "tool",
              connectionId,
              tool,
              args: { idx: { $ref: "item.idx" } },
              sideEffect,
            },
          ],
        },
        {
          id: ids.wrap,
          slug: "wrap",
          kind: "state",
          set: { succeeded: { $ref: "steps.fanout.succeeded" } },
        },
      ],
    });
  }

  async function insertWorkflow(config: WorkflowConfig): Promise<string> {
    const rows = await handle.db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name: `Crash drill ${randomUUID().slice(0, 8)}`,
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
      data: { items: [0, 1, 2, 3, 4].map((idx) => ({ idx })) },
      principal: { workspaceId: orgId, source: "webhook" },
    };
  }

  async function runRow(runId: string) {
    const rows = await handle.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    return rows[0]!;
  }

  async function ledgerRows(runId: string) {
    const rows = await handle.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId));
    return new Map(rows.map((row) => [row.path, row]));
  }

  /** Recovery sweep scoped to ONE run (never adopts other suites' orphans). */
  async function recoverRun(runner: PipelineRunner, runId: string) {
    return recoverPipelineRuns({
      runner,
      logger,
      listRuns: async () => {
        const rows = await handle.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, runId));
        return rows;
      },
    });
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 6 });
    orgId = `org-pcrash-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Pipeline Crash Org",
      slug: orgId,
      createdAt: new Date(),
    });
    connectionId = newId("cn");
    await handle.db.insert(schema.connections).values({
      id: connectionId,
      scope: "workspace",
      organizationId: orgId,
      name: "crash-notes",
      source: "custom",
      url: mcp.url,
      transport: "streamable-http",
      authType: "none",
      enabled: true,
    });
  }, 30_000);

  afterAll(async () => {
    // Unblock any still-hung stub handler, then cascade the suite's rows away.
    atMostOnceTool.gate.resolve();
    atLeastOnceTool.gate.resolve();
    snapshotTool.gate.resolve();
    budgetTool.gate.resolve();
    mcp?.stop();
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.close();
  }, 15_000);

  test(
    'interrupt mid-for_each → reboot resumes from the ledger; "at_most_once" is never re-executed',
    async () => {
      const ids = { loop: newStepId(), record: newStepId(), wrap: newStepId() };
      const config = crashConfig("record_amo", "at_most_once", ids);
      const workflowId = await insertWorkflow(config);

      // ── the "process" that will crash ──
      const runner1 = makeRunner();
      const started = await startPipelineRun(runner1, {
        organizationId: orgId,
        workflow: { id: workflowId, config },
        triggerEvent: triggerEventFor(workflowId),
        origin: "webhook",
      });
      expect(started.started).toBeTrue();
      const runId = (started as { run: { id: string } }).run.id;

      // Items 0–1 complete; item 2's call is now blocked inside the stub.
      await atMostOnceTool.entered.promise;
      // Graceful-shutdown interrupt: abort in-flight, NO terminal writes.
      await runner1.stopAll();

      // ── the crash left honest, recoverable state ──
      const midRun = await runRow(runId);
      expect(midRun.status).toBe("running");
      const preCrashStartedAt = midRun.startedAt!;
      const midLedger = await ledgerRows(runId);
      expect(midLedger.get(ids.loop)!.status).toBe("running");
      expect(midLedger.get(`${ids.loop}/0/${ids.record}`)!.status).toBe("succeeded");
      expect(midLedger.get(`${ids.loop}/1/${ids.record}`)!.status).toBe("succeeded");
      expect(midLedger.get(`${ids.loop}/2/${ids.record}`)!.status).toBe("running");
      expect(midLedger.has(`${ids.loop}/3/${ids.record}`)).toBeFalse();
      expect(midLedger.has(ids.wrap)).toBeFalse();

      // Widen the drill to the persist→emit crash window: the driver
      // persists a step's terminal row BEFORE emitting its terminal event,
      // so a crash in between leaves the ledger terminal with the timeline
      // showing the step running forever. Simulate it for item 1 by dropping
      // the event SUFFIX from its `pipeline.step.completed` onward (a suffix
      // keeps seq contiguous — the count IS the resuming appender's base);
      // recovery must backfill the missing event on adoption.
      const midEvents = await handle.db
        .select({ seq: schema.runEvents.seq, event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
        .orderBy(schema.runEvents.seq);
      const item1Path = `${ids.loop}/1/${ids.record}`;
      const item1Completed = midEvents.find((row) => {
        const event = row.event as { type: string; data?: { path?: string } };
        return (
          event.type === "pipeline.step.completed" &&
          event.data?.path === item1Path
        );
      });
      expect(item1Completed).toBeDefined();
      await handle.db
        .delete(schema.runEvents)
        .where(
          and(
            eq(schema.runEvents.runId, runId),
            gte(schema.runEvents.seq, item1Completed!.seq),
          ),
        );

      // ── the "rebooted" process adopts + replays ──
      const runner2 = makeRunner();
      const outcome = await recoverRun(runner2, runId);
      expect(outcome).toEqual({ resumed: 1, locked: 0, failed: 0 });
      await runner2.handles.get(runId)?.done;

      // The run completes: item 2 failed honest, items 3–4 ran, the loop's
      // `onItemError: "continue"` kept the run green.
      const finalRun = await runRow(runId);
      expect(finalRun.status).toBe("succeeded");
      // The reboot preserved the ORIGINAL started_at — the wall-clock budget
      // and the scope's `now` anchor there; a restart re-grants neither.
      expect(finalRun.startedAt!.getTime()).toBe(preCrashStartedAt.getTime());
      const ledger = await ledgerRows(runId);
      // Exactly one ledger row per instance path — adoption, not duplication.
      expect(ledger.size).toBe(7); // loop + 5 items + state
      const interrupted = ledger.get(`${ids.loop}/2/${ids.record}`)!;
      expect(interrupted.status).toBe("failed");
      expect(interrupted.errorClass).toBe("interrupted");
      expect(interrupted.attempt).toBe(1); // never re-attempted
      expect(ledger.get(`${ids.loop}/3/${ids.record}`)!.status).toBe("succeeded");
      expect(ledger.get(`${ids.loop}/4/${ids.record}`)!.status).toBe("succeeded");
      expect(ledger.get(ids.loop)!.output).toMatchObject({
        total: 5,
        succeeded: 4,
        failed: 1,
        skipped: 0,
      });

      // THE core guarantee: no duplicate side effects anywhere — adopted
      // items were not re-called, and the interrupted at_most_once item was
      // not retried.
      expect([...atMostOnceTool.counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
      ]);

      // The post-loop state step still ran on the reboot, off the REBUILT
      // scope (the loop aggregate), and recorded provenance.
      const state = await handle.db
        .select()
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, workflowId));
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({
        key: "succeeded",
        value: 4,
        updatedByRunId: runId,
      });

      // Event stream: one started, one completed, and the honest failure.
      const events = await handle.db
        .select({ seq: schema.runEvents.seq, event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, runId))
        .orderBy(schema.runEvents.seq);
      const parsed = events.map(
        (row) => row.event as { type: string; data?: Record<string, unknown> },
      );
      expect(parsed.filter((e) => e.type === "pipeline.started")).toHaveLength(1);
      expect(parsed.filter((e) => e.type === "pipeline.completed")).toHaveLength(1);
      const failure = parsed.find((e) => e.type === "pipeline.step.failed");
      expect(failure?.data).toMatchObject({
        path: `${ids.loop}/2/${ids.record}`,
        errorClass: "interrupted",
        willRetry: false,
      });
      // The persist→emit crash window healed: item 1's missing terminal
      // event was backfilled on adoption — exactly once, no duplicates.
      expect(
        parsed.filter(
          (e) =>
            e.type === "pipeline.step.completed" &&
            e.data?.["path"] === item1Path,
        ),
      ).toHaveLength(1);
    },
    60_000,
  );

  test(
    'contrast: an interrupted "at_least_once" tool step RETRIES on recovery (call count 2) and the run fully succeeds',
    async () => {
      const ids = { loop: newStepId(), record: newStepId(), wrap: newStepId() };
      const config = crashConfig("record_alo", "at_least_once", ids);
      const workflowId = await insertWorkflow(config);

      const runner1 = makeRunner();
      const started = await startPipelineRun(runner1, {
        organizationId: orgId,
        workflow: { id: workflowId, config },
        triggerEvent: triggerEventFor(workflowId),
        origin: "webhook",
      });
      expect(started.started).toBeTrue();
      const runId = (started as { run: { id: string } }).run.id;

      await atLeastOnceTool.entered.promise; // item 1 blocked mid-call
      await runner1.stopAll();
      expect((await runRow(runId)).status).toBe("running");

      const runner2 = makeRunner();
      const outcome = await recoverRun(runner2, runId);
      expect(outcome).toEqual({ resumed: 1, locked: 0, failed: 0 });
      await runner2.handles.get(runId)?.done;

      expect((await runRow(runId)).status).toBe("succeeded");
      const ledger = await ledgerRows(runId);
      const retried = ledger.get(`${ids.loop}/1/${ids.record}`)!;
      expect(retried.status).toBe("succeeded");
      expect(retried.attempt).toBe(2); // the crash-window retry, on the record
      expect(ledger.get(ids.loop)!.output).toMatchObject({
        total: 5,
        succeeded: 5,
        failed: 0,
        skipped: 0,
      });
      // Item 1 was called TWICE (at-least-once's honest double-fire window);
      // every adopted item stayed at exactly one call.
      expect([...atLeastOnceTool.counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [0, 1],
        [1, 2],
        [2, 1],
        [3, 1],
        [4, 1],
      ]);

      const state = await handle.db
        .select()
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, workflowId));
      expect(state[0]).toMatchObject({ key: "succeeded", value: 5 });
    },
    60_000,
  );

  test(
    "a resumed for_each replays its PERSISTED items snapshot even after the state collection MOVED",
    async () => {
      const ids = { loop: newStepId(), record: newStepId(), wrap: newStepId() };
      const config = crashConfig("record_snap", "at_least_once", ids, "state.items");
      const workflowId = await insertWorkflow(config);
      // The collection lives in WORKFLOW STATE — the one scope source that
      // can move underneath a crashed run (trigger data is frozen on the
      // run row; step outputs replay from the ledger).
      const originalItems = [{ idx: 10 }, { idx: 11 }, { idx: 12 }];
      await handle.db.insert(schema.workflowState).values({
        workflowId,
        key: "items",
        value: sql`${JSON.stringify(originalItems)}::jsonb`,
        organizationId: orgId,
      });

      const runner1 = makeRunner();
      const started = await startPipelineRun(runner1, {
        organizationId: orgId,
        workflow: { id: workflowId, config },
        triggerEvent: triggerEventFor(workflowId),
        origin: "webhook",
      });
      expect(started.started).toBeTrue();
      const runId = (started as { run: { id: string } }).run.id;

      await snapshotTool.entered.promise; // item idx 11 blocked mid-call
      await runner1.stopAll();

      // The crash left the loop row holding the RESOLVED items snapshot.
      const midLedger = await ledgerRows(runId);
      expect(midLedger.get(ids.loop)!.status).toBe("running");
      expect(midLedger.get(ids.loop)!.input).toEqual({
        itemsRef: "state.items",
        count: 3,
        items: originalItems,
      });

      // The state array MOVES between crash and recovery (a concurrent
      // overlap:"allow" run, an operator edit): a re-resolve on reboot would
      // combine item 0 of the OLD array with the tail of the NEW one.
      const movedItems = [{ idx: 90 }, { idx: 91 }, { idx: 92 }, { idx: 93 }];
      await handle.db
        .update(schema.workflowState)
        .set({ value: sql`${JSON.stringify(movedItems)}::jsonb` })
        .where(
          and(
            eq(schema.workflowState.workflowId, workflowId),
            eq(schema.workflowState.key, "items"),
          ),
        );

      const runner2 = makeRunner();
      const outcome = await recoverRun(runner2, runId);
      expect(outcome).toEqual({ resumed: 1, locked: 0, failed: 0 });
      await runner2.handles.get(runId)?.done;

      // The loop finished on the ORIGINAL items: idx 10 adopted (1 call),
      // idx 11 retried (the at-least-once crash window, 2 calls), idx 12
      // fresh (1 call) — and NO call ever saw the moved array's values.
      expect((await runRow(runId)).status).toBe("succeeded");
      expect(
        [...snapshotTool.counts.entries()].sort((a, b) => a[0] - b[0]),
      ).toEqual([
        [10, 1],
        [11, 2],
        [12, 1],
      ]);
      const ledger = await ledgerRows(runId);
      expect(ledger.size).toBe(5); // loop + the snapshot's 3 items + state
      expect(ledger.get(ids.loop)!.output).toMatchObject({
        total: 3,
        succeeded: 3,
        failed: 0,
        skipped: 0,
      });
      // The snapshot survived the resume untouched.
      expect(ledger.get(ids.loop)!.input).toEqual({
        itemsRef: "state.items",
        count: 3,
        items: originalItems,
      });
      const state = await handle.db
        .select()
        .from(schema.workflowState)
        .where(
          and(
            eq(schema.workflowState.workflowId, workflowId),
            eq(schema.workflowState.key, "succeeded"),
          ),
        );
      expect(state[0]).toMatchObject({ key: "succeeded", value: 3 });
    },
    60_000,
  );

  test(
    "recovery under an EXACTLY-consumed step budget: terminal rows seed it once, the interrupted instance re-counts only at its retry",
    async () => {
      const ids = { loop: newStepId(), record: newStepId(), wrap: newStepId() };
      const config = crashConfig("record_budget", "at_least_once", ids);
      const workflowId = await insertWorkflow(config);

      const runner1 = makeRunner();
      const started = await startPipelineRun(runner1, {
        organizationId: orgId,
        workflow: { id: workflowId, config },
        triggerEvent: triggerEventFor(workflowId),
        origin: "webhook",
      });
      expect(started.started).toBeTrue();
      const runId = (started as { run: { id: string } }).run.id;

      await budgetTool.entered.promise; // item 2 blocked mid-call
      await runner1.stopAll();

      // The whole pipeline is exactly 7 instances (loop + 5 items + state).
      // Rebooting with that exact budget must still complete: the seed
      // counts only the 2 TERMINAL rows (items 0–1), the interrupted loop
      // and item-2 rows are charged once each at their re-execution, and
      // the fresh frontier (items 3–4, state) fills the rest — a seed that
      // also counted the two interrupted rows would burst the budget and
      // fail recovery `step_budget_exceeded` spuriously.
      const runner2 = makeRunner({ maxExecutedStepsPerRun: 7 });
      const outcome = await recoverRun(runner2, runId);
      expect(outcome).toEqual({ resumed: 1, locked: 0, failed: 0 });
      await runner2.handles.get(runId)?.done;

      const finalRun = await runRow(runId);
      expect(finalRun.status).toBe("succeeded");
      expect(finalRun.error).toBeNull();
      const ledger = await ledgerRows(runId);
      expect(ledger.size).toBe(7);
      expect(ledger.get(ids.loop)!.output).toMatchObject({
        total: 5,
        succeeded: 5,
        failed: 0,
        skipped: 0,
      });
      // Item 2 retried (at-least-once), everything else ran exactly once.
      expect(
        [...budgetTool.counts.entries()].sort((a, b) => a[0] - b[0]),
      ).toEqual([
        [0, 1],
        [1, 1],
        [2, 2],
        [3, 1],
        [4, 1],
      ]);
      const state = await handle.db
        .select()
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, workflowId));
      expect(state[0]).toMatchObject({ key: "succeeded", value: 5 });
    },
    60_000,
  );
});
