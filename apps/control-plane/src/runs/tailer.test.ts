/**
 * Tailer unit tests: NDJSON parsing (fixtures captured live in the Phase-0
 * spike), terminal classification, seq bookkeeping, `startIndex` reconnect,
 * reconnect exhaustion, and the wall-clock cap — all against in-memory
 * fakes (no DB, no network).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type {
  AgentSessionStatus,
  EveStreamEvent,
  RunStatus,
} from "@invisible-string/shared";

import { RunEventBus, type RunStreamFrame } from "./bus";
import type { RunStore, RunStatusPatch, StoredRunEvent } from "./store";
import {
  classifyTerminal,
  ndjsonEvents,
  nextPendingAuthorization,
  nextPendingInputRequest,
  tailRun,
  RunTailerManager,
} from "./tailer";

const FIXTURES = join(import.meta.dir, "fixtures");

async function fixtureLines(name: string): Promise<string[]> {
  const text = await Bun.file(join(FIXTURES, name)).text();
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// ── fakes ───────────────────────────────────────────────────────────────────

interface MemoryStore extends RunStore {
  events: Array<{ runId: string; seq: number; event: EveStreamEvent }>;
  runPatches: RunStatusPatch[];
  runStatus: RunStatus | null;
  sessionStatus: AgentSessionStatus | null;
}

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    events: [],
    runPatches: [],
    runStatus: null,
    sessionStatus: null,
    async appendEvent(runId, seq, event): Promise<StoredRunEvent> {
      if (store.events.some((e) => e.runId === runId && e.seq === seq)) {
        throw new Error(`duplicate seq ${seq} for run ${runId} (PK violation)`);
      }
      store.events.push({ runId, seq, event });
      return { seq, event, at: new Date().toISOString() };
    },
    async countRunEvents(runId) {
      return store.events.filter((e) => e.runId === runId).length;
    },
    async countSessionEvents() {
      return store.events.length; // single-session tests
    },
    async listEventsAfter(runId, afterSeq) {
      return store.events
        .filter((e) => e.runId === runId && e.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ seq: e.seq, event: e.event, at: new Date().toISOString() }));
    },
    async markRun(_runId, patch) {
      // Mirror the drizzle store's CAS: terminal statuses are sticky.
      if (
        store.runStatus === "succeeded" ||
        store.runStatus === "failed" ||
        store.runStatus === "canceled"
      ) {
        return false;
      }
      store.runPatches.push(patch);
      store.runStatus = patch.status;
      return true;
    },
    async getRunStatus() {
      return store.runStatus === null
        ? null
        : { status: store.runStatus, error: null };
    },
    async markDelivery() {
      return true; // delivery settlement is covered in delivery.test.ts
    },
    async listEventIds(runId) {
      return store.events
        .filter((e) => e.runId === runId)
        .map((e) => e.event.meta?.id)
        .filter((id): id is string => typeof id === "string");
    },
    async markSession(_sessionId, status) {
      store.sessionStatus = status;
    },
  };
  return store;
}

/** NDJSON Response from fixed lines; optionally stays open until aborted. */
function ndjsonResponse(
  lines: string[],
  options: { stayOpen?: boolean; signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      if (!options.stayOpen) {
        controller.close();
        return;
      }
      if (options.signal?.aborted) {
        controller.error(new Error("aborted"));
        return;
      }
      options.signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
  });
  return new Response(stream, { status: 200 });
}

function collectFrames(bus: RunEventBus, runId: string): RunStreamFrame[] {
  const frames: RunStreamFrame[] = [];
  bus.subscribe(runId, (frame) => frames.push(frame));
  return frames;
}

// ── parser ──────────────────────────────────────────────────────────────────

describe("ndjsonEvents", () => {
  test("parses fixture lines split across arbitrary chunk boundaries", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const raw = lines.join("\n") + "\n";
    // Chunk at awkward boundaries (mid-line, mid-multibyte-safe ASCII).
    const chunks = [raw.slice(0, 17), raw.slice(17, 100), raw.slice(100)];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events: EveStreamEvent[] = [];
    for await (const event of ndjsonEvents(body)) events.push(event);
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.appended",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  test("skips malformed/typeless lines and flushes an unterminated tail line", async () => {
    const raw =
      `not json at all\n` +
      `{"noType":true}\n` +
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}\n` +
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`; // no \n
    const body = new Response(raw).body!;
    const events: EveStreamEvent[] = [];
    for await (const event of ndjsonEvents(body)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["turn.started", "session.waiting"]);
  });
});

// ── terminal classification ─────────────────────────────────────────────────

