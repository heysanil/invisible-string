/**
 * Chat run-state-machine tests: reduce the SAME NDJSON event fixtures the
 * control-plane tailer emits (reused from apps/control-plane) into the thread
 * view model, and assert the rendered segment timeline / approval / error
 * states.
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
  inputRequestKindOf,
  reduceRunView,
  previewValue,
  type RunSegment,
  type SpeechSegment,
  type ThoughtItem,
  type ToolItem,
  type WorkSegment,
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
      agentId: "agent",
      workflowId: null,
      triggerType: "manual",
      message,
      data: {},
      principal: { workspaceId: "ws", source: "chat" },
    },
  } as const;
}

function frame(seq: number, event: EveStreamEvent, atSec = seq): RunEventFrame {
  return {
    runId: "run1",
    seq,
    event,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, atSec)).toISOString(),
  };
}
function think(seq: number, turnId: string, stepIndex: number, soFar: string, atSec = seq) {
  return frame(seq, {
    type: "reasoning.appended",
    data: { reasoningDelta: soFar, reasoningSoFar: soFar, sequence: 0, stepIndex, turnId },
  } as EveStreamEvent, atSec);
}
function thoughtDone(seq: number, turnId: string, stepIndex: number, text: string, atSec = seq) {
  return frame(seq, {
    type: "reasoning.completed",
    data: { reasoning: text, sequence: 0, stepIndex, turnId },
  } as EveStreamEvent, atSec);
}
function say(seq: number, turnId: string, stepIndex: number, soFar: string, atSec = seq) {
  return frame(seq, {
    type: "message.appended",
    data: { messageDelta: soFar, messageSoFar: soFar, sequence: 0, stepIndex, turnId },
  } as EveStreamEvent, atSec);
}
function said(
  seq: number, turnId: string, stepIndex: number,
  message: string | null, finishReason: string, atSec = seq,
) {
  return frame(seq, {
    type: "message.completed",
    data: { finishReason, message, sequence: 0, stepIndex, turnId },
  } as EveStreamEvent, atSec);
}
function toolCall(seq: number, turnId: string, stepIndex: number, callId: string, toolName: string, atSec = seq) {
  return frame(seq, {
    type: "actions.requested",
    data: {
      actions: [{ callId, kind: "tool-call", toolName, input: {} }],
      sequence: 0, stepIndex, turnId,
    },
  } as EveStreamEvent, atSec);
}
function toolDone(seq: number, turnId: string, stepIndex: number, callId: string, toolName: string, output: string, atSec = seq) {
  return frame(seq, {
    type: "action.result",
    data: {
      result: { callId, kind: "tool-result", toolName, output },
      status: "completed",
      sequence: 0, stepIndex, turnId,
    },
  } as EveStreamEvent, atSec);
}
const kinds = (view: { segments: readonly RunSegment[] }) => view.segments.map((s) => s.kind);
const workItems = (view: { segments: readonly RunSegment[] }) =>
  view.segments.flatMap((s) => (s.kind === "work" ? [...s.items] : []));
const toolItems = (view: { segments: readonly RunSegment[] }) =>
  workItems(view).filter((i): i is ToolItem => i.kind === "tool");
const lastSpeech = (view: { segments: readonly RunSegment[] }): SpeechSegment | undefined => {
  const speech = view.segments.filter((s): s is SpeechSegment => s.kind === "speech");
  return speech[speech.length - 1];
};

// ── The segment timeline (spike/REPORT.md findings 30–33) ───────────────────

test("thoughts and tools interleave in frame order inside one segment", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "First thought"),
    thoughtDone(1, "t0", 0, "First thought"),
    toolCall(2, "t0", 0, "c1", "list_runs"),
    toolDone(3, "t0", 0, "c1", "list_runs", "14 runs"),
    think(4, "t0", 1, "Second thought"),
    thoughtDone(5, "t0", 1, "Second thought"),
    toolCall(6, "t0", 1, "c2", "get_log"),
    toolDone(7, "t0", 1, "c2", "get_log", "8.2 KB"),
  ]));
  expect(kinds(view)).toEqual(["work"]);
  expect(workItems(view).map((i) => i.kind)).toEqual(["thought", "tool", "thought", "tool"]);
  // Symptom 1: BOTH thoughts survive.
  expect(workItems(view).filter((i) => i.kind === "thought").map((i) => (i as ThoughtItem).text))
    .toEqual(["First thought", "Second thought"]);
});

test("mid-run narration segments the run into work / speech / work", () => {
  // Finding 32: message.completed(tool-calls) precedes its actions.requested.
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "Planning"),
    thoughtDone(1, "t0", 0, "Planning"),
    say(2, "t0", 0, "Let me check"),
    said(3, "t0", 0, "Let me check", "tool-calls"),
    toolCall(4, "t0", 1, "c1", "get_log"),
    toolDone(5, "t0", 1, "c1", "get_log", "8.2 KB"),
    say(6, "t0", 2, "Found it"),
    said(7, "t0", 2, "Found it", "stop"),
  ]));
  // Symptom 2: the narration sits BETWEEN the thought and the tool, not after.
  expect(kinds(view)).toEqual(["work", "speech", "work", "speech"]);
  expect((view.segments[1] as SpeechSegment).text).toBe("Let me check");
  expect((view.segments[3] as SpeechSegment).text).toBe("Found it");
});

test("streaming text keeps one stable key from first append through completion", () => {
  const appended = reduceRunView(runRow("running"), addFrames(EMPTY_FRAME_STORE, [
    say(0, "t0", 0, "Half a sen"),
  ]), "running");
  const completed = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    say(0, "t0", 0, "Half a sen"),
    said(1, "t0", 0, "Half a sentence", "tool-calls"),
  ]));
  // Symptom 3: same key, so React never remounts and the text never relocates.
  expect(appended.segments[0]!.key).toBe(completed.segments[0]!.key);
  expect(completed.segments[0]!.kind).toBe("speech");
});

test("one step emitting a thought and a message yields distinct segment keys", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "Thinking"),
    thoughtDone(1, "t0", 0, "Thinking"),
    say(2, "t0", 0, "Speaking"),
    said(3, "t0", 0, "Speaking", "stop"),
  ]));
  expect(view.segments).toHaveLength(2);
  expect(view.segments[0]!.key).not.toBe(view.segments[1]!.key);
});

test("a blank or null message.completed creates nothing and splits nothing", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    toolCall(0, "t0", 0, "c1", "noop"),
    toolDone(1, "t0", 0, "c1", "noop", "ok"),
    said(2, "t0", 0, null, "stop"),
    said(3, "t0", 0, "   ", "stop"),
    toolCall(4, "t0", 1, "c2", "noop2"),
    toolDone(5, "t0", 1, "c2", "noop2", "ok"),
  ]));
  expect(kinds(view)).toEqual(["work"]);
  expect(workItems(view)).toHaveLength(2);
});

test("a bare message.completed with no prior append still creates a speech segment", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    said(0, "t0", 0, "All at once", "stop"),
  ]));
  expect(kinds(view)).toEqual(["speech"]);
  expect((view.segments[0] as SpeechSegment).text).toBe("All at once");
});

// ── Ordinals, global upsert, and the partial guard ──────────────────────────

test("interleaved reasoning at ONE stepIndex yields two thoughts, not an overwrite", () => {
  // spike/REPORT.md finding 30: a text-delta seals the reasoning block and
  // RESETS eve's accumulator, so the second block restarts from empty at the
  // SAME (turnId, stepIndex). A plain upsert would lose the first.
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "First thought"),
    thoughtDone(1, "t0", 0, "First thought"),
    say(2, "t0", 0, "Hi"),
    said(3, "t0", 0, "Hi", "tool-calls"),
    think(4, "t0", 0, "Second thought"),
    thoughtDone(5, "t0", 0, "Second thought"),
  ]));
  expect(kinds(view)).toEqual(["work", "speech", "work"]);
  expect(workItems(view).map((i) => (i as ThoughtItem).text))
    .toEqual(["First thought", "Second thought"]);
  // Both work segments must have DISTINCT keys or React recycles the box.
  expect(view.segments[0]!.key).not.toBe(view.segments[2]!.key);
});

test("two message.completed at one stepIndex yield two speech segments", () => {
  // finding 31: flushCurrentMessage resets eve's message accumulator and fires
  // on every tool request while it is non-empty.
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    say(0, "t0", 0, "First half"),
    said(1, "t0", 0, "First half", "tool-calls"),
    toolCall(2, "t0", 0, "c1", "get_log"),
    toolDone(3, "t0", 0, "c1", "get_log", "ok"),
    say(4, "t0", 0, "Second half"),
    said(5, "t0", 0, "Second half", "stop"),
  ]));
  expect(kinds(view)).toEqual(["speech", "work", "speech"]);
  expect((view.segments[0] as SpeechSegment).text).toBe("First half");
  expect((view.segments[2] as SpeechSegment).text).toBe("Second half");
  expect(view.segments[0]!.key).not.toBe(view.segments[2]!.key);
});

test("reason -> tool -> reason at one step is ONE thought sealed after the tool", () => {
  // finding 33: only TEXT splits a reasoning block. The trailing
  // reasoning.completed legitimately arrives after the step's tool events.
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "Part one"),
    toolCall(1, "t0", 0, "c1", "get_log"),
    toolDone(2, "t0", 0, "c1", "get_log", "ok"),
    think(3, "t0", 0, "Part one and part two"),
    thoughtDone(4, "t0", 0, "Part one and part two", 6),
  ]));
  expect(kinds(view)).toEqual(["work"]);
  const items = workItems(view);
  expect(items).toHaveLength(2);
  expect((items[0] as ThoughtItem).text).toBe("Part one and part two");
  expect((items[0] as ThoughtItem).streaming).toBe(false);
  expect((items[0] as ThoughtItem).seconds).toBe(6);
});

test("a late action.result updates its item in a closed segment, in place", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    toolCall(0, "t0", 0, "c1", "slow_tool"),
    say(1, "t0", 0, "Working on it"),
    said(2, "t0", 0, "Working on it", "tool-calls"),
    toolDone(3, "t0", 0, "c1", "slow_tool", "finally"),
  ]));
  // No duplicate item, no second work segment, and the result landed upstream.
  expect(kinds(view)).toEqual(["work", "speech"]);
  const items = workItems(view);
  expect(items).toHaveLength(1);
  expect((items[0] as ToolItem).state).toBe("ok");
  expect((items[0] as ToolItem).resultPreview).toBe("finally");
});

test("action.partial after action.result does not walk the step backwards", () => {
  const view = reduceRunView(runRow("succeeded"), addFrames(EMPTY_FRAME_STORE, [
    toolCall(0, "t0", 0, "c1", "retried"),
    toolDone(1, "t0", 0, "c1", "retried", "final output"),
    frame(2, {
      type: "action.partial",
      data: {
        result: { callId: "c1", toolName: "retried", output: "stale partial" },
        sequence: 0, stepIndex: 0, turnId: "t0",
      },
    } as EveStreamEvent),
  ]));
  const items = workItems(view);
  expect(items).toHaveLength(1);
  expect((items[0] as ToolItem).state).toBe("ok");
  expect((items[0] as ToolItem).resultPreview).toBe("final output");
});

test("completed turn reduces to a timeline ending in the final reply", async () => {
  const frames = await loadFrames("mocked-turn-events.ndjson");
  const store = addFrames(EMPTY_FRAME_STORE, frames);
  const view = reduceRunView(runRow("succeeded", "Reply with exactly: pong"), store);

  expect(view.status).toBe("succeeded");
  expect(view.userMessage).toBe("Reply with exactly: pong");
  const last = view.segments[view.segments.length - 1];
  expect(last?.kind).toBe("speech");
  expect((last as SpeechSegment).text).toBe("pong");
  expect((last as SpeechSegment).streaming).toBe(false);
  expect(view.error).toBeNull();
  expect(view.pendingInputs.length).toBe(0);
  expect(view.modelId).toBe("deepseek/deepseek-v4-flash");
});

test("parked turn reduces to an awaiting step + pending approval", async () => {
  const frames = await loadFrames("mocked-parked-events.ndjson");
  const store = addFrames(EMPTY_FRAME_STORE, frames);
  const view = reduceRunView(runRow("waiting"), store, "waiting");

  expect(view.status).toBe("waiting");
  expect(kinds(view)).toEqual(["work"]);
  const step = toolItems(view).find((s) => s.toolName === "record_note");
  expect(step?.state).toBe("awaiting");
  // The box the user is blocked inside says so.
  const work = view.segments[0];
  expect(work?.kind === "work" && work.waiting).toBe(true);

  expect(view.pendingInputs.length).toBe(1);
  const input = view.pendingInputs[0]!;
  // The id is a captured eve request id — assert its SHAPE, not its bytes, so
  // re-capturing the fixture against a newer eve doesn't break the reducer's
  // contract test (the shared fixture directory is the tailer's to refresh).
  expect(input.requestId.length).toBeGreaterThan(0);
  expect(input.toolName).toBe("record_note");
  expect(input.kind).toBe("tool-approval");
  expect(input.options.map((o) => o.id)).toEqual(["approve", "deny"]);
  expect(input.allowFreeform).toBe(false);
});

test("stopping a PARKED run: the settled row beats the frozen live status", async () => {
  // Regression. A parked run's stream is closed at `waiting` and never
  // reopens, so its live status is frozen there permanently. Stopping it
  // settles the ROW to `canceled` with no stream left to announce it — so a
  // naive `statusOverride ?? run.status` kept rendering `waiting` forever:
  // approval card still on screen AND answerable, composer stuck disabled,
  // Stop button back again, no stopped-notice, until the user navigated away.
  const frames = await loadFrames("mocked-parked-events.ndjson");
  const store = addFrames(EMPTY_FRAME_STORE, frames);

  // "waiting" is exactly what use-thread-streams still holds for this run.
  const view = reduceRunView(runRow("canceled"), store, "waiting");

  expect(view.status).toBe("canceled");
  expect(view.canceled).toBe(true);
  // The card must go: answering an input on a canceled run is a dead POST.
  expect(view.pendingInputs.length).toBe(0);

  // The override MUST still win while the row is unsettled — a running run's
  // live frames are genuinely fresher than the last fetched row.
  const live = reduceRunView(runRow("queued"), store, "waiting");
  expect(live.status).toBe("waiting");
  expect(live.pendingInputs.length).toBe(1);
});

test("a resolved action clears its pending approval and marks the step ok", () => {
  const runId = "r";
  const events: EveStreamEvent[] = [
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }], sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "input.requested", data: { requests: [{ requestId: "req1", kind: "tool-approval", prompt: "Approve?", action: { callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }, options: [{ id: "approve", label: "Yes" }], display: "confirmation", allowFreeform: false }], sequence: 1, stepIndex: 0, turnId: "t" } },
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "do_thing", output: "ok" }, status: "completed", sequence: 2, stepIndex: 0, turnId: "t" } },
  ];
  let store = EMPTY_FRAME_STORE;
  events.forEach((event, index) => {
    store = addFrame(store, { runId, seq: index, event, at: new Date(index * 1000).toISOString() });
  });
  const view = reduceRunView(runRow("running"), store, "running");
  const step = toolItems(view).find((s) => s.toolName === "do_thing");
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
  expect(lastSpeech(view)?.text).toBe("Hello");
  expect(lastSpeech(view)?.streaming).toBe(true);
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

// ── eve 0.31: turn.cancelled is a user decision, never a failure ────────────

/** The exact 0.31 shape captured in spike/tests/fixtures/mocked-cancelled-events.ndjson. */
function canceledTurnFrames(): EveStreamEvent[] {
  return [
    { type: "turn.started", data: { sequence: 0, turnId: "t" } },
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "slow_task", input: { seconds: 5 } }, { callId: "c2", kind: "tool-call", toolName: "never_ran", input: {} }], sequence: 0, stepIndex: 0, turnId: "t" } },
    // Cancellation is COOPERATIVE: the in-flight call still lands its result.
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "slow_task", output: "slept" }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "message.appended", data: { messageDelta: "Half a", messageSoFar: "Half a sentence", sequence: 0, stepIndex: 1, turnId: "t" } },
    { type: "turn.cancelled", data: { sequence: 0, turnId: "t" } },
    { type: "session.waiting", data: { wait: "next-user-message" } },
  ];
}

