/**
 * lib/pipeline/run-progress — the single absorption point for `pipeline.*`
 * events and the `run_steps` ledger. These are the semantics both the Runs
 * detail and the editor's run overlay depend on: last-event-wins per stepId,
 * retry attempts staying "running" while `willRetry`, sticky ledger failures,
 * and the sequential-driver iteration counters.
 */
import { describe, expect, test } from "bun:test";
import type {
  PipelineStreamEvent,
  RunStepDto,
  RunStepStatus,
} from "@invisible-string/shared";

import {
  applyPipelineEvent,
  applyPipelineEvents,
  emptyRunProgress,
  progressFromLedger,
  runStatesOf,
} from "../lib/pipeline/run-progress";

// ── event helpers ───────────────────────────────────────────────────────────

function started(
  stepId: string,
  path = stepId,
  attempt = 1,
): PipelineStreamEvent {
  return {
    type: "pipeline.step.started",
    data: { stepId, slug: stepId, kind: "tool", path, attempt },
  };
}

function completed(
  stepId: string,
  path = stepId,
  status: "succeeded" | "skipped" = "succeeded",
  durationMs = 120,
): PipelineStreamEvent {
  return {
    type: "pipeline.step.completed",
    data: { stepId, slug: stepId, kind: "tool", path, status, durationMs },
  };
}

function failed(
  stepId: string,
  willRetry: boolean,
  attempt = 1,
  path = stepId,
): PipelineStreamEvent {
  return {
    type: "pipeline.step.failed",
    data: {
      stepId,
      slug: stepId,
      kind: "tool",
      path,
      attempt,
      errorClass: "unreachable",
      error: "connect timeout",
      willRetry,
    },
  };
}

// ── event folding ───────────────────────────────────────────────────────────

describe("applyPipelineEvent", () => {
  test("started → running with the attempt; completed lands status + duration", () => {
    let progress = emptyRunProgress();
    progress = applyPipelineEvent(progress, started("st_a"));
    expect(runStatesOf(progress).get("st_a")).toEqual({
      status: "running",
      attempt: 1,
    });

    progress = applyPipelineEvent(progress, completed("st_a", "st_a", "succeeded", 420));
    expect(runStatesOf(progress).get("st_a")).toEqual({
      status: "succeeded",
      durationMs: 420,
      attempt: 1,
    });
  });

  test("a willRetry failure stays running; the retry bumps the attempt; a hard failure settles", () => {
    let progress = applyPipelineEvents(emptyRunProgress(), [
      started("st_a"),
      failed("st_a", true, 1),
    ]);
    expect(runStatesOf(progress).get("st_a")?.status).toBe("running");

    progress = applyPipelineEvent(progress, started("st_a", "st_a", 2));
    expect(runStatesOf(progress).get("st_a")).toEqual({
      status: "running",
      attempt: 2,
    });

    progress = applyPipelineEvent(progress, failed("st_a", false, 2));
    expect(runStatesOf(progress).get("st_a")).toEqual({
      status: "failed",
      attempt: 2,
    });
  });

  test("waiting parks the step (agent child HITL)", () => {
    const progress = applyPipelineEvents(emptyRunProgress(), [
      started("st_a"),
      {
        type: "pipeline.step.waiting",
        data: { stepId: "st_a", slug: "st_a", path: "st_a", childRunId: "run-c" },
      },
    ]);
    expect(runStatesOf(progress).get("st_a")).toEqual({
      status: "waiting",
      attempt: 1,
    });
  });

  test("run-level bookends and state notices change nothing per-step", () => {
    const before = applyPipelineEvent(emptyRunProgress(), started("st_a"));
    const after = applyPipelineEvents(before, [
      { type: "pipeline.started", data: { stepCount: 3 } },
      { type: "pipeline.state.updated", data: { stepId: "st_s", path: "st_s", keys: ["cursor"] } },
      { type: "pipeline.completed", data: { status: "succeeded", durationMs: 900 } },
    ]);
    expect(runStatesOf(after)).toEqual(runStatesOf(before));
  });

  test("sequential loop iterations: item n in flight ⇒ done = n; loop completion finalizes done = total", () => {
    let progress = applyPipelineEvents(emptyRunProgress(), [
      started("st_loop"),
      started("st_b", "st_loop/0/st_b"),
      completed("st_b", "st_loop/0/st_b"),
    ]);
    expect(runStatesOf(progress).get("st_loop")?.iterations).toEqual({
      done: 0,
      total: null,
    });

    progress = applyPipelineEvents(progress, [
      started("st_b", "st_loop/1/st_b"),
      completed("st_b", "st_loop/1/st_b"),
      started("st_b", "st_loop/2/st_b"),
    ]);
    // Working item 3 (index 2) — two items are finished.
    expect(runStatesOf(progress).get("st_loop")?.iterations).toEqual({
      done: 2,
      total: null,
    });
    // The body step itself reads as one card (last event wins).
    expect(runStatesOf(progress).get("st_b")?.status).toBe("running");

    progress = applyPipelineEvents(progress, [
      completed("st_b", "st_loop/2/st_b"),
      completed("st_loop", "st_loop", "succeeded", 5000),
    ]);
    expect(runStatesOf(progress).get("st_loop")).toEqual({
      status: "succeeded",
      durationMs: 5000,
      attempt: 1,
      iterations: { done: 3, total: 3 },
    });
  });
});