describe("classifyTerminal", () => {
  const waiting = {
    type: "session.waiting",
    data: { wait: "next-user-message" },
  } as EveStreamEvent;

  test("session.waiting without a pending input request → run succeeded", () => {
    expect(classifyTerminal(waiting, false)).toEqual({
      runStatus: "succeeded",
      sessionStatus: "active",
    });
  });

  test("session.waiting with a pending input request → run waiting (parked)", () => {
    expect(classifyTerminal(waiting, true)).toEqual({
      runStatus: "waiting",
      sessionStatus: "waiting",
    });
  });

  test("turn.failed → run failed, session stays active", () => {
    const decision = classifyTerminal(
      {
        type: "turn.failed",
        data: { code: "MODEL_ERROR", message: "boom", sequence: 0, turnId: "t0" },
      } as EveStreamEvent,
      false,
    );
    expect(decision?.runStatus).toBe("failed");
    expect(decision?.error).toContain("MODEL_ERROR");
  });

  test("session.completed → run succeeded, session closed", () => {
    expect(
      classifyTerminal({ type: "session.completed" } as EveStreamEvent, false),
    ).toEqual({ runStatus: "succeeded", sessionStatus: "closed" });
  });

  test("ordinary stream events are not terminal", () => {
    expect(
      classifyTerminal(
        { type: "turn.completed", data: { sequence: 0, turnId: "t0" } } as EveStreamEvent,
        true,
      ),
    ).toBeNull();
  });

  test("pending-input tracking sets on input.requested, clears on action.result", () => {
    expect(
      nextPendingInputRequest(false, { type: "input.requested" } as EveStreamEvent),
    ).toBeTrue();
    expect(
      nextPendingInputRequest(true, { type: "action.result" } as EveStreamEvent),
    ).toBeFalse();
    expect(
      nextPendingInputRequest(true, { type: "message.appended" } as EveStreamEvent),
    ).toBeTrue();
  });
});

// ── tailRun ─────────────────────────────────────────────────────────────────

describe("classifyTerminal — eve 0.31 cancellation", () => {
  const waiting = {
    type: "session.waiting",
    data: { wait: "next-user-message" },
  } as unknown as EveStreamEvent;
  const cancelled = {
    type: "turn.cancelled",
    data: { sequence: 0, turnId: "t0" },
  } as unknown as EveStreamEvent;

  test("turn.cancelled is NOT terminal on its own", () => {
    // eve always follows it with session.waiting. Treating it as terminal
    // would finish the run and drop that trailing event, desynchronizing the
    // session's startIndex for the NEXT run.
    expect(classifyTerminal(cancelled, { pendingInputRequest: false })).toBeNull();
  });

  test("a latched cancellation makes the following session.waiting `canceled`", () => {
    expect(
      classifyTerminal(waiting, { pendingInputRequest: false, canceledTurn: true }),
    ).toEqual({ runStatus: "canceled", sessionStatus: "active" });
  });

  test("cancellation outranks a pending approval, and never carries an error", () => {
    // 0.31 declares a parked input request STALE once its turn is cancelled:
    // leaving the run `waiting` would park it on an approval eve discarded.
    const decision = classifyTerminal(waiting, {
      pendingInputRequest: true,
      canceledTurn: true,
    });
    expect(decision).toEqual({ runStatus: "canceled", sessionStatus: "active" });
    expect(decision?.error).toBeUndefined();
  });

  test("without the latch, session.waiting still means succeeded (regression guard)", () => {
    expect(classifyTerminal(waiting, { pendingInputRequest: false })).toEqual({
      runStatus: "succeeded",
      sessionStatus: "active",
    });
  });

  test("turn.cancelled and context.cleared clear a pending input request", () => {
    expect(nextPendingInputRequest(true, cancelled)).toBeFalse();
    expect(
      nextPendingInputRequest(true, {
        type: "context.cleared",
        data: { sequence: 0, sessionId: "s", turnId: "t0" },
      } as unknown as EveStreamEvent),
    ).toBeFalse();
  });
});