function storeOf(events: EveStreamEvent[]) {
  let store = EMPTY_FRAME_STORE;
  events.forEach((event, index) => {
    store = addFrame(store, {
      runId: "r",
      seq: index,
      event,
      at: new Date(index * 1000).toISOString(),
    });
  });
  return store;
}

test("turn.cancelled lands a stopped run — no error, and never the failure arm", () => {
  const view = reduceRunView(runRow("canceled"), storeOf(canceledTurnFrames()), "canceled");
  expect(view.canceled).toBe(true);
  // THE regression this test exists for: cancellation must not read as failure.
  expect(view.error).toBeNull();
  expect(view.status).not.toBe("failed");
});

test("a cancelled turn freezes its partial reply instead of blinking on forever", () => {
  // The status frame lags the event, so the run row still says "running".
  const view = reduceRunView(runRow("running"), storeOf(canceledTurnFrames()), "running");
  expect(view.canceled).toBe(true);
  expect(lastSpeech(view)?.text).toBe("Half a sentence");
  expect(lastSpeech(view)?.streaming).toBe(false);
  const work = view.segments.find((s) => s.kind === "work");
  expect(work?.kind === "work" && work.active).toBe(false);
});

test("a cancelled turn demotes only the steps that never settled", () => {
  const view = reduceRunView(runRow("canceled"), storeOf(canceledTurnFrames()), "canceled");
  const steps = toolItems(view);
  expect(steps.find((s) => s.toolName === "slow_task")?.state).toBe("ok");
  expect(steps.find((s) => s.toolName === "never_ran")?.state).toBe("canceled");
});