// ── ledger seeding ──────────────────────────────────────────────────────────

let rowSeq = 0;

function row(
  stepId: string,
  status: RunStepStatus,
  overrides: Partial<RunStepDto> = {},
): RunStepDto {
  rowSeq += 1;
  return {
    id: `rs_${rowSeq}`,
    runId: "run-1",
    stepId,
    slug: stepId,
    kind: "tool",
    status,
    path: stepId,
    parentPath: null,
    iteration: null,
    attempt: 1,
    errorClass: null,
    error: null,
    childRunId: null,
    outputPreview: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    completedAt:
      status === "running" || status === "pending" || status === "waiting"
        ? null
        : "2026-07-10T00:00:01.500Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("progressFromLedger", () => {
  test("seeds status, attempt and wall-clock duration per step", () => {
    const states = runStatesOf(
      progressFromLedger([
        row("st_a", "succeeded", { attempt: 2 }),
        row("st_b", "running"),
      ]),
    );
    expect(states.get("st_a")).toEqual({
      status: "succeeded",
      attempt: 2,
      durationMs: 1500,
    });
    expect(states.get("st_b")).toEqual({ status: "running", attempt: 1 });
  });

  test("a failed instance STICKS even when later iterations succeeded (onItemError: continue)", () => {
    const states = runStatesOf(
      progressFromLedger([
        row("st_b", "failed", { path: "st_loop/0/st_b", iteration: 0 }),
        row("st_b", "succeeded", { path: "st_loop/1/st_b", iteration: 1 }),
      ]),
    );
    expect(states.get("st_b")?.status).toBe("failed");
  });

  test("loop iteration counters: done counts fully-terminal items; total fills once the loop settles", () => {
    const live = runStatesOf(
      progressFromLedger([
        row("st_loop", "running", { kind: "for_each" }),
        row("st_b", "succeeded", { path: "st_loop/0/st_b", iteration: 0 }),
        row("st_b", "running", { path: "st_loop/1/st_b", iteration: 1 }),
      ]),
    );
    expect(live.get("st_loop")?.iterations).toEqual({ done: 1, total: null });

    const settled = runStatesOf(
      progressFromLedger([
        row("st_loop", "succeeded", { kind: "for_each" }),
        row("st_b", "succeeded", { path: "st_loop/0/st_b", iteration: 0 }),
        row("st_b", "succeeded", { path: "st_loop/1/st_b", iteration: 1 }),
        row("st_b", "skipped", { path: "st_loop/2/st_b", iteration: 2 }),
      ]),
    );
    expect(settled.get("st_loop")?.iterations).toEqual({ done: 3, total: 3 });
  });

  test("live events fold on top of a ledger seed", () => {
    const seeded = progressFromLedger([row("st_a", "succeeded")]);
    const folded = applyPipelineEvents(seeded, [
      started("st_b"),
      completed("st_b", "st_b", "succeeded", 90),
    ]);
    expect(runStatesOf(folded).get("st_a")?.status).toBe("succeeded");
    expect(runStatesOf(folded).get("st_b")).toEqual({
      status: "succeeded",
      durationMs: 90,
      attempt: 1,
    });
  });
});
