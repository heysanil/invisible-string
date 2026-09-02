/**
 * Event-appender unit tests: seq claimed like a resuming tailer (count of
 * already-persisted events), monotonic increments, bus mirroring, and the
 * status-frame helper.
 */
import { describe, expect, test } from "bun:test";

import { RunEventBus, type RunStreamFrame } from "../runs/bus";
import { createPipelineEventAppender, publishRunStatus } from "./events";
import { createMemoryRunStore } from "./test-support";

describe("createPipelineEventAppender", () => {
  test("fresh run: seq starts at 0 and increments; frames mirror to the bus", async () => {
    const store = createMemoryRunStore();
    const bus = new RunEventBus();
    const frames: RunStreamFrame[] = [];
    bus.subscribe("run-1", (frame) => frames.push(frame));

    const appender = await createPipelineEventAppender({
      runStore: store,
      bus,
      runId: "run-1",
    });
    expect(appender.baseSeq).toBe(0);
    await appender.emit({ type: "pipeline.started", data: { stepCount: 2 } });
    await appender.emit({
      type: "pipeline.completed",
      data: { status: "succeeded", durationMs: 5 },
    });

    expect(store.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(frames).toHaveLength(2);
    const first = frames[0]!;
    if (first.kind !== "event") throw new Error("expected an event frame");
    expect(first.frame.seq).toBe(0);
    expect(first.frame.event.type).toBe("pipeline.started");
    expect(first.frame.runId).toBe("run-1");
  });

  test("resumed run: base seq lands after persisted history", async () => {
    const store = createMemoryRunStore();
    const bus = new RunEventBus();
    // Two events persisted by a previous incarnation.
    await store.appendEvent("run-2", 0, {
      type: "pipeline.started",
      data: { stepCount: 1 },
    } as never);
    await store.appendEvent("run-2", 1, {
      type: "pipeline.step.started",
      data: {},
    } as never);

    const appender = await createPipelineEventAppender({
      runStore: store,
      bus,
      runId: "run-2",
    });
    expect(appender.baseSeq).toBe(2);
    await appender.emit({
      type: "pipeline.completed",
      data: { status: "failed", durationMs: 1 },
    });
    expect(store.events.at(-1)?.seq).toBe(2);
  });

  test("appender seq is per-run (no cross-run bleed)", async () => {
    const store = createMemoryRunStore();
    const bus = new RunEventBus();
    await store.appendEvent("other", 0, {
      type: "pipeline.started",
      data: { stepCount: 1 },
    } as never);
    const appender = await createPipelineEventAppender({
      runStore: store,
      bus,
      runId: "run-3",
    });
    expect(appender.baseSeq).toBe(0);
  });
});

describe("publishRunStatus", () => {
  test("publishes a status frame, carrying the error only when present", () => {
    const bus = new RunEventBus();
    const frames: RunStreamFrame[] = [];
    bus.subscribe("run-4", (frame) => frames.push(frame));
    publishRunStatus(bus, "run-4", "running");
    publishRunStatus(bus, "run-4", "failed", "boom");
    expect(frames).toEqual([
      { kind: "status", frame: { runId: "run-4", status: "running" } },
      {
        kind: "status",
        frame: { runId: "run-4", status: "failed", error: "boom" },
      },
    ]);
  });
});