test("a cancelled turn retires unanswered input requests (answering one is stale)", () => {
  const events: EveStreamEvent[] = [
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }], sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "input.requested", data: { requests: [{ requestId: "req1", kind: "tool-approval", prompt: "Approve?", action: { callId: "c1", kind: "tool-call", toolName: "do_thing", input: {} }, options: [{ id: "approve", label: "Yes" }], display: "confirmation", allowFreeform: false }], sequence: 1, stepIndex: 0, turnId: "t" } },
    { type: "turn.cancelled", data: { sequence: 2, turnId: "t" } },
    { type: "session.waiting", data: { wait: "next-user-message" } },
  ];
  // Even addressed as still-waiting, the retired request must not be offered.
  const view = reduceRunView(runRow("waiting"), storeOf(events), "waiting");
  expect(view.pendingInputs.length).toBe(0);
  expect(view.error).toBeNull();
});

test("context.cleared marks the run and retires pending requests", () => {
  const events: EveStreamEvent[] = [
    { type: "input.requested", data: { requests: [{ requestId: "req1", kind: "question", prompt: "Which one?", action: { callId: "c1", kind: "tool-call", toolName: "ask_question", input: {} }, options: [], display: "text", allowFreeform: true }], sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "context.cleared", data: { sequence: 1, sessionId: "s1", turnId: "t" } },
    { type: "session.waiting", data: { wait: "next-user-message" } },
  ];
  const view = reduceRunView(runRow("waiting"), storeOf(events), "waiting");
  expect(view.contextCleared).toBe(true);
  expect(view.pendingInputs.length).toBe(0);
});

test("action.partial previews live tool output without settling the step", () => {
  const events: EveStreamEvent[] = [
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "crawl", input: {} }], sequence: 0, stepIndex: 0, turnId: "t" } },
    { type: "action.partial", data: { result: { callId: "c1", kind: "tool-result", toolName: "crawl", output: "12 pages so far" }, sequence: 1, stepIndex: 0, turnId: "t" } },
  ];
  const view = reduceRunView(runRow("running"), storeOf(events), "running");
  const step = toolItems(view)[0]!;
  expect(step.state).toBe("pending");
  expect(step.resultPreview).toBe("12 pages so far");
});

