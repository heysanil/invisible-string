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
  inputRequestKindOf,
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
      agentId: "agent",
      workflowId: null,
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
  expect(view.reply?.text).toBe("Half a sentence");
  expect(view.reply?.streaming).toBe(false);
  expect(view.block?.active).toBe(false);
});

test("a cancelled turn demotes only the steps that never settled", () => {
  const view = reduceRunView(runRow("canceled"), storeOf(canceledTurnFrames()), "canceled");
  const steps = view.block!.steps;
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
  const step = view.block!.steps[0]!;
  expect(step.state).toBe("pending");
  expect(step.resultPreview).toBe("12 pages so far");
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
