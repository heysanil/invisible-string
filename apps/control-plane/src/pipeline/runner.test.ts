/**
 * Pipeline driver unit tests — the whole interpreter against in-memory
 * fakes (no DB, no network): happy path, retry/backoff, timeouts, wall
 * clock, cancellation, crash-resume replay over the ledger, for_each
 * isolation + error policies, filter/branch/state semantics, overlap skip,
 * agent-step parking, and onComplete delivery.
 */
import { describe, expect, test } from "bun:test";

import {
  newStepId,
  type Logger,
  type PipelineStep,
  type SessionOrigin,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { RunEventBus } from "../runs/bus";
import type { DeliverInput } from "../runs/delivery";
import {
  backoffDelayMs,
  createPipelineRunner,
  loadPipelineRunnerConfig,
  type PipelineRunner,
  type PipelineRunnerConfig,
  type RunRow,
  type StartPipelineRunInput,
  type StepExecutorRegistry,
} from "./runner";
import {
  createMemoryRunStepStore,
  createMemoryWorkflowStateStore,
  type MemoryRunStepStore,
  type MemoryWorkflowStateStore,
} from "./step-store";
import {
  createMemoryLocks,
  createMemoryRunStore,
  makeRunRow,
  makeTriggerEvent,
  waitForTerminal,
  waitUntil,
  type MemoryLocks,
  type MemoryRunStore,
} from "./test-support";
import type {
  PipelineExecutorDeps,
  StepExecuteContext,
  StepExecutor,
} from "./types";

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

const fakeExecutorDeps = {
  db: {},
  logger: nullLogger,
  masterKey: undefined,
  fetchImpl: fetch,
} as unknown as PipelineExecutorDeps;

// ── builders ────────────────────────────────────────────────────────────────

type ToolStep = Extract<PipelineStep, { kind: "tool" }>;

const tool = (slug: string, over: Partial<ToolStep> = {}): ToolStep => ({
  id: newStepId(),
  slug,
  kind: "tool",
  connectionId: "cn_x",
  tool: "do",
  args: {},
  sideEffect: "at_least_once",
  ...over,
});

const cfg = (
  steps: PipelineStep[],
  over: Partial<WorkflowConfig> = {},
): WorkflowConfig => ({
  version: 2,
  trigger: { type: "manual" },
  steps,
  overlap: "allow",
  ...over,
});

interface Harness {
  runner: PipelineRunner;
  runStore: MemoryRunStore;
  stepStore: MemoryRunStepStore;
  stateStore: MemoryWorkflowStateStore;
  bus: RunEventBus;
  locks: MemoryLocks;
  sleeps: number[];
  deliverCalls: DeliverInput[];
  start(input: Partial<StartPipelineRunInput> & { config: WorkflowConfig }): Promise<
    { started: true; run: RunRow } | { started: false; reason: "overlap_skipped" }
  >;
}

function harness(opts: {
  executors: StepExecutorRegistry;
  config?: Partial<PipelineRunnerConfig>;
  loadWorkflowConfig?: (workflowId: string) => Promise<WorkflowConfig | null>;
  now?: () => Date;
}): Harness {
  const runStore = createMemoryRunStore();
  const stepStore = createMemoryRunStepStore();
  const stateStore = createMemoryWorkflowStateStore();
  const bus = new RunEventBus();
  const locks = createMemoryLocks();
  const sleeps: number[] = [];
  const deliverCalls: DeliverInput[] = [];
  const createdRuns: RunRow[] = [];
  const runner = createPipelineRunner({
    runStore,
    stepStore,
    stateStore,
    bus,
    logger: nullLogger,
    executors: opts.executors,
    executorDeps: fakeExecutorDeps,
    config: {
      maxWallClockMs: 60_000,
      maxExecutedStepsPerRun: 200,
      maxStepOutputBytes: 256 * 1024,
      childPollMs: 10,
      ...opts.config,
    },
    workspaceRunCap: 5,
    delivery: {
      async deliver(input) {
        deliverCalls.push(input);
        return "delivered";
      },
      async recoverPending() {
        return { delivered: 0, failed: 0, skipped: 0 };
      },
    },
    runCreator: {
      // Mirrors the drizzle creator's overlap semantics over the fakes.
      async create(input) {
        if (input.overlap === "skip") {
          const live = createdRuns.some((r) => {
            const status = runStore.statuses.get(r.id)?.status;
            return (
              r.workflowId === input.workflowId &&
              (status === "queued" || status === "running" || status === "waiting")
            );
          });
          if (live) return { skippedOverlap: true };
        }
        const run = makeRunRow({
          organizationId: input.organizationId,
          workflowId: input.workflowId,
          triggerEvent: input.triggerEvent as unknown as Record<string, unknown>,
          deliveryStatus: input.deliveryPending ? "pending" : null,
        });
        createdRuns.push(run);
        runStore.setStatus(run.id, "queued");
        return { run };
      },
    },
    locks: locks.factory,
    loadWorkflowConfig: opts.loadWorkflowConfig ?? (async () => null),
    sleep: async (ms) => {
      // Record and return "instantly" — but on a real macrotask tick, so a
      // driver loop awaiting this can never starve the test's own timers.
      sleeps.push(ms);
      await Bun.sleep(1);
    },
    ...(opts.now ? { now: opts.now } : {}),
    random: () => 0,
  });
  const wfId = crypto.randomUUID();
  return {
    runner,
    runStore,
    stepStore,
    stateStore,
    bus,
    locks,
    sleeps,
    deliverCalls,
    start: (input) => {
      const workflow = input.workflow ?? { id: wfId, config: input.config };
      return runner.start({
        organizationId: "org-test",
        workflow,
        triggerEvent:
          input.triggerEvent ?? makeTriggerEvent({ workflowId: workflow.id }),
        origin: (input.origin ?? "webhook") as SessionOrigin,
      });
    },
  };
}

function eventTypes(runStore: MemoryRunStore, runId: string): string[] {
  return runStore.events
    .filter((e) => e.runId === runId)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => (e.event as { type: string }).type);
}