// ── active, waiting, and streaming derivations ──────────────────────────────

test("a run parked on approval is NOT active and shows no live counter", async () => {
  // `waiting` is UNSETTLED (api.ts isRunSettledStatus = succeeded|failed|canceled),
  // so deriving `active` from settledness alone would spin for as long as the
  // human takes to answer.
  const frames = await loadFrames("mocked-parked-events.ndjson");
  const view = reduceRunView(runRow("waiting"), addFrames(EMPTY_FRAME_STORE, frames), "waiting");
  const work = view.segments.filter((s) => s.kind === "work") as WorkSegment[];
  const last = work[work.length - 1]!;
  expect(last.active).toBe(false);
  expect(last.waiting).toBe(true);
  expect(view.pendingInputs.length).toBeGreaterThan(0);
});

test("a cancelled turn freezes partial speech AND partial thought", () => {
  // Cancellation emits NO message.completed / reasoning.completed, so clearing
  // `streaming` only on completion would blink forever. run-view.test.ts:205
  // is the original invariant; this extends it to thoughts.
  const view = reduceRunView(runRow("running"), addFrames(EMPTY_FRAME_STORE, [
    think(0, "t0", 0, "Mid thou"),
    say(1, "t0", 1, "Half a sentence"),
    frame(2, { type: "turn.cancelled", data: {} } as EveStreamEvent),
  ]), "running");
  expect(view.canceled).toBe(true);
  const thought = workItems(view)[0] as ThoughtItem;
  expect(thought.text).toBe("Mid thou");
  expect(thought.streaming).toBe(false);
  const speech = view.segments.find((s) => s.kind === "speech") as SpeechSegment;
  expect(speech.text).toBe("Half a sentence");
  expect(speech.streaming).toBe(false);
});