describe("tailRun", () => {
  test("full turn: persists every event with monotonic seq and marks the run succeeded", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const store = memoryStore();
    const bus = new RunEventBus();
    const frames = collectFrames(bus, "run-1");
    const startIndexes: number[] = [];
    const finishes: Array<{ status: string; lastAssistantMessage: string | null }> = [];

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (startIndex) => {
        startIndexes.push(startIndex);
        return ndjsonResponse(lines);
      },
      store,
      bus,
      maxWallClockMs: 5_000,
      onFinish: (info) => finishes.push(info),
    });
    await handle.done;

    // The finish hook carries the run's terminal reply (delivery seam): the
    // fixture's message.completed(finishReason=stop) text.
    expect(finishes).toEqual([
      expect.objectContaining({ status: "succeeded", lastAssistantMessage: "pong" }),
    ]);

    expect(startIndexes).toEqual([0]);
    expect(store.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.runStatus).toBe("succeeded");
    expect(store.sessionStatus).toBe("active");
    // running status frame + 9 event frames + terminal status frame
    expect(frames[0]).toEqual({
      kind: "status",
      frame: { runId: "run-1", status: "running" },
    });
    expect(frames.filter((f) => f.kind === "event")).toHaveLength(9);
    const last = frames.at(-1);
    expect(last).toMatchObject({ kind: "status", frame: { status: "succeeded" } });
    // startedAt set at start; completedAt set at terminal.
    expect(store.runPatches[0]?.startedAt).toBeInstanceOf(Date);
    expect(store.runPatches.at(-1)?.completedAt).toBeInstanceOf(Date);
  });

  test("a run already terminal (sweeper/cancel) is NEVER resurrected by a late tail (CAS)", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const store = memoryStore();
    // The sweeper failed this run while our dispatch was still in flight.
    store.runStatus = "failed";
    const bus = new RunEventBus();
    const frames = collectFrames(bus, "run-1");
    let opened = 0;

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async () => {
        opened += 1;
        return ndjsonResponse(lines);
      },
      store,
      bus,
      maxWallClockMs: 5_000,
    });
    await handle.done;

    // The tail refused to start: no failed→running flip, no stream read,
    // no frames published, no events persisted.
    expect(store.runStatus).toBe("failed");
    expect(store.runPatches).toHaveLength(0);
    expect(opened).toBe(0);
    expect(frames).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  test("approval park: input.requested then session.waiting → run waiting, session waiting", async () => {
    const lines = await fixtureLines("mocked-parked-events.ndjson");
    const store = memoryStore();
    const bus = new RunEventBus();

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus,
      maxWallClockMs: 5_000,
    });
    await handle.done;

    expect(store.runStatus).toBe("waiting");
    expect(store.sessionStatus).toBe("waiting");
    // A parked run is NOT completed — no completedAt on the terminal patch.
    expect(store.runPatches.at(-1)?.completedAt).toBeUndefined();
  });

  test("reconnects from the last consumed startIndex after a mid-stream drop", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const store = memoryStore();
    const bus = new RunEventBus();
    const startIndexes: number[] = [];

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (startIndex) => {
        startIndexes.push(startIndex);
        // First connect: 3 events then the stream drops (no terminal).
        if (startIndexes.length === 1) return ndjsonResponse(lines.slice(0, 3));
        // Second connect must resume from index 3 (eve replays from there).
        return ndjsonResponse(lines.slice(startIndex));
      },
      store,
      bus,
      maxWallClockMs: 10_000,
      reconnectDelayMs: 5,
    });
    await handle.done;

    expect(startIndexes).toEqual([0, 3]);
    // No duplicates (memory store throws on duplicate seq), full coverage.
    expect(store.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.runStatus).toBe("succeeded");
  });

  test("marks the run failed after exhausting reconnect attempts", async () => {
    const store = memoryStore();
    const bus = new RunEventBus();
    let connects = 0;

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async () => {
        connects += 1;
        return new Response("nope", { status: 502 });
      },
      store,
      bus,
      maxWallClockMs: 10_000,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 1,
    });
    await handle.done;

    expect(connects).toBe(3); // initial + 2 reconnects
    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toContain("reconnect attempts");
  });

  test("wall-clock cap: a stream that never terminates fails the run and stops the tail", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const store = memoryStore();
    const bus = new RunEventBus();
    const finishes: Array<{ lastAssistantMessage: string | null }> = [];

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (_startIndex, signal) =>
        // Two events, then silence — the run never reaches a terminal event.
        ndjsonResponse(lines.slice(0, 2), { stayOpen: true, signal }),
      store,
      bus,
      maxWallClockMs: 60,
      onFinish: (info) => finishes.push(info),
    });
    await handle.done;

    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toContain("wall-clock cap");
    expect(store.events).toHaveLength(2); // partial progress is preserved
    // No stop-message was seen → nothing for the delivery seam.
    expect(finishes[0]?.lastAssistantMessage).toBeNull();
  });

  test("leftover events of a previous turn are persisted but never classify the NEW run as terminal", async () => {
    // A previous run's tail stopped early (wall-clock abort / stream lost);
    // eve durably finished turn t0 anyway. The follow-up run's startIndex
    // undercounts, so its first connect drains t0's tail — including a
    // session.waiting that previously mis-fired as the new run's terminal.
    const leftovers = [
      `{"type":"message.completed","data":{"finishReason":"stop","message":"old","sequence":0,"stepIndex":0,"turnId":"t0"}}`,
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const ownTurn = [
      `{"type":"turn.started","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"message.received","data":{"message":"follow-up","sequence":1,"turnId":"t1"}}`,
      `{"type":"message.completed","data":{"finishReason":"stop","message":"new","sequence":1,"stepIndex":0,"turnId":"t1"}}`,
      `{"type":"turn.completed","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const bus = new RunEventBus();
    const finishes: Array<{ lastAssistantMessage: string | null }> = [];

    const handle = tailRun({
      runId: "run-2",
      agentSessionId: "sess-1",
      openStream: async () => ndjsonResponse([...leftovers, ...ownTurn]),
      store,
      bus,
      maxWallClockMs: 5_000,
      onFinish: (info) => finishes.push(info),
    });
    await handle.done;

    // Had the leftover session.waiting been classified, the tail would have
    // stopped after 3 events — instead the FULL drain lands on this run and
    // the terminal is the run's OWN session.waiting.
    expect(store.events).toHaveLength(leftovers.length + ownTurn.length);
    expect(store.runStatus).toBe("succeeded");
    expect(store.sessionStatus).toBe("active");
    // The leftover stop-message ("old") is NEVER this run's reply — only the
    // run's own turn feeds the delivery seam.
    expect(finishes[0]?.lastAssistantMessage).toBe("new");
  });

  test("a leftover input.requested does not park the NEW run (pending-input resets at its own turn)", async () => {
    const lines = [
      // Previous turn's park tail — unanswered input.requested + waiting.
      `{"type":"input.requested","data":{"requests":[],"sequence":0,"stepIndex":0,"turnId":"t0"}}`,
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
      // The new run's own clean turn.
      `{"type":"turn.started","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"turn.completed","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const bus = new RunEventBus();

    const handle = tailRun({
      runId: "run-2",
      agentSessionId: "sess-1",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus,
      maxWallClockMs: 5_000,
    });
    await handle.done;

    // succeeded, not "waiting": the stale input.requested belonged to t0.
    expect(store.runStatus).toBe("succeeded");
  });

  test("an appendEvent failure retries the SAME event on reconnect (no silent loss)", async () => {
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const store = memoryStore();
    const bus = new RunEventBus();
    let failedOnce = false;
    const flakyStore = {
      ...store,
      async appendEvent(runId: string, seq: number, event: EveStreamEvent) {
        if (seq === 4 && !failedOnce) {
          failedOnce = true;
          throw new Error("transient postgres error");
        }
        return store.appendEvent(runId, seq, event);
      },
    };
    const startIndexes: number[] = [];

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (startIndex) => {
        startIndexes.push(startIndex);
        return ndjsonResponse(lines.slice(startIndex));
      },
      store: flakyStore,
      bus,
      maxWallClockMs: 10_000,
      reconnectDelayMs: 5,
    });
    await handle.done;

    // The failed event was re-consumed from the SAME startIndex — every
    // event persisted exactly once (memory store throws on duplicate seq).
    expect(startIndexes).toEqual([0, 4]);
    expect(store.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.runStatus).toBe("succeeded");
  });

  test("cancel() stops the tail with the given reason", async () => {
    const store = memoryStore();
    const bus = new RunEventBus();

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (_startIndex, signal) =>
        ndjsonResponse([], { stayOpen: true, signal }),
      store,
      bus,
      maxWallClockMs: 60_000,
    });
    handle.cancel("operator canceled");
    await handle.done;

    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toBe("operator canceled");
  });
});

