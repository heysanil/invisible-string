/**
 * Chat run-state-machine tests: reduce the SAME NDJSON event fixtures the
 * control-plane tailer emits (reused from apps/control-plane) into the thread
 * view model, and assert the rendered block/reply/approval/error states.
 */
import { expect, test } from "bun:test";

import type {
  EveStreamEvent,
  RunEventFrame,
  RunStatus,
} from "@invisible-string/shared";

import {
  addFrame,
  addFrames,
  EMPTY_FRAME_STORE,
  reduceRunView,
  previewValue,
} from "../lib/chat/run-view";

const FIXTURE_DIR = new URL(
  "../../../control-plane/src/runs/fixtures/",
  import.meta.url,
);

async function loadFrames(name: string, runId = "run1"): Promise<RunEventFrame[]> {
  const text = await Bun.file(new URL(name, FIXTURE_DIR)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const event = JSON.parse(line) as EveStreamEvent;
      return {
        runId,
        seq: index,
        event,
        at: event.meta?.at ?? new Date(index * 1000).toISOString(),
      };
    });
}

function runRow(status: RunStatus, message = "hello") {
  return {
    id: "run1",
    status,
    error: null,
    triggerEvent: {
      workflowId: "wf",
      triggerType: "manual",
      message,
      data: {},
      principal: { workspaceId: "ws", source: "chat" },
    },
  } as const;
}

test("completed turn reduces to a working block + final reply", async () => {
  const frames = await loadFrames("mocked-turn-events.ndjson");
  const store = addFrames(EMPTY_FRAME_STORE, frames);
  const view = reduceRunView(runRow("succeeded", "Reply with exactly: pong"), store);

  expect(view.status).toBe("succeeded");
  expect(view.userMessage).toBe("Reply with exactly: pong");
  expect(view.reply?.text).toBe("pong");
  expect(view.reply?.streaming).toBe(false);
  expect(view.error).toBeNull();
  expect(view.pendingInputs.length).toBe(0);
  expect(view.modelId).toBe("deepseek/deepseek-v4-flash");
});

test("parked turn reduces to an awaiting step + pending approval", async () => {
  const frames = await loadFrames("mocked-parked-events.ndjson");
  const store = addFrames(EMPTY_FRAME_STORE, frames);
  const view = reduceRunView(runRow("waiting"), store, "waiting");

  expect(view.status).toBe("waiting");
  expect(view.block).not.toBeNull();
  const step = view.block!.steps.find((s) => s.toolName === "record_note");
  expect(step?.state).toBe("awaiting");

  expect(view.pendingInputs.length).toBe(1);
  const input = view.pendingInputs[0]!;
  expect(input.requestId).toBe("aitxt-nSGF8iACkY4UG2n0C6mG52yN");
  expect(input.toolName).toBe("record_note");
  expect(input.options.map((o) => o.id)).toEqual(["approve", "deny"]);
  expect(input.allowFreeform).toBe(false);
});

test("a resolved action clears its pending approval and marks the step ok", () => {
  const runId = "r";
  const events: EveStreamEvent[] = [
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }], sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "input.requested", data: { requests: [{ requestId: "req1", prompt: "Approve?", action: { callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }, options: [{ id: "approve", label: "Yes" }], display: "confirmation", allowFreeform: false }], sequence: 1, stepIndex: 0, turnId: "t" } },
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "do_thing", output: "ok" }, status: "completed", sequence: 2, stepIndex: 0, turnId: "t" } },
  ];
  let store = EMPTY_FRAME_STORE;
  events.forEach((event, index) => {
    store = addFrame(store, { runId, seq: index, event, at: new Date(index * 1000).toISOString() });
  });
  const view = reduceRunView(runRow("running"), store, "running");
  const step = view.block!.steps.find((s) => s.toolName === "do_thing");
  expect(step?.state).toBe("ok");
  expect(step?.resultPreview).toBe("ok");
  // Once running (not waiting), the answered approval is gone.
  expect(view.pendingInputs.length).toBe(0);
});

test("a streaming reply reads the cumulative messageSoFar and marks streaming", () => {
  const runId = "r";
  const events: EveStreamEvent[] = [
    { type: "message.appended", data: { messageDelta: "Hel", messageSoFar: "Hel", sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "message.appended", data: { messageDelta: "lo", messageSoFar: "Hello", sequence: 1, stepIndex: 0, turnId: "t" } },
  ];
  let store = EMPTY_FRAME_STORE;
  events.forEach((event, index) => {
    store = addFrame(store, { runId, seq: index, event, at: new Date(index * 1000).toISOString() });
  });
  const view = reduceRunView(runRow("running"), store, "running");
  expect(view.reply?.text).toBe("Hello");
  expect(view.reply?.streaming).toBe(true);
});

test("a failed run surfaces the error message", () => {
  const runId = "r";
  const events: EveStreamEvent[] = [
    { type: "step.failed", data: { code: "provider_error", message: "401 rejected", sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "turn.failed", data: { code: "provider_error", message: "401 rejected", sequence: 1, turnId: "t" } },
  ];
  let store = EMPTY_FRAME_STORE;
  events.forEach((event, index) => {
    store = addFrame(store, { runId, seq: index, event, at: new Date(index * 1000).toISOString() });
  });
  const view = reduceRunView(runRow("failed"), store, "failed");
  expect(view.error).toBe("401 rejected");
});

test("frame store dedupes by seq (SSE resume can re-deliver frames)", () => {
  const frame = (seq: number): RunEventFrame => ({
    runId: "r",
    seq,
    event: { type: "turn.started", data: { sequence: seq, turnId: "t" } },
    at: new Date(seq * 1000).toISOString(),
  });
  let store = addFrames(EMPTY_FRAME_STORE, [frame(0), frame(1), frame(2)]);
  expect(store.frames.length).toBe(3);
  // Re-delivering seq 1 & 2 (post-resume replay) is a no-op by identity.
  const before = store;
  store = addFrame(store, frame(1));
  store = addFrame(store, frame(2));
  expect(store).toBe(before);
  expect(store.frames.length).toBe(3);
});

test("out-of-order frames are sorted by seq", () => {
  const frame = (seq: number): RunEventFrame => ({
    runId: "r",
    seq,
    event: { type: "turn.started", data: { sequence: seq, turnId: "t" } },
    at: new Date(seq * 1000).toISOString(),
  });
  let store = addFrame(EMPTY_FRAME_STORE, frame(2));
  store = addFrame(store, frame(0));
  store = addFrame(store, frame(1));
  expect(store.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
});

test("previewValue compacts whitespace and truncates", () => {
  expect(previewValue("  a   b  ")).toBe("a b");
  expect(previewValue(null)).toBeNull();
  expect(previewValue({ a: 1 })).toBe('{"a":1}');
  expect(previewValue("x".repeat(300))?.endsWith("…")).toBe(true);
});