test("a failed run replayed with an unterminated append shows no caret", () => {
  const view = reduceRunView(runRow("failed"), addFrames(EMPTY_FRAME_STORE, [
    say(0, "t0", 0, "Cut off mid-"),
  ]));
  expect((view.segments[0] as SpeechSegment).streaming).toBe(false);
});

test("only the LAST work segment can be active; earlier ones are sealed", () => {
  const view = reduceRunView(runRow("running"), addFrames(EMPTY_FRAME_STORE, [
    toolCall(0, "t0", 0, "c1", "first"),
    toolDone(1, "t0", 0, "c1", "first", "ok"),
    say(2, "t0", 0, "Interim"),
    said(3, "t0", 0, "Interim", "tool-calls"),
    toolCall(4, "t0", 1, "c2", "second"),
  ]), "running");
  const work = view.segments.filter((s) => s.kind === "work") as WorkSegment[];
  expect(work[0]!.sealed).toBe(true);
  expect(work[0]!.active).toBe(false);
  expect(work[1]!.sealed).toBe(false);
  expect(work[1]!.active).toBe(true);
  expect(work[1]!.startedAt).not.toBeNull();
});

// ── HITL kind discriminator ─────────────────────────────────────────────────

test("the HITL card routes on eve's kind, and a session-limit prompt hides its shim tool", () => {
  const events: EveStreamEvent[] = [
    { type: "input.requested", data: { requests: [{ requestId: "s1:limit:input:40120433", kind: "session-limit", prompt: "This session has hit the input-token limit (40M) per session.", action: { callId: "s1:limit:input:40120433", kind: "tool-call", toolName: "session_limit_continuation", input: { kind: "input", limit: 40000000, usedTokens: 40120433 } }, options: [{ id: "continue", label: "Approve", description: "Grant a fresh token budget", style: "primary" }, { id: "stop", label: "Stop", description: "Stop now", style: "danger" }], display: "confirmation", allowFreeform: false }], sequence: 0, stepIndex: 0, turnId: "t" } },
  ];
  const input = reduceRunView(runRow("waiting"), storeOf(events), "waiting").pendingInputs[0]!;
  expect(input.kind).toBe("session-limit");
  // eve's budget shim is not a tool the user approves — no chip, no args dump.
  expect(input.toolName).toBeNull();
  expect(input.argsPreview).toBeNull();
  expect(input.options.map((o) => o.description)).toEqual([
    "Grant a fresh token budget",
    "Stop now",
  ]);
});

test("a 0.19-era request with no kind is inferred rather than mislabelled", () => {
  // `run_events` rows persisted before eve 0.28 carry no discriminator and are
  // replayed forever, so the fallback must not call every one an approval.
  const legacyQuestion = {
    requestId: "q1",
    prompt: "Which mailbox?",
    action: { callId: "c1", kind: "tool-call", toolName: "ask_question", input: {} },
  } as unknown as Parameters<typeof inputRequestKindOf>[0];
  const legacyApproval = {
    requestId: "a1",
    prompt: "Approve?",
    action: { callId: "c2", kind: "tool-call", toolName: "gmail_send", input: {} },
  } as unknown as Parameters<typeof inputRequestKindOf>[0];
  expect(inputRequestKindOf(legacyQuestion)).toBe("question");
  expect(inputRequestKindOf(legacyApproval)).toBe("tool-approval");
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
