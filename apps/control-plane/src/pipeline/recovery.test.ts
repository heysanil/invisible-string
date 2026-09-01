/**
 * Pipeline boot-recovery unit tests — the sweep over non-settled pipeline
 * runs, against a real PipelineRunner wired to in-memory fakes. The resume
 * SEMANTICS (ledger replay, at_most_once, re-attach) are covered in
 * runner.test.ts; this suite covers the adoption orchestration: which runs
 * are handed to the driver, lock contention, live-handle skips, and the
 * fail-outright path.
 */
import { describe, expect, test } from "bun:test";

import { newStepId, type Logger, type WorkflowConfig } from "@invisible-string/shared";

import { RunEventBus } from "../runs/bus";
import { recoverPipelineRuns } from "./recovery";
import {
  createPipelineRunner,
  type PipelineRunner,
  type RunRow,
} from "./runner";
import {
  createMemoryRunStepStore,
  createMemoryWorkflowStateStore,
} from "./step-store";
import {
  createMemoryLocks,
  createMemoryRunStore,
  makeRunRow,
  waitForTerminal,
  type MemoryLocks,
  type MemoryRunStore,
} from "./test-support";
import type { PipelineExecutorDeps } from "./types";

const nullLogger: Logger = {
  emit() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

const config: WorkflowConfig = {
  version: 2,
  trigger: { type: "manual" },
  steps: [
    {
      id: newStepId(),
      slug: "only",
      kind: "tool",
      connectionId: "cn_x",
      tool: "do",
      args: {},
      sideEffect: "at_least_once",
    },
  ],
  overlap: "allow",
};

function rig(opts: { loadConfig?: WorkflowConfig | null } = {}): {
  runner: PipelineRunner;
  runStore: MemoryRunStore;
  locks: MemoryLocks;
} {
  const runStore = createMemoryRunStore();
  const locks = createMemoryLocks();
  const runner = createPipelineRunner({
    runStore,
    stepStore: createMemoryRunStepStore(),
    stateStore: createMemoryWorkflowStateStore(),
    bus: new RunEventBus(),
    logger: nullLogger,
    executors: {
      tool: async () => ({ status: "succeeded", output: { ok: true } }),
    },
    executorDeps: { logger: nullLogger } as unknown as PipelineExecutorDeps,
    config: {
      maxWallClockMs: 60_000,
      maxExecutedStepsPerRun: 200,
      maxStepOutputBytes: 1024,
      childPollMs: 10,
    },
    workspaceRunCap: 5,
    runCreator: {
      async create() {
        throw new Error("recovery never creates runs");
      },
    },
    locks: locks.factory,
    loadWorkflowConfig: async () =>
      opts.loadConfig === undefined ? config : opts.loadConfig,
    sleep: async () => {
      await Bun.sleep(1);
    },
  });
  return { runner, runStore, locks };
}

function orphan(runStore: MemoryRunStore, status: "queued" | "running" | "waiting"): RunRow {
  const run = makeRunRow({ status });
  runStore.setStatus(run.id, status);
  return run;
}

describe("recoverPipelineRuns", () => {
  test("adopts queued/running/waiting orphans and re-drives them to terminal", async () => {
    const { runner, runStore } = rig();
    const runs = [
      orphan(runStore, "queued"),
      orphan(runStore, "running"),
      orphan(runStore, "waiting"),
    ];
    const outcome = await recoverPipelineRuns({
      runner,
      logger: nullLogger,
      listRuns: async () => runs,
    });
    expect(outcome).toEqual({ resumed: 3, locked: 0, failed: 0 });
    for (const run of runs) {
      const terminal = await waitForTerminal(runStore, run.id);
      expect(terminal.status).toBe("succeeded");
    }
  });

  test("a run whose advisory lock is held is left alone", async () => {
    const { runner, runStore, locks } = rig();
    const run = orphan(runStore, "running");
    locks.hold(run.id);
    const outcome = await recoverPipelineRuns({
      runner,
      logger: nullLogger,
      listRuns: async () => [run],
    });
    expect(outcome).toEqual({ resumed: 0, locked: 1, failed: 0 });
    expect(runStore.statuses.get(run.id)?.status).toBe("running");
  });

  test("a run already driven by THIS process is skipped without a lock probe", async () => {
    const { runner, runStore, locks } = rig();
    const run = orphan(runStore, "running");
    // Simulate a live driver: the handle map is consulted before the lock.
    (runner.handles as Map<string, unknown>).set(run.id, {
      runId: run.id,
      workflowId: "",
      done: Promise.resolve(),
    });
    const outcome = await recoverPipelineRuns({
      runner,
      logger: nullLogger,
      listRuns: async () => [run],
    });
    expect(outcome).toEqual({ resumed: 0, locked: 1, failed: 0 });
    expect(locks.acquired).toHaveLength(0);
  });

  test("a run whose published config is gone fails outright and frees its lock", async () => {
    const { runner, runStore, locks } = rig({ loadConfig: null });
    const run = orphan(runStore, "queued");
    const outcome = await recoverPipelineRuns({
      runner,
      logger: nullLogger,
      listRuns: async () => [run],
    });
    expect(outcome).toEqual({ resumed: 0, locked: 0, failed: 1 });
    expect(runStore.statuses.get(run.id)?.status).toBe("failed");
    expect(locks.held.size).toBe(0);
  });

  test("one throwing resume does not strand the rest of the sweep", async () => {
    const { runner, runStore } = rig();
    const bad = orphan(runStore, "queued");
    const good = orphan(runStore, "queued");
    const original = runner.resume.bind(runner);
    runner.resume = async (run: RunRow) => {
      if (run.id === bad.id) throw new Error("boom");
      return original(run);
    };
    const outcome = await recoverPipelineRuns({
      runner,
      logger: nullLogger,
      listRuns: async () => [bad, good],
    });
    expect(outcome).toEqual({ resumed: 1, locked: 0, failed: 1 });
    expect((await waitForTerminal(runStore, good.id)).status).toBe("succeeded");
  });
});