describe("tailRun — eve 0.31 plumbing", () => {
  const withId = (event: Record<string, unknown>, id: string): string =>
    JSON.stringify({ ...event, meta: { at: new Date().toISOString(), id } });

  test("a cancelled turn lands `canceled`, not succeeded — and owes no reply", async () => {
    // The dangerous default is NOT `failed`: an unhandled turn.cancelled would
    // fall through to the session.waiting arm and mark the run SUCCEEDED,
    // settling its Slack delivery obligation and posting a truncated reply.
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"message.received","data":{"message":"hi","sequence":0,"turnId":"t0"}}`,
      `{"type":"message.appended","data":{"messageDelta":"par","messageSoFar":"par","sequence":0,"stepIndex":0,"turnId":"t0"}}`,
      `{"type":"turn.cancelled","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const bus = new RunEventBus();
    const finishes: Array<{ status: string; lastAssistantMessage: string | null }> = [];

    const handle = tailRun({
      runId: "run-c",
      agentSessionId: "sess-c",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus,
      maxWallClockMs: 5_000,
      onFinish: (info) => finishes.push(info),
    });
    await handle.done;

    expect(store.runStatus).toBe("canceled");
    // The session survives a cancel and takes the next message normally.
    expect(store.sessionStatus).toBe("active");
    // Cancellation is a user decision, not an error — no failure text.
    expect(store.runPatches.at(-1)?.error).toBeNull();
    expect(finishes[0]?.status).toBe("canceled");
    // No `message.completed` with finishReason "stop" ⇒ nothing to deliver.
    expect(finishes[0]?.lastAssistantMessage).toBeNull();
  });

  test("a cancelled turn parked on an approval does not stay `waiting`", async () => {
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"input.requested","data":{"requests":[{"requestId":"r1","kind":"tool-approval","prompt":"ok?","action":{"callId":"c1","kind":"tool-call","toolName":"rm","input":{}}}],"sequence":0,"stepIndex":0,"turnId":"t0"}}`,
      `{"type":"turn.cancelled","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-cp",
      agentSessionId: "sess-cp",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
    });
    await handle.done;
    expect(store.runStatus).toBe("canceled");
  });

  test("meta.id dedupes a reconnect that re-reads an already-persisted window", async () => {
    // The drop happens AFTER two events; the reconnect deliberately replays
    // from index 0 (a server that rewinds, or a cursor that undercounted).
    // Without id dedupe those two land a SECOND time under fresh seqs.
    const events = [
      withId({ type: "turn.started", data: { sequence: 0, turnId: "t0" } }, "evt_A"),
      withId(
        { type: "message.received", data: { message: "hi", sequence: 0, turnId: "t0" } },
        "evt_B",
      ),
      withId(
        {
          type: "message.completed",
          data: { finishReason: "stop", message: "done", sequence: 0, stepIndex: 0, turnId: "t0" },
        },
        "evt_C",
      ),
      withId({ type: "session.waiting", data: { wait: "next-user-message" } }, "evt_D"),
    ];
    const store = memoryStore();
    let connects = 0;
    const handle = tailRun({
      runId: "run-d",
      agentSessionId: "sess-d",
      openStream: async () => {
        connects += 1;
        // 1st connect: first two events then a hard end (no terminal → drop).
        // 2nd connect: the WHOLE stream again from the beginning.
        return ndjsonResponse(connects === 1 ? events.slice(0, 2) : events);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      reconnectDelayMs: 1,
    });
    await handle.done;

    expect(connects).toBe(2);
    expect(store.runStatus).toBe("succeeded");
    // Four distinct events persisted exactly once, with contiguous seqs.
    expect(store.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(store.events.map((e) => e.event.meta?.id)).toEqual([
      "evt_A",
      "evt_B",
      "evt_C",
      "evt_D",
    ]);
  });

  test("requests includeTailIndex on the FIRST connect only", async () => {
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const seen: Array<boolean | undefined> = [];
    let connects = 0;
    const handle = tailRun({
      runId: "run-t",
      agentSessionId: "sess-t",
      openStream: async (_startIndex, _signal, options) => {
        seen.push(options?.includeTailIndex);
        connects += 1;
        // Force one reconnect: the second open must NOT re-pin the bound.
        return ndjsonResponse(connects === 1 ? [] : lines);
      },
      store: memoryStore(),
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      reconnectDelayMs: 1,
    });
    await handle.done;
    expect(seen).toEqual([true, undefined]);
  });

  test("clamps a cursor that runs ahead of eve's tail index instead of looping to failure", async () => {
    // Persisted count says 5; eve's durable truth is 2 events (tail index 1).
    // Sending startIndex=5 makes eve close the stream instantly, which the
    // loop can only read as a drop — reconnect forever, then a spurious
    // `failed`. The clamp reopens at eve's truth.
    const store = memoryStore();
    for (let seq = 0; seq < 5; seq += 1) {
      await store.appendEvent("run-x", seq, {
        type: "step.completed",
        data: { finishReason: "stop", sequence: 0, stepIndex: seq, turnId: "t0" },
      } as unknown as EveStreamEvent);
    }
    const requested: number[] = [];
    const handle = tailRun({
      runId: "run-x",
      agentSessionId: "sess-x",
      openStream: async (startIndex, _signal, options) => {
        requested.push(startIndex);
        const headers: Record<string, string> = {
          "content-type": "application/x-ndjson",
        };
        if (options?.includeTailIndex) headers["x-eve-stream-tail-index"] = "1";
        if (startIndex > 2) {
          return new Response(new ReadableStream({ start: (c) => c.close() }), {
            status: 200,
            headers,
          });
        }
        return ndjsonResponse([
          `{"type":"turn.started","data":{"sequence":0,"turnId":"t9"}}`,
          `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
        ]);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      reconnectDelayMs: 1,
    });
    await handle.done;

    expect(requested[0]).toBe(5);
    expect(requested[1]).toBe(2); // clamped to tailIndex + 1
    expect(store.runStatus).toBe("succeeded");
  });

  test("a user cancel issues eve's REAL remote cancel before stopping the tail", async () => {
    let remoteCancels = 0;
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-rc",
      agentSessionId: "sess-rc",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        remoteCancels += 1;
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    handle.cancel("canceled by user", { status: "canceled" });
    await handle.done;

    expect(remoteCancels).toBe(1);
    expect(store.runStatus).toBe("canceled");
  });

  test("the remote cancel is scoped to the OBSERVED turn id (stale-request guard)", async () => {
    // Regression: the cancel is fire-and-forget and the run is finalized
    // without awaiting it, which frees the session's one run slot — so a
    // follow-up message can start a NEW turn while the request is still in
    // flight. Unguarded, that late cancel would stop the user's new turn.
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-guard",
      agentSessionId: "sess-guard",
      openStream: async (_i, signal) =>
        ndjsonResponse(
          [`{"type":"turn.started","data":{"sequence":0,"turnId":"turn_7"}}`],
          { stayOpen: true, signal },
        ),
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    // Cancel only once the turn boundary has actually been consumed.
    while (!store.events.some((e) => e.event.type === "turn.started")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    handle.cancel("canceled by user", { status: "canceled" });
    await handle.done;

    expect(seen).toEqual([{ turnId: "turn_7" }]);
    expect(store.runStatus).toBe("canceled");
  });

  test("a remote cancel BEFORE any turn.started carries no turn id", async () => {
    // Nothing to be confused with yet, so the guard must be omitted rather
    // than sent as a bogus value — eve rejects bodies by key presence.
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-noturn",
      agentSessionId: "sess-noturn",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    handle.cancel("canceled by user", { status: "canceled" });
    await handle.done;

    expect(seen).toEqual([undefined]);
  });

  // Polled in a helper so TypeScript's control-flow narrowing of
  // `store.runStatus` does not leak into the assertions that follow.
  const untilRunning = async (store: { runStatus: string | null }) => {
    while (store.runStatus !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  test("an AWAITED cancel issues the remote cancel and finalizes the run only after it resolves (the cancel route's lock-held shape)", async () => {
    // Regression (D3): finalizing the row reopens session admission, so an
    // unqualified cancel still airborne when a follow-up's turn starts would
    // stop THAT turn. Under the session lock the route awaits the request
    // before the tail aborts.
    let releaseRemote!: () => void;
    const remoteHeld = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    let remoteEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      remoteEntered = resolve;
    });
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-await",
      agentSessionId: "sess-await",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        remoteEntered();
        await remoteHeld;
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    const canceling = handle.cancel("canceled by user", {
      status: "canceled",
      awaitRemote: true,
      allowUnqualifiedRemote: true,
    });
    await entered;
    // The remote request is in flight: the tail is still following and the
    // row is NOT finalized yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.runStatus).toBe("running");
    releaseRemote();
    expect(await canceling).toBe("issued");
    await handle.done;
    expect(store.runStatus).toBe("canceled");
  });

  test("with unqualified cancels disallowed and no turn observed, the remote cancel is SKIPPED (reported, never fired) and the run still finalizes", async () => {
    let remoteCancels = 0;
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-skip",
      agentSessionId: "sess-skip",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        remoteCancels += 1;
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    const outcome = await handle.cancel("canceled by user", {
      status: "canceled",
      awaitRemote: true,
      allowUnqualifiedRemote: false,
    });
    await handle.done;
    expect(outcome).toBe("skipped");
    expect(remoteCancels).toBe(0);
    expect(store.runStatus).toBe("canceled");
  });

  test("a SKIPPED or transport-FAILED remote leg writes the durable obligation INTO the finalizing markRun patch — one statement, never a second write after it (G1)", async () => {
    // The crash window this closes: the row read `canceled` (admission
    // reopened, the session lock released) while `remote_cancel_pending_at`
    // was still to be written by a SECOND statement in the cancel route. Now
    // the tail's own finalize carries it, so the instant the row is canceled
    // the obligation is on it.
    const finalizeOf = (store: MemoryStore) => {
      const patch = store.runPatches.at(-1)!;
      expect(patch.status).toBe("canceled");
      return patch;
    };

    // (a) skipped: unqualified and disallowed (no session lock).
    const skipStore = memoryStore();
    const skipped = tailRun({
      runId: "run-oblig-skip",
      agentSessionId: "sess-oblig",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {},
      store: skipStore,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(skipStore);
    expect(
      await skipped.cancel("canceled by user", {
        status: "canceled",
        awaitRemote: true,
        allowUnqualifiedRemote: false,
      }),
    ).toBe("skipped");
    await skipped.done;
    const skipFinalize = finalizeOf(skipStore);
    expect(skipFinalize.remoteCancelPendingAt).toBeInstanceOf(Date);
    // Same instant as the finalize itself: it is the same write.
    expect(skipFinalize.remoteCancelPendingAt).toEqual(skipFinalize.completedAt);
    expect(skipStore.runPatches.filter((p) => p.status === "canceled")).toHaveLength(1);

    // (b) failed: awaited and rejected in transport.
    const failStore = memoryStore();
    const failed = tailRun({
      runId: "run-oblig-fail",
      agentSessionId: "sess-oblig",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        throw new Error("fetch failed: connect ECONNREFUSED");
      },
      store: failStore,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(failStore);
    expect(
      await failed.cancel("canceled by user", {
        status: "canceled",
        awaitRemote: true,
        allowUnqualifiedRemote: true,
      }),
    ).toBe("failed");
    await failed.done;
    const failFinalize = finalizeOf(failStore);
    expect(failFinalize.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(failFinalize.remoteCancelPendingAt).toEqual(failFinalize.completedAt);

    // (c) issued: eve acknowledged — nothing is owed, no marker.
    const okStore = memoryStore();
    const issued = tailRun({
      runId: "run-oblig-ok",
      agentSessionId: "sess-oblig",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {},
      store: okStore,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(okStore);
    expect(
      await issued.cancel("canceled by user", {
        status: "canceled",
        awaitRemote: true,
        allowUnqualifiedRemote: true,
      }),
    ).toBe("issued");
    await issued.done;
    expect(finalizeOf(okStore).remoteCancelPendingAt).toBeUndefined();

    // (d) a shutdown/wall-clock FAILED finalize owes nothing either — the
    // obligation is a user-cancel concept (the sweep scans canceled rows).
    const wcStore = memoryStore();
    const wc = tailRun({
      runId: "run-oblig-wc",
      agentSessionId: "sess-oblig",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        throw new Error("worker unreachable");
      },
      store: wcStore,
      bus: new RunEventBus(),
      maxWallClockMs: 30,
    });
    await wc.done;
    const wcFinalize = wcStore.runPatches.at(-1)!;
    expect(wcFinalize.status).toBe("failed");
    expect(wcFinalize.remoteCancelPendingAt).toBeUndefined();
  });

  test("with unqualified cancels disallowed but a turn observed, the QUALIFIED cancel is still issued", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-qual",
      agentSessionId: "sess-qual",
      openStream: async (_i, signal) =>
        ndjsonResponse(
          [`{"type":"turn.started","data":{"sequence":0,"turnId":"turn_q"}}`],
          { stayOpen: true, signal },
        ),
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    while (!store.events.some((e) => e.event.type === "turn.started")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const outcome = await handle.cancel("canceled by user", {
      status: "canceled",
      awaitRemote: true,
      allowUnqualifiedRemote: false,
    });
    await handle.done;
    expect(outcome).toBe("issued");
    expect(seen).toEqual([{ turnId: "turn_q" }]);
  });

  test("the wall-clock cap cancels eve's turn too, and a failing remote cancel never fails the run harder", async () => {
    let attempted = 0;
    const store = memoryStore();
    const handle = tailRun({
      runId: "run-wc",
      agentSessionId: "sess-wc",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
      cancelRemoteTurn: async () => {
        attempted += 1;
        throw new Error("worker unreachable");
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 30,
    });
    await handle.done;

    expect(attempted).toBe(1);
    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toContain("wall-clock cap");
  });
});

describe("authorization latch (connectors plan-3 task 9)", () => {
  // NOTE: `authorization.required` is DORMANT on eve 0.31.3 for the
  // platform's getToken-only connections (spike REPORT finding 34 — a mid-run
  // 401 is a plain failed action.result). The latch is implemented
  // defensively against eve's declared wire types: these fixtures are
  // synthetic NDJSON, not live captures.
  const waiting = {
    type: "session.waiting",
    data: { wait: "next-user-message" },
  } as EveStreamEvent;
  const required = {
    type: "authorization.required",
    data: {
      name: "linear",
      description: "Linear MCP",
      authorization: {
        url: "https://as.example.com/authorize?request=abc",
        userCode: "ABCD-1234",
        expiresAt: "2026-08-10T12:00:00.000Z",
      },
      sequence: 0,
      stepIndex: 0,
      turnId: "t0",
    },
  } as EveStreamEvent;
  const completed = {
    type: "authorization.completed",
    data: {
      name: "linear",
      outcome: "authorized",
      sequence: 0,
      stepIndex: 0,
      turnId: "t0",
    },
  } as EveStreamEvent;

  test("session.waiting while authorization is pending → run waiting, never succeeded", () => {
    // The Slack-truncation hazard: an unlatched session.waiting would classify
    // the run succeeded, settling its delivery obligation with a truncated
    // reply while the user is still mid-consent.
    expect(
      classifyTerminal(waiting, {
        pendingInputRequest: false,
        pendingAuthorization: true,
      }),
    ).toEqual({ runStatus: "waiting", sessionStatus: "waiting" });
  });

  test("cancellation outranks a pending authorization", () => {
    expect(
      classifyTerminal(waiting, {
        pendingInputRequest: false,
        pendingAuthorization: true,
        canceledTurn: true,
      }),
    ).toEqual({ runStatus: "canceled", sessionStatus: "active" });
  });

  test("latch sets on .required, clears on .completed, invalidates at the same boundaries as input requests", () => {
    expect(nextPendingAuthorization(false, required)).toBeTrue();
    expect(nextPendingAuthorization(true, completed)).toBeFalse();
    expect(
      nextPendingAuthorization(true, {
        type: "turn.cancelled",
        data: { sequence: 0, turnId: "t0" },
      } as EveStreamEvent),
    ).toBeFalse();
    expect(
      nextPendingAuthorization(true, {
        type: "context.cleared",
        data: { sequence: 0, sessionId: "s", turnId: "t0" },
      } as EveStreamEvent),
    ).toBeFalse();
    // Unlike an input request, a tool result does NOT resolve a consent
    // challenge — only authorization.completed (or a boundary) may clear it.
    expect(
      nextPendingAuthorization(true, {
        type: "action.result",
        data: {
          result: { callId: "c1", kind: "tool-result", toolName: "x", output: "y" },
          status: "completed",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      } as EveStreamEvent),
    ).toBeTrue();
    expect(nextPendingAuthorization(true, waiting)).toBeTrue();
  });

  test("authorization park: .required then session.waiting → run waiting, event persisted, health hook fired", async () => {
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      JSON.stringify(required),
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const hookCalls: Array<{ connectionName: string }> = [];

    const handle = tailRun({
      runId: "run-auth",
      agentSessionId: "sess-auth",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      onAuthorizationRequired: (info) => hookCalls.push(info),
    });
    await handle.done;

    expect(store.runStatus).toBe("waiting");
    expect(store.sessionStatus).toBe("waiting");
    // A parked run is not completed.
    expect(store.runPatches.at(-1)?.completedAt).toBeUndefined();
    // The event is persisted like any other run event (chat card replay).
    expect(
      store.events.some((e) => e.event.type === "authorization.required"),
    ).toBeTrue();
    // The health flip seam fired with eve's connection name (the slug).
    expect(hookCalls).toEqual([{ connectionName: "linear" }]);
  });

  test("authorization.completed clears the latch — the settling session.waiting means succeeded", async () => {
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      JSON.stringify(required),
      JSON.stringify(completed),
      `{"type":"message.completed","data":{"finishReason":"stop","message":"done","sequence":0,"stepIndex":0,"turnId":"t0"}}`,
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();

    const handle = tailRun({
      runId: "run-auth-done",
      agentSessionId: "sess-auth-done",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
    });
    await handle.done;

    expect(store.runStatus).toBe("succeeded");
    expect(store.sessionStatus).toBe("active");
  });

  test("a leftover authorization.required from a previous turn never parks the NEW run", async () => {
    const lines = [
      // Previous turn's tail, drained by this fresh run's first connect.
      JSON.stringify(required),
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
      // The new run's own clean turn.
      `{"type":"turn.started","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"turn.completed","data":{"sequence":1,"turnId":"t1"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();
    const hookCalls: Array<{ connectionName: string }> = [];

    const handle = tailRun({
      runId: "run-auth-left",
      agentSessionId: "sess-auth-left",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      onAuthorizationRequired: (info) => hookCalls.push(info),
    });
    await handle.done;

    // The stale challenge belonged to t0 — the new run is not parked on it.
    expect(store.runStatus).toBe("succeeded");
    // The health flip still fires: a drained challenge is a REAL event the
    // previous, early-stopped tail never consumed, and connection health is
    // a fact about the connection, not about this run.
    expect(hookCalls).toEqual([{ connectionName: "linear" }]);
  });

  test("a throwing onAuthorizationRequired hook never breaks the tail", async () => {
    const lines = [
      `{"type":"turn.started","data":{"sequence":0,"turnId":"t0"}}`,
      JSON.stringify(required),
      JSON.stringify(completed),
      `{"type":"turn.completed","data":{"sequence":0,"turnId":"t0"}}`,
      `{"type":"session.waiting","data":{"wait":"next-user-message"}}`,
    ];
    const store = memoryStore();

    const handle = tailRun({
      runId: "run-auth-throw",
      agentSessionId: "sess-auth-throw",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      onAuthorizationRequired: () => {
        throw new Error("hook exploded");
      },
    });
    await handle.done;

    expect(store.runStatus).toBe("succeeded");
  });
});

describe("RunTailerManager", () => {
  test("deduplicates tails per run and drops them when done", async () => {
    const store = memoryStore();
    const bus = new RunEventBus();
    const manager = new RunTailerManager({ store, bus, maxWallClockMs: 5_000 });
    const lines = await fixtureLines("mocked-turn-events.ndjson");

    const openStream = async () => ndjsonResponse(lines);
    const a = manager.start({ runId: "run-1", agentSessionId: "s", openStream });
    const b = manager.start({ runId: "run-1", agentSessionId: "s", openStream });
    expect(b).toBe(a);
    expect(manager.activeCount).toBe(1);
    await a.done;
    expect(manager.activeCount).toBe(0);
  });

  test("stopAll cancels live tails", async () => {
    const store = memoryStore();
    const bus = new RunEventBus();
    const manager = new RunTailerManager({ store, bus, maxWallClockMs: 60_000 });
    manager.start({
      runId: "run-1",
      agentSessionId: "s",
      openStream: async (_i, signal) => ndjsonResponse([], { stayOpen: true, signal }),
    });
    await manager.stopAll("shutdown");
    expect(manager.activeCount).toBe(0);
    expect(store.runPatches.at(-1)?.error).toBe("shutdown");
  });
});