function eventData<T = Record<string, unknown>>(
  runStore: MemoryRunStore,
  runId: string,
  type: string,
): T[] {
  return runStore.events
    .filter(
      (e) => e.runId === runId && (e.event as { type: string }).type === type,
    )
    .map((e) => (e.event as unknown as { data: T }).data);
}

function recording(
  outcome: (ctx: StepExecuteContext) => ReturnType<StepExecutor>,
): { calls: StepExecuteContext[]; exec: StepExecutor } {
  const calls: StepExecuteContext[] = [];
  return {
    calls,
    exec: (ctx) => {
      calls.push(ctx);
      return outcome(ctx);
    },
  };
}

// ── suites ──────────────────────────────────────────────────────────────────

describe("pipeline driver — happy path", () => {
  test("two tool steps: scope threads, ledger + events land, run succeeds", async () => {
    const search = tool("search", { args: { q: { $tpl: "find @trigger.topic" } } });
    const create = tool("create", {
      args: { title: { $ref: "steps.search.top" } },
    });
    const toolExec = recording(async (ctx) => {
      const args = (ctx.input as { args: Record<string, unknown> }).args;
      return ctx.step.id === search.id
        ? { status: "succeeded", output: { top: `hit:${String(args.q)}` } }
        : { status: "succeeded", output: { created: args.title } };
    });
    const h = harness({ executors: { tool: toolExec.exec } });
    const started = await h.start({
      config: cfg([search, create]),
      triggerEvent: makeTriggerEvent({ data: { topic: "exec" } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");

    // Scope threading: step 2 received step 1's output through @steps.
    expect(toolExec.calls).toHaveLength(2);
    expect(toolExec.calls[1]!.input).toEqual({
      args: { title: "hit:find exec" },
    });
    expect(toolExec.calls[0]!.path).toBe(search.id);

    // Ledger: both instances succeeded at their top-level paths.
    const rows = await h.stepStore.listForRun(started.run.id);
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      [search.id, "succeeded"],
      [create.id, "succeeded"],
    ]);
    expect(rows[0]!.input).toEqual({ args: { q: "find exec" } });

    // Event timeline under one monotonic seq.
    expect(eventTypes(h.runStore, started.run.id)).toEqual([
      "pipeline.started",
      "pipeline.step.started",
      "pipeline.step.completed",
      "pipeline.step.started",
      "pipeline.step.completed",
      "pipeline.completed",
    ]);
    // No onComplete configured → nothing rides the DeliveryService.
    expect(h.deliverCalls).toHaveLength(0);
    // Advisory lock released with the driver.
    expect(h.locks.held.size).toBe(0);
  });

  test("onComplete.slackReply renders against the final scope and rides deliver()", async () => {
    const step = tool("gather");
    const h = harness({
      executors: {
        tool: async () => ({ status: "succeeded", output: { n: 3 } }),
      },
    });
    const started = await h.start({
      config: cfg([step], {
        onComplete: {
          slackReply: { template: { markdown: "Found @steps.gather.n items" } },
        },
      }),
      origin: "slack",
    });
    if (!started.started) throw new Error("expected a started run");
    expect(started.run.deliveryStatus).toBe("pending");
    await waitForTerminal(h.runStore, started.run.id);
    expect(h.deliverCalls).toEqual([
      {
        runId: started.run.id,
        status: "succeeded",
        lastAssistantMessage: "Found 3 items",
      },
    ]);
  });

  test("non-slack origin owes no delivery even with onComplete configured", async () => {
    const h = harness({
      executors: {
        tool: async () => ({ status: "succeeded", output: {} }),
      },
    });
    const started = await h.start({
      config: cfg([tool("t")], {
        onComplete: { slackReply: { template: { markdown: "x" } } },
      }),
      origin: "webhook",
    });
    if (!started.started) throw new Error("expected a started run");
    expect(started.run.deliveryStatus).toBeNull();
    await waitForTerminal(h.runStore, started.run.id);
    // deliver() is still called (it no-ops for runs owing nothing).
    expect(h.deliverCalls).toHaveLength(1);
  });
});

describe("pipeline driver — retries", () => {
  test("retryable failures back off exponentially and re-mark the attempt", async () => {
    let attempts = 0;
    const h = harness({
      executors: {
        tool: async () => {
          attempts += 1;
          return attempts < 3
            ? {
                status: "failed",
                errorClass: "unreachable",
                error: "down",
                retryable: true,
              }
            : { status: "succeeded", output: { ok: true } };
        },
      },
    });
    const started = await h.start({ config: cfg([tool("flaky")]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    expect(attempts).toBe(3);
    // 2s·2ⁿ with random()=0 → half-jitter floor: 1000, 2000.
    expect(h.sleeps).toEqual([1000, 2000]);
    const row = (await h.stepStore.listForRun(started.run.id))[0]!;
    expect(row.attempt).toBe(3);
    const failures = eventData(h.runStore, started.run.id, "pipeline.step.failed");
    expect(failures.map((f) => [f.attempt, f.willRetry])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  test("non-retryable failure fails the run and skips later steps entirely", async () => {
    const later = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const bad = tool("bad");
    const after = tool("after");
    const h = harness({
      executors: {
        tool: async (ctx) =>
          ctx.step.id === bad.id
            ? {
                status: "failed",
                errorClass: "tool_error",
                error: "server said no",
                retryable: false,
              }
            : later.exec(ctx),
      },
    });
    const started = await h.start({ config: cfg([bad, after]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toBe("server said no");
    expect(later.calls).toHaveLength(0);
    const rows = await h.stepStore.listForRun(started.run.id);
    expect(rows).toHaveLength(1); // the failed step only — no row for `after`
    expect(rows[0]!.errorClass).toBe("tool_error");
    expect(h.sleeps).toEqual([]);
  });

  test("attempt budget honors the step's retry.maxAttempts", async () => {
    let attempts = 0;
    const h = harness({
      executors: {
        tool: async () => {
          attempts += 1;
          return {
            status: "failed",
            errorClass: "unreachable",
            error: "down",
            retryable: true,
          };
        },
      },
    });
    const started = await h.start({
      config: cfg([tool("flaky", { retry: { maxAttempts: 2 } })]),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(attempts).toBe(2);
  });
});

describe("pipeline driver — timeout + wall clock", () => {
  test("a hanging executor is aborted at the step timeout and classified `timeout`", async () => {
    const h = harness({
      executors: {
        tool: () => new Promise(() => {}), // never settles, ignores the signal
      },
    });
    const started = await h.start({
      config: cfg([tool("slow", { timeoutMs: 20, retry: { maxAttempts: 1 } })]),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    const row = (await h.stepStore.listForRun(started.run.id))[0]!;
    expect(row.errorClass).toBe("timeout");
  });

  test("wall clock exhausted between steps fails the run `wall_clock_exceeded`", async () => {
    const clock = { t: Date.now() };
    const h = harness({
      now: () => new Date(clock.t),
      config: { maxWallClockMs: 50 },
      executors: {
        tool: async () => {
          clock.t += 100; // the first step burns the whole budget
          return { status: "succeeded", output: {} };
        },
      },
    });
    const first = tool("first");
    const second = tool("second");
    const started = await h.start({ config: cfg([first, second]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("wall clock");
    const rows = await h.stepStore.listForRun(started.run.id);
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      [first.id, "succeeded"],
    ]);
  });

  test("step budget: exceeding maxExecutedStepsPerRun fails the run", async () => {
    const h = harness({
      config: { maxExecutedStepsPerRun: 1 },
      executors: {
        tool: async () => ({ status: "succeeded", output: {} }),
      },
    });
    const started = await h.start({ config: cfg([tool("a"), tool("b")]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("step instances");
  });

  test("oversized step output fails `output_too_large`", async () => {
    const h = harness({
      config: { maxStepOutputBytes: 32 },
      executors: {
        tool: async () => ({
          status: "succeeded",
          output: { blob: "x".repeat(100) },
        }),
      },
    });
    const started = await h.start({ config: cfg([tool("big")]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(
      (await h.stepStore.listForRun(started.run.id))[0]!.errorClass,
    ).toBe("output_too_large");
  });
});

describe("pipeline driver — cancellation", () => {
  test("cancel aborts the in-flight attempt and lands the run canceled", async () => {
    const h = harness({
      executors: {
        tool: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              "abort",
              () =>
                resolve({
                  status: "failed",
                  errorClass: "aborted",
                  error: "aborted",
                  retryable: false,
                }),
              { once: true },
            );
          }),
      },
    });
    const running = tool("running");
    const never = tool("never");
    const started = await h.start({ config: cfg([running, never]) });
    if (!started.started) throw new Error("expected a started run");
    await waitUntil(() => h.stepStore.rows.length === 1);
    expect(h.runner.cancel(started.run.id)).toBeTrue();
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("canceled");
    const rows = await h.stepStore.listForRun(started.run.id);
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      [running.id, "canceled"],
    ]);
    const completed = eventData(
      h.runStore,
      started.run.id,
      "pipeline.completed",
    );
    expect(completed[0]!.status).toBe("canceled");
  });

  test("cancel with no live driver returns false", () => {
    const h = harness({ executors: {} });
    expect(h.runner.cancel("nope")).toBeFalse();
  });
});

describe("pipeline driver — crash-resume from the ledger", () => {
  test("succeeded rows are adopted (no re-execution) and rebuild the scope", async () => {
    const first = tool("first");
    const second = tool("second", { args: { prev: { $ref: "steps.first.v" } } });
    const config = cfg([first, second]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: { done: true },
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running" });
    h.runStore.setStatus(run.id, "running");
    // Previous incarnation: step 1 finished, one event persisted.
    await h.runStore.appendEvent(run.id, 0, {
      type: "pipeline.started",
      data: { stepCount: 2 },
    } as never);
    const claimed = await h.stepStore.claim({
      runId: run.id,
      organizationId: run.organizationId!,
      stepId: first.id,
      stepSlug: "first",
      path: first.id,
      parentPath: null,
      iteration: null,
      kind: "tool",
      status: "running",
      input: { args: {} },
      startedAt: new Date(),
    });
    await h.stepStore.finish(claimed.row.id, {
      status: "succeeded",
      output: { v: 41 },
      completedAt: new Date(),
    });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    // Only step 2 executed, with step 1's persisted output in scope.
    expect(toolExec.calls).toHaveLength(1);
    expect(toolExec.calls[0]!.step.id).toBe(second.id);
    expect(toolExec.calls[0]!.input).toEqual({ args: { prev: 41 } });
    // pipeline.started is NOT re-emitted on resume.
    expect(
      eventTypes(h.runStore, run.id).filter((t) => t === "pipeline.started"),
    ).toHaveLength(1);
  });

  test("interrupted at_most_once tool step fails `interrupted` without re-executing", async () => {
    const risky = tool("risky", { sideEffect: "at_most_once" });
    const config = cfg([risky]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running" });
    h.runStore.setStatus(run.id, "running");
    await h.stepStore.claim({
      runId: run.id,
      organizationId: run.organizationId!,
      stepId: risky.id,
      stepSlug: "risky",
      path: risky.id,
      parentPath: null,
      iteration: null,
      kind: "tool",
      status: "running", // interrupted mid-attempt
      input: { args: {} },
      startedAt: new Date(),
    });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("failed");
    expect(toolExec.calls).toHaveLength(0);
    const row = (await h.stepStore.listForRun(run.id))[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("interrupted");
  });

  test("interrupted at-least-once tool step re-executes with a bumped attempt", async () => {
    const step = tool("again");
    const config = cfg([step]);
    const toolExec = recording(async (ctx) => ({
      status: "succeeded" as const,
      output: { attempt: ctx.attempt },
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running" });
    h.runStore.setStatus(run.id, "running");
    await h.stepStore.claim({
      runId: run.id,
      organizationId: run.organizationId!,
      stepId: step.id,
      stepSlug: "again",
      path: step.id,
      parentPath: null,
      iteration: null,
      kind: "tool",
      status: "running",
      input: { args: {} },
      startedAt: new Date(),
    });
    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    expect(toolExec.calls).toHaveLength(1);
    expect(toolExec.calls[0]!.attempt).toBe(2);
    expect((await h.stepStore.listForRun(run.id))[0]!.attempt).toBe(2);
  });

  test("resume refuses a run whose lock is already held", async () => {
    const h = harness({ executors: {} });
    const run = makeRunRow();
    h.locks.hold(run.id);
    expect(await h.runner.resume(run)).toBe("locked");
  });

  test("resume fails a run whose published config is gone (delivery settled)", async () => {
    const h = harness({
      executors: {},
      loadWorkflowConfig: async () => null,
    });
    const run = makeRunRow({ status: "queued" });
    h.runStore.setStatus(run.id, "queued");
    expect(await h.runner.resume(run)).toBe("failed");
    expect(h.runStore.statuses.get(run.id)?.status).toBe("failed");
    expect(h.deliverCalls).toEqual([
      { runId: run.id, status: "failed", lastAssistantMessage: null },
    ]);
    expect(h.locks.held.size).toBe(0);
  });
});

describe("pipeline driver — resume fidelity (budget, input snapshots, event backfill)", () => {
  /** Claim + optionally finish one top-level ledger row for `run`. */
  async function seedRow(
    h: Harness,
    run: RunRow,
    step: PipelineStep,
    opts: {
      input?: unknown;
      finish?: { status: "succeeded" | "failed"; output?: Record<string, unknown>; error?: string; errorClass?: string };
    } = {},
  ): Promise<void> {
    const claimed = await h.stepStore.claim({
      runId: run.id,
      organizationId: run.organizationId!,
      stepId: step.id,
      stepSlug: step.slug,
      path: step.id,
      parentPath: null,
      iteration: null,
      kind: step.kind,
      status: "running",
      input: opts.input ?? { args: {} },
      startedAt: new Date(),
    });
    if (opts.finish) {
      await h.stepStore.finish(claimed.row.id, {
        status: opts.finish.status,
        ...(opts.finish.output !== undefined ? { output: opts.finish.output } : {}),
        ...(opts.finish.error !== undefined ? { error: opts.finish.error } : {}),
        ...(opts.finish.errorClass !== undefined
          ? { errorClass: opts.finish.errorClass }
          : {}),
        completedAt: new Date(),
      });
    }
  }

  test("an interrupted leaf step retries with its PERSISTED input snapshot, never a re-render", async () => {
    const step = tool("call", { args: { cursor: { $ref: "state.cursor" } } });
    const config = cfg([step]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    // The original attempt rendered {cursor: "orig"}; the workflow state has
    // since MOVED (e.g. a concurrent overlap:"allow" run advanced it), so a
    // re-render against the rebuilt scope would produce DIFFERENT args.
    h.stateStore.state.set(run.workflowId!, new Map([["cursor", "moved"]]));
    await seedRow(h, run, step, { input: { args: { cursor: "orig" } } });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    // The retry executed the ORIGINAL call…
    expect(toolExec.calls).toHaveLength(1);
    expect(toolExec.calls[0]!.input).toEqual({ args: { cursor: "orig" } });
    // …and the persisted snapshot was not overwritten.
    expect((await h.stepStore.listForRun(run.id))[0]!.input).toEqual({
      args: { cursor: "orig" },
    });
  });

  test("an interrupted state step retries its PERSISTED write, not a re-render", async () => {
    const write: PipelineStep = {
      id: newStepId(),
      slug: "save",
      kind: "state",
      set: { prev: { $ref: "state.cursor" } },
    };
    const config = cfg([write]);
    const h = harness({
      executors: {},
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    // The interrupted attempt's write already landed (cursor now "new"); its
    // persisted input snapshot recorded the value it was actually writing.
    h.stateStore.state.set(run.workflowId!, new Map([["cursor", "new"]]));
    await seedRow(h, run, write, { input: { set: { prev: "old" } } });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    // The retry wrote the SAME values as the original attempt.
    expect(h.stateStore.state.get(run.workflowId!)!.get("prev")).toBe("old");
  });

  test("a resumed run keeps the ORIGINAL wall-clock budget — no fresh budget per restart", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const step = tool("late");
    const config = cfg([step]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      config: { maxWallClockMs: 60_000 },
      now: () => new Date(t0.getTime() + 61_000),
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: t0 });
    h.runStore.setStatus(run.id, "running");

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("wall clock");
    expect(toolExec.calls).toHaveLength(0);
    // started_at is preserved: the resume's running mark carries no startedAt.
    const runningMark = h.runStore.statusLog.find(
      (entry) => entry.runId === run.id && entry.patch.status === "running",
    )!;
    expect(runningMark.patch.startedAt).toBeUndefined();
  });

  test("a resumed run's scope `now` stays the ORIGINAL start time", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const step = tool("stamp");
    const config = cfg([step]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      now: () => new Date(t0.getTime() + 5_000),
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: t0 });
    h.runStore.setStatus(run.id, "running");

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    expect(toolExec.calls[0]!.scope.now).toBe(t0.toISOString());
  });

  test("the executed-step budget survives a restart — seeded from the ledger", async () => {
    const a = tool("a");
    const b = tool("b");
    const c = tool("c");
    const config = cfg([a, b, c]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      config: { maxExecutedStepsPerRun: 2 },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    await h.runStore.appendEvent(run.id, 0, {
      type: "pipeline.started",
      data: { stepCount: 3 },
    } as never);
    // The previous incarnation already spent the whole budget on a and b.
    await seedRow(h, run, a, { finish: { status: "succeeded", output: {} } });
    await seedRow(h, run, b, { finish: { status: "succeeded", output: {} } });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("step instances");
    // The restart granted no fresh budget: c never executed.
    expect(toolExec.calls).toHaveLength(0);
  });

  test("the state key cap is enforced against COMMITTED truth, not the run's stale snapshot", async () => {
    const fill = tool("fill");
    const write: PipelineStep = {
      id: newStepId(),
      slug: "save",
      kind: "state",
      set: { extra: "v" },
    };
    const wfId = crypto.randomUUID();
    const h = harness({
      executors: {
        tool: async () => {
          // A concurrent overlap:"allow" run commits 200 keys AFTER this run
          // snapshotted (empty) — the in-memory snapshot is now stale.
          const map = new Map<string, unknown>();
          for (let i = 0; i < 200; i += 1) map.set(`k${i}`, i);
          h.stateStore.state.set(wfId, map);
          return { status: "succeeded", output: {} };
        },
      },
    });
    const config = cfg([fill, write]);
    const started = await h.start({ config, workflow: { id: wfId, config } });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    const row = h.stepStore.rows.find((r) => r.path === write.id)!;
    expect(row.errorClass).toBe("state_cap_exceeded");
    expect(row.error).toContain("200");
    // The over-cap write was refused atomically — nothing landed.
    expect(h.stateStore.state.get(wfId)!.has("extra")).toBeFalse();
  });

  test("resume backfills a terminal step event a crash swallowed between persist and emit", async () => {
    const first = tool("first");
    const second = tool("second");
    const config = cfg([first, second]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    // Crash window: `first`'s terminal row landed, its completed event did not.
    await h.runStore.appendEvent(run.id, 0, {
      type: "pipeline.started",
      data: { stepCount: 2 },
    } as never);
    await h.runStore.appendEvent(run.id, 1, {
      type: "pipeline.step.started",
      data: { stepId: first.id, slug: "first", kind: "tool", path: first.id, attempt: 1 },
    } as never);
    await seedRow(h, run, first, {
      finish: { status: "succeeded", output: { v: 1 } },
    });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    expect(eventTypes(h.runStore, run.id)).toEqual([
      "pipeline.started",
      "pipeline.step.started",
      "pipeline.step.completed", // backfilled for `first` on adoption
      "pipeline.step.started",
      "pipeline.step.completed",
      "pipeline.completed",
    ]);
    const completions = eventData(h.runStore, run.id, "pipeline.step.completed");
    expect(completions[0]).toMatchObject({
      path: first.id,
      status: "succeeded",
      outputPreview: JSON.stringify({ v: 1 }),
    });
  });

  test("resume backfills the terminal FAILED event for an adopted failed row", async () => {
    const bad = tool("bad");
    const config = cfg([bad]);
    const h = harness({
      executors: {},
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    await h.runStore.appendEvent(run.id, 0, {
      type: "pipeline.started",
      data: { stepCount: 1 },
    } as never);
    await h.runStore.appendEvent(run.id, 1, {
      type: "pipeline.step.started",
      data: { stepId: bad.id, slug: "bad", kind: "tool", path: bad.id, attempt: 1 },
    } as never);
    await seedRow(h, run, bad, {
      finish: { status: "failed", error: "server said no", errorClass: "tool_error" },
    });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toBe("server said no");
    const failures = eventData(h.runStore, run.id, "pipeline.step.failed");
    expect(failures).toEqual([
      {
        stepId: bad.id,
        slug: "bad",
        kind: "tool",
        path: bad.id,
        attempt: 1,
        errorClass: "tool_error",
        error: "server said no",
        willRetry: false,
      },
    ]);
  });

  test("resume does NOT duplicate terminal step events that already landed", async () => {
    const first = tool("first");
    const second = tool("second");
    const config = cfg([first, second]);
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({
      executors: { tool: toolExec.exec },
      loadWorkflowConfig: async () => config,
    });
    const run = makeRunRow({ status: "running", startedAt: new Date() });
    h.runStore.setStatus(run.id, "running");
    // `first` fully settled — row AND event — before the crash.
    await h.runStore.appendEvent(run.id, 0, {
      type: "pipeline.started",
      data: { stepCount: 2 },
    } as never);
    await h.runStore.appendEvent(run.id, 1, {
      type: "pipeline.step.started",
      data: { stepId: first.id, slug: "first", kind: "tool", path: first.id, attempt: 1 },
    } as never);
    await h.runStore.appendEvent(run.id, 2, {
      type: "pipeline.step.completed",
      data: {
        stepId: first.id,
        slug: "first",
        kind: "tool",
        path: first.id,
        status: "succeeded",
        durationMs: 1,
      },
    } as never);
    await seedRow(h, run, first, {
      finish: { status: "succeeded", output: { v: 1 } },
    });

    expect(await h.runner.resume(run)).toBe("resumed");
    const terminal = await waitForTerminal(h.runStore, run.id);
    expect(terminal.status).toBe("succeeded");
    const completions = eventData(h.runStore, run.id, "pipeline.step.completed");
    expect(completions.filter((c) => c.path === first.id)).toHaveLength(1);
  });
});

describe("pipeline driver — for_each", () => {
  const loopOver = (
    body: PipelineStep[],
    over: Partial<Extract<PipelineStep, { kind: "for_each" }>> = {},
  ): PipelineStep => ({
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "trigger.items" },
    steps: body,
    maxItems: 100,
    onItemError: "halt",
    ...over,
  });

  test("items run sequentially with isolated body scopes and instance paths", async () => {
    const body = tool("body", { args: { item: { $ref: "item" } } });
    const loop = loopOver([body]);
    const calls: StepExecuteContext[] = [];
    // Scope keys AT CALL TIME (the ctx.scope reference mutates as the item
    // progresses, so isolation must be asserted on a snapshot).
    const stepKeysAtCall: string[][] = [];
    const h = harness({
      executors: {
        tool: async (ctx) => {
          calls.push(ctx);
          stepKeysAtCall.push(Object.keys(ctx.scope.steps));
          return { status: "succeeded", output: { saw: ctx.scope.item } };
        },
      },
    });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: ["a", "b"] } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");

    expect(calls.map((c) => c.input)).toEqual([
      { args: { item: "a" } },
      { args: { item: "b" } },
    ]);
    expect(calls.map((c) => c.path)).toEqual([
      `${loop.id}/0/${body.id}`,
      `${loop.id}/1/${body.id}`,
    ]);
    // Item isolation: item 1's body starts WITHOUT item 0's body output.
    expect(stepKeysAtCall).toEqual([[], []]);
    expect(calls[1]!.scope.item).toBe("b");

    const loopRow = h.stepStore.rows.find((r) => r.path === loop.id)!;
    expect(loopRow.status).toBe("succeeded");
    expect(loopRow.output).toEqual({
      total: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
      items: [
        { index: 0, status: "succeeded" },
        { index: 1, status: "succeeded" },
      ],
    });
    const bodyRows = h.stepStore.rows.filter((r) => r.parentPath === loop.id);
    expect(bodyRows.map((r) => r.iteration)).toEqual([0, 1]);
  });

  test("onItemError continue records item failures without failing the loop", async () => {
    const body = tool("body");
    const loop = loopOver([body], { onItemError: "continue" });
    const h = harness({
      executors: {
        tool: async (ctx) =>
          ctx.scope.item === "bad"
            ? {
                status: "failed",
                errorClass: "tool_error",
                error: "no",
                retryable: false,
              }
            : { status: "succeeded", output: {} },
      },
    });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: ["ok", "bad", "ok2"] } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    const loopRow = h.stepStore.rows.find((r) => r.path === loop.id)!;
    expect(loopRow.output).toMatchObject({ succeeded: 2, failed: 1 });
    expect((loopRow.output as { items: unknown[] }).items[1]).toMatchObject({
      index: 1,
      status: "failed",
      errorClass: "tool_error",
    });
  });

  test("onItemError halt fails the loop (and run) at the first bad item", async () => {
    const body = tool("body");
    const loop = loopOver([body], { onItemError: "halt" });
    let calls = 0;
    const h = harness({
      executors: {
        tool: async () => {
          calls += 1;
          return {
            status: "failed",
            errorClass: "tool_error",
            error: "no",
            retryable: false,
          };
        },
      },
    });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: [1, 2, 3] } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(calls).toBe(1);
    const loopRow = h.stepStore.rows.find((r) => r.path === loop.id)!;
    expect(loopRow.status).toBe("failed");
  });

  test("fan-out overflow fails the loop `fan_out_exceeded` — never truncates", async () => {
    const loop = loopOver([tool("body")], { maxItems: 2 });
    const h = harness({
      executors: { tool: async () => ({ status: "succeeded", output: {} }) },
    });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: [1, 2, 3] } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    const loopRow = h.stepStore.rows.find((r) => r.path === loop.id)!;
    expect(loopRow.errorClass).toBe("fan_out_exceeded");
    expect(h.stepStore.rows).toHaveLength(1); // no item ever ran
  });

  test("non-array items fail `items_not_array`", async () => {
    const loop = loopOver([tool("body")]);
    const h = harness({ executors: {} });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: "nope" } }),
    });
    if (!started.started) throw new Error("expected a started run");
    await waitForTerminal(h.runStore, started.run.id);
    expect(
      h.stepStore.rows.find((r) => r.path === loop.id)!.errorClass,
    ).toBe("items_not_array");
  });
});

describe("pipeline driver — filter + branch + state", () => {
  test("top-level filter false: remaining steps skipped, run succeeds", async () => {
    const gate: PipelineStep = {
      id: newStepId(),
      slug: "gate",
      kind: "filter",
      where: { truthy: { $ref: "trigger.go" } },
    };
    const after = tool("after");
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({ executors: { tool: toolExec.exec } });
    const started = await h.start({
      config: cfg([gate, after]),
      triggerEvent: makeTriggerEvent({ data: { go: false } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    expect(toolExec.calls).toHaveLength(0);
    const rows = await h.stepStore.listForRun(started.run.id);
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      [gate.id, "succeeded"],
      [after.id, "skipped"],
    ]);
    const completions = eventData(
      h.runStore,
      started.run.id,
      "pipeline.step.completed",
    );
    expect(completions.map((c) => c.status)).toEqual(["succeeded", "skipped"]);
  });

  test("filter false inside a for_each drops the current item only", async () => {
    const gate: PipelineStep = {
      id: newStepId(),
      slug: "gate",
      kind: "filter",
      where: { truthy: { $ref: "item" } },
    };
    const body = tool("body");
    const loop: PipelineStep = {
      id: newStepId(),
      slug: "loop",
      kind: "for_each",
      items: { $ref: "trigger.items" },
      steps: [gate, body],
      maxItems: 100,
      onItemError: "halt",
    };
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({ executors: { tool: toolExec.exec } });
    const started = await h.start({
      config: cfg([loop]),
      triggerEvent: makeTriggerEvent({ data: { items: [0, 1] } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    expect(toolExec.calls).toHaveLength(1); // item 0 dropped, item 1 ran
    const loopRow = h.stepStore.rows.find((r) => r.path === loop.id)!;
    expect(loopRow.output).toMatchObject({ skipped: 1, succeeded: 1 });
  });

  test("branch runs the first matching lane and records the decision", async () => {
    const a = tool("a");
    const b = tool("b");
    const c = tool("c");
    const branch: PipelineStep = {
      id: newStepId(),
      slug: "route",
      kind: "branch",
      branches: [
        { when: { eq: [{ $ref: "trigger.x" }, 1] }, steps: [a] },
        { when: { eq: [{ $ref: "trigger.x" }, 2] }, steps: [b] },
      ],
      else: [c],
    };
    const executed: string[] = [];
    const h = harness({
      executors: {
        tool: async (ctx) => {
          executed.push(ctx.step.slug);
          return { status: "succeeded", output: {} };
        },
      },
    });
    const started = await h.start({
      config: cfg([branch]),
      triggerEvent: makeTriggerEvent({ data: { x: 2 } }),
    });
    if (!started.started) throw new Error("expected a started run");
    await waitForTerminal(h.runStore, started.run.id);
    expect(executed).toEqual(["b"]);
    const branchRow = h.stepStore.rows.find((r) => r.path === branch.id)!;
    expect(branchRow.output).toEqual({ lane: 1 });
    expect(
      h.stepStore.rows.find((r) => r.path === `${branch.id}/${b.id}`)?.status,
    ).toBe("succeeded");
  });

  test("branch takes else when no lane matches; null when there is no else", async () => {
    const c = tool("c");
    const withElse: PipelineStep = {
      id: newStepId(),
      slug: "route",
      kind: "branch",
      branches: [{ when: { eq: [{ $ref: "trigger.x" }, 1] }, steps: [tool("a")] }],
      else: [c],
    };
    const executed: string[] = [];
    const h = harness({
      executors: {
        tool: async (ctx) => {
          executed.push(ctx.step.slug);
          return { status: "succeeded", output: {} };
        },
      },
    });
    const started = await h.start({
      config: cfg([withElse]),
      triggerEvent: makeTriggerEvent({ data: { x: 9 } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    expect(executed).toEqual(["c"]);
    expect(
      h.stepStore.rows.find((r) => r.path === withElse.id)!.output,
    ).toEqual({ lane: "else" });
  });

  test("state step writes durable rows, extends the scope, and emits keys only", async () => {
    const write: PipelineStep = {
      id: newStepId(),
      slug: "save",
      kind: "state",
      set: { cursor: { $ref: "trigger.ts" }, note: "fixed" },
    };
    const reader = tool("reader", { args: { c: { $ref: "state.cursor" } } });
    const toolExec = recording(async () => ({
      status: "succeeded" as const,
      output: {},
    }));
    const h = harness({ executors: { tool: toolExec.exec } });
    const wfId = crypto.randomUUID();
    const started = await h.start({
      config: cfg([write, reader]),
      workflow: { id: wfId, config: cfg([write, reader]) },
      triggerEvent: makeTriggerEvent({ data: { ts: "123.45" } }),
    });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    // Durable write landed under the workflow id.
    expect(await h.stateStore.snapshot(started.run.workflowId!)).toEqual({
      cursor: "123.45",
      note: "fixed",
    });
    // Later steps read it through @state.
    expect(toolExec.calls[0]!.input).toEqual({ args: { c: "123.45" } });
    // Events carry KEYS ONLY — never values.
    const updates = eventData(
      h.runStore,
      started.run.id,
      "pipeline.state.updated",
    );
    expect(updates).toEqual([
      { stepId: write.id, path: write.id, keys: ["cursor", "note"] },
    ]);
  });

  test("state value over the byte cap fails `state_value_too_large`", async () => {
    const write: PipelineStep = {
      id: newStepId(),
      slug: "save",
      kind: "state",
      set: { blob: "x".repeat(70 * 1024) },
    };
    const h = harness({ executors: {} });
    const started = await h.start({ config: cfg([write]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(h.stepStore.rows[0]!.errorClass).toBe("state_value_too_large");
    expect(await h.stateStore.snapshot(started.run.workflowId!)).toEqual({});
  });
});

describe("pipeline driver — overlap + executor registry", () => {
  test("overlap 'skip' refuses a second run while one is live", async () => {
    const wfId = crypto.randomUUID();
    const config = cfg(
      [tool("hang", { timeoutMs: 5_000 })],
      { overlap: "skip" },
    );
    const h = harness({
      executors: {
        tool: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              "abort",
              () =>
                resolve({
                  status: "failed",
                  errorClass: "aborted",
                  error: "aborted",
                  retryable: false,
                }),
              { once: true },
            );
          }),
      },
    });
    const first = await h.start({ config, workflow: { id: wfId, config } });
    expect(first.started).toBeTrue();
    const second = await h.start({ config, workflow: { id: wfId, config } });
    expect(second).toEqual({ started: false, reason: "overlap_skipped" });
    // Only the live run holds a handle.
    expect(h.runner.handles.size).toBe(1);
    if (first.started) {
      h.runner.cancel(first.run.id);
      await waitForTerminal(h.runStore, first.run.id);
    }
    // With the first run settled, a third start goes through.
    const third = await h.start({ config, workflow: { id: wfId, config } });
    expect(third.started).toBeTrue();
    if (third.started) {
      h.runner.cancel(third.run.id);
      await waitForTerminal(h.runStore, third.run.id);
    }
  });

  test("a kind with no registered executor fails `executor_unavailable`", async () => {
    const h = harness({ executors: {} });
    const started = await h.start({ config: cfg([tool("orphan")]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(h.stepStore.rows[0]!.errorClass).toBe("executor_unavailable");
  });

  test("an executor THROW is contained as `executor_error`", async () => {
    const h = harness({
      executors: {
        tool: async () => {
          throw new Error("bug");
        },
      },
    });
    const started = await h.start({ config: cfg([tool("boom")]) });
    if (!started.started) throw new Error("expected a started run");
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("failed");
    expect(h.stepStore.rows[0]!.errorClass).toBe("executor_error");
  });
});

describe("pipeline driver — agent-step parking", () => {
  test("waiting outcome parks run + step, then re-invokes with the child id", async () => {
    const agent: PipelineStep = {
      id: newStepId(),
      slug: "delegate",
      kind: "agent",
      agentId: crypto.randomUUID(),
      instructions: { markdown: "do the thing" },
      session: "fresh",
    };
    const childRunId = crypto.randomUUID();
    const invocations: (string | undefined)[] = [];
    const h = harness({
      executors: {
        agent: async (ctx) => {
          invocations.push(ctx.childRunId);
          if (!ctx.childRunId) return { status: "waiting", childRunId };
          return { status: "succeeded", output: { text: "done" } };
        },
      },
    });
    // The child exists (parked) before the parent ever polls it.
    h.runStore.setStatus(childRunId, "waiting");
    const started = await h.start({ config: cfg([agent]) });
    if (!started.started) throw new Error("expected a started run");
    // Parent parks with the child.
    await waitUntil(
      () => h.runStore.statuses.get(started.run.id)?.status === "waiting",
    );
    expect(
      h.stepStore.rows.find((r) => r.path === agent.id)!.status,
    ).toBe("waiting");
    const waitingEvents = eventData(
      h.runStore,
      started.run.id,
      "pipeline.step.waiting",
    );
    expect(waitingEvents).toEqual([
      { stepId: agent.id, slug: "delegate", path: agent.id, childRunId },
    ]);
    // The child resumes and completes → the parent re-invokes with the id.
    h.runStore.setStatus(childRunId, "succeeded");
    h.bus.publish(childRunId, {
      kind: "status",
      frame: { runId: childRunId, status: "succeeded" },
    });
    const terminal = await waitForTerminal(h.runStore, started.run.id);
    expect(terminal.status).toBe("succeeded");
    expect(invocations).toEqual([undefined, childRunId]);
    const row = h.stepStore.rows.find((r) => r.path === agent.id)!;
    expect(row.status).toBe("succeeded");
    expect(row.childRunId).toBe(childRunId);
  });
});

describe("pipeline config knobs", () => {
  test("loadPipelineRunnerConfig: defaults and env overrides", () => {
    expect(loadPipelineRunnerConfig({})).toEqual({
      maxWallClockMs: 30 * 60 * 1000,
      maxExecutedStepsPerRun: 200,
      maxStepOutputBytes: 256 * 1024,
      childPollMs: 5_000,
    });
    expect(
      loadPipelineRunnerConfig({
        PIPELINE_MAX_WALL_CLOCK_MS: "1000",
        PIPELINE_MAX_STEPS_PER_RUN: "7",
        PIPELINE_MAX_STEP_OUTPUT_BYTES: "1024",
        PIPELINE_CHILD_POLL_MS: "50",
      }),
    ).toEqual({
      maxWallClockMs: 1000,
      maxExecutedStepsPerRun: 7,
      maxStepOutputBytes: 1024,
      childPollMs: 50,
    });
    // Invalid values fall back.
    expect(
      loadPipelineRunnerConfig({ PIPELINE_MAX_WALL_CLOCK_MS: "-3" })
        .maxWallClockMs,
    ).toBe(30 * 60 * 1000);
  });

  test("backoffDelayMs: 2s·2ⁿ capped at 60s with half jitter", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(1000);
    expect(backoffDelayMs(2, () => 0)).toBe(2000);
    expect(backoffDelayMs(1, () => 1)).toBe(2000);
    expect(backoffDelayMs(10, () => 1)).toBe(60_000);
  });
});
