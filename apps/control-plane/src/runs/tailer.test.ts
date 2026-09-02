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

import { createLogger } from "../log";
import { RunEventBus, type RunStreamFrame } from "./bus";
import type { RunStore, RunStatusPatch, StoredRunEvent } from "./store";
import {
  classifyTerminal,
  ndjsonEvents,
  nextPendingAuthorization,
  nextPendingInputRequest,
  tailRun,
  RunTailerManager,
  type OpenRunStream,
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
  /** `runs.turn_id` per run — eve's acceptance proof. */
  turnIds: Map<string, string>;
  /** `remote_cancel_pending_at` / `remote_cancel_unresolved_at` per run, insertion = send order. */
  obligations: Map<string, { pendingAt: Date; unresolvedAt: Date | null }>;
}

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    events: [],
    runPatches: [],
    runStatus: null,
    sessionStatus: null,
    turnIds: new Map(),
    obligations: new Map(),
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
    async markRun(runId, patch) {
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
      if (patch.remoteCancelPendingAt) {
        store.obligations.set(runId, { pendingAt: patch.remoteCancelPendingAt, unresolvedAt: null });
      }
      if (patch.turnId === null) store.turnIds.delete(runId);
      return true;
    },
    async getRunTurnState(runId) {
      return {
        status: store.runStatus ?? "queued",
        turnId: store.turnIds.get(runId) ?? null,
        remoteCancelPendingAt: store.obligations.get(runId)?.pendingAt ?? null,
      };
    },
    async setRunTurnId(runId, turnId) {
      const current = store.turnIds.get(runId);
      if (current !== undefined && current !== turnId) return false;
      store.turnIds.set(runId, turnId);
      return true;
    },
    async listPendingRemoteCancels() {
      return [...store.obligations.entries()]
        .filter(([, o]) => o.unresolvedAt === null)
        .map(([runId, o]) => ({
          runId,
          turnId: store.turnIds.get(runId) ?? null,
          pendingAt: o.pendingAt,
        }));
    },
    async clearRemoteCancelPending(runId) {
      return store.obligations.delete(runId);
    },
    async markRemoteCancelUnresolved(runId) {
      const current = store.obligations.get(runId);
      if (!current || current.unresolvedAt !== null) return false;
      current.unresolvedAt = new Date();
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

/**
 * A stream the test drives: lines pushed before a connect are delivered on
 * it; lines pushed while connected stream live; an abort errors the current
 * connection and later pushes wait for the next one.
 */
function liveStream(): { open: OpenRunStream; push(line: string): void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const backlog: string[] = [];
  return {
    open: async (_startIndex, signal) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const line of backlog.splice(0)) c.enqueue(encoder.encode(`${line}\n`));
          signal.addEventListener(
            "abort",
            () => {
              if (controller === c) controller = null;
              try {
                c.error(new Error("aborted"));
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    },
    push(line) {
      if (!controller) {
        backlog.push(line);
        return;
      }
      try {
        controller.enqueue(encoder.encode(`${line}\n`));
      } catch {
        backlog.push(line);
      }
    },
  };
}

const turnStarted = (turnId: string) =>
  JSON.stringify({ type: "turn.started", data: { sequence: 0, turnId } });
const turnCompleted = (turnId: string) =>
  JSON.stringify({ type: "turn.completed", data: { sequence: 0, turnId } });
const turnCancelled = (turnId: string) =>
  JSON.stringify({ type: "turn.cancelled", data: { sequence: 0, turnId } });
const stopMessage = (turnId: string, message: string) =>
  JSON.stringify({
    type: "message.completed",
    data: { finishReason: "stop", message, sequence: 0, stepIndex: 0, turnId },
  });
const sessionWaiting = () =>
  JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } });

async function until(probe: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Has `promise` settled yet? (a zero-delay race) */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
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
    // A failed finalize owes eve nothing — the obligation is a user-cancel concept.
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeUndefined();
  });
});

// ── the confirmed cancel: turn attribution + observation mode ───────────────

describe("tailRun — the confirmed cancel (observation mode)", () => {
  const untilRunning = async (store: { runStatus: string | null }) => {
    await until(() => store.runStatus === "running", "the tail to adopt the run");
  };

  test("a Stop BEFORE turn.started sends nothing (eve would consume it as a no-op), finalizes canceled WITH the obligation in the same patch, and stays on the stream; its own turn.started is then attributed, cancelled QUALIFIED, and the boundary clears the obligation", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-pre",
      agentSessionId: "sess-pre",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);

    const outcome = await handle.cancel("canceled by user", {
      status: "canceled",
      awaitRemote: true,
    });
    // Pre-fix: an UNQUALIFIED `{}` cancel went out, eve answered 202 while
    // consuming it as a no-op, the row finalized `issued` with NO marker, and
    // the turn ran to completion unobserved.
    expect(outcome).toBe("pending");
    expect(seen).toHaveLength(0);
    expect(store.runStatus).toBe("canceled");
    const finalize = store.runPatches.at(-1)!;
    expect(finalize.status).toBe("canceled");
    expect(finalize.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(finalize.remoteCancelPendingAt).toEqual(finalize.completedAt);
    expect(store.obligations.has("run-pre")).toBeTrue();
    expect(handle.observing).toBeTrue();
    expect(await settled(handle.done)).toBeFalse(); // still on the stream

    // eve starts the run's own turn: the acceptance proof lands and the
    // qualified cancel goes out.
    stream.push(turnStarted("turn_9"));
    await until(() => seen.length === 1, "the qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_9" }]);
    expect(store.turnIds.get("run-pre")).toBe("turn_9");
    expect(store.obligations.has("run-pre")).toBeTrue(); // boundary still owed

    // eve's OWN confirmation: the observation closes the instant its last
    // obligation is met (the trailing `session.waiting` is a leftover the
    // next tail on this session drains, exactly as before).
    stream.push(turnCancelled("turn_9"));
    await handle.done;
    expect(store.obligations.has("run-pre")).toBeFalse();
    expect(store.runStatus).toBe("canceled"); // never re-marked
    expect(store.events.map((e) => e.event.type)).toEqual(["turn.started", "turn.cancelled"]);
  });

  test("a Stop AFTER turn.started issues the QUALIFIED cancel, still owes the boundary, and clears it on turn.completed", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const stream = liveStream();
    stream.push(turnStarted("turn_7"));
    const handle = tailRun({
      runId: "run-post",
      agentSessionId: "sess-post",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await until(() => store.turnIds.get("run-post") === "turn_7", "the own turn to be attributed");

    const outcome = await handle.cancel("canceled by user", {
      status: "canceled",
      awaitRemote: true,
    });
    expect(outcome).toBe("issued");
    expect(seen).toEqual([{ turnId: "turn_7" }]);
    expect(store.runStatus).toBe("canceled");
    // A 202 to the qualified cancel is NOT confirmation: the obligation stays.
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(store.obligations.has("run-post")).toBeTrue();
    expect(handle.observing).toBeTrue();

    // The turn ends (cooperatively — even a completion counts: the boundary
    // is eve's own word that nothing is running).
    stream.push(turnCompleted("turn_7"));
    await until(() => !store.obligations.has("run-post"), "the obligation to clear");
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.runStatus).toBe("canceled"); // the leftover session.waiting never re-classifies
  });

  test("the acceptance proof is written BEFORE the turn.started event is persisted", async () => {
    const store = memoryStore();
    let turnIdAtPersist: string | null | undefined;
    const appendEvent = store.appendEvent;
    store.appendEvent = async (runId, seq, event) => {
      if (event.type === "turn.started") turnIdAtPersist = store.turnIds.get(runId) ?? null;
      return appendEvent(runId, seq, event);
    };
    const lines = await fixtureLines("mocked-turn-events.ndjson");
    const handle = tailRun({
      runId: "run-proof",
      agentSessionId: "sess-proof",
      openStream: async () => ndjsonResponse(lines),
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await handle.done;
    expect(turnIdAtPersist).toBe("turn_0");
    expect(store.turnIds.get("run-proof")).toBe("turn_0");
    expect(store.runStatus).toBe("succeeded");
  });

  test("eve's session-terminal answer to the qualified cancel finalizes WITHOUT an obligation and ends the tail", async () => {
    const store = memoryStore();
    const stream = liveStream();
    stream.push(turnStarted("turn_t"));
    const handle = tailRun({
      runId: "run-term",
      agentSessionId: "sess-term",
      openStream: stream.open,
      cancelRemoteTurn: async () => "terminal",
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await until(() => store.turnIds.get("run-term") === "turn_t", "the own turn");
    const outcome = await handle.cancel("canceled by user", { status: "canceled", awaitRemote: true });
    expect(outcome).toBe("terminal");
    await handle.done;
    expect(store.runStatus).toBe("canceled");
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeUndefined();
    expect(store.obligations.size).toBe(0);
  });

  test("a transport-FAILED qualified cancel keeps the obligation (never recorded as done); the turn's own boundary still clears it", async () => {
    const store = memoryStore();
    const stream = liveStream();
    stream.push(turnStarted("turn_f"));
    const handle = tailRun({
      runId: "run-fail",
      agentSessionId: "sess-fail",
      openStream: stream.open,
      cancelRemoteTurn: async () => {
        throw new Error("fetch failed: connect ECONNREFUSED");
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await until(() => store.turnIds.get("run-fail") === "turn_f", "the own turn");
    const outcome = await handle.cancel("canceled by user", { status: "canceled", awaitRemote: true });
    expect(outcome).toBe("failed");
    expect(store.runStatus).toBe("canceled");
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(handle.observing).toBeTrue();
    stream.push(turnCompleted("turn_f"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.obligations.size).toBe(0);
  });

  test("the observation window elapsing declares the obligation UNRESOLVED — marker kept, warn logged — never a silent clear", async () => {
    const warns: string[] = [];
    const logger = createLogger({
      sink: (event) => {
        if (event.level === "warn") warns.push(event.event);
      },
      minLevel: "debug",
    });
    const store = memoryStore();
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-unres",
      agentSessionId: "sess-unres",
      openStream: stream.open,
      cancelRemoteTurn: async () => {},
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      remoteCancelObserveMs: 40,
      logger,
    });
    await untilRunning(store);
    expect(await handle.cancel("canceled by user", { status: "canceled", awaitRemote: true })).toBe(
      "pending",
    );
    await handle.done; // the window elapses with no turn ever starting
    const obligation = store.obligations.get("run-unres");
    expect(obligation).toBeDefined();
    expect(obligation!.unresolvedAt).toBeInstanceOf(Date);
    expect(warns).toContain("run.remote_cancel_unresolved");
    expect(store.runStatus).toBe("canceled");
  });

  test("observation RE-OPENED for a canceled run (the sweeper's shape) attributes its turn, cancels it qualified, and clears on the boundary — without ever touching the row's status", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-A",
      agentSessionId: "sess-re",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    expect(handle.observing).toBeTrue();
    stream.push(turnStarted("turn_A"));
    await until(() => seen.length === 1, "the qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    stream.push(turnCompleted("turn_A"));
    await handle.done;
    expect(store.obligations.has("run-A")).toBeFalse();
    expect(store.runPatches).toHaveLength(0); // no adoption, no re-marking
    expect(store.events.map((e) => e.event.type)).toEqual(["turn.started", "turn.completed"]);
  });

  test("a re-opened observation whose turn is already known re-issues the qualified cancel at once, and a session.waiting clears every OWNED obligation", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.turnIds.set("run-K", "turn_K");
    store.obligations.set("run-K", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-K",
      agentSessionId: "sess-k",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await until(() => seen.length === 1, "the re-issued qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_K" }]);
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.obligations.has("run-K")).toBeFalse();
  });

  test("an observation that finds nothing owed on the row (met by another actor) ends at once", async () => {
    const store = memoryStore();
    store.runStatus = "canceled";
    let opened = 0;
    const handle = tailRun({
      runId: "run-met",
      agentSessionId: "sess-met",
      openStream: async (...args) => {
        opened += 1;
        return liveStream().open(...args);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await handle.done;
    expect(opened).toBe(0);
  });

  test("a successor's normal tail carries the session's obligations: the predecessor's turn is attributed to IT (never claimed as the successor's own), cancelled qualified, cleared on its boundary — and the successor's own turn is the next one", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const finished: Array<{ status: string; lastAssistantMessage: string | null }> = [];
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-B",
      agentSessionId: "sess-ab",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      onFinish: (info) => finished.push(info),
    });
    await untilRunning(store);

    // A's turn (the pre-turn Stop's turn) drains first.
    stream.push(turnStarted("turn_A"));
    await until(() => seen.length === 1, "A's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    expect(store.turnIds.has("run-B")).toBeFalse(); // NOT B's own turn
    stream.push(stopMessage("turn_A", "leftover reply"));
    stream.push(turnCancelled("turn_A"));
    await until(() => !store.obligations.has("run-A"), "A's obligation to clear");
    stream.push(sessionWaiting());
    await until(() => store.events.length === 4, "the leftover session.waiting to persist");
    expect(store.runStatus).toBe("running"); // A's boundary never classifies B

    // B's own turn.
    stream.push(turnStarted("turn_B"));
    await until(() => store.turnIds.get("run-B") === "turn_B", "B's own turn");
    stream.push(stopMessage("turn_B", "mine"));
    stream.push(turnCompleted("turn_B"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.runStatus).toBe("succeeded");
    expect(finished).toEqual([expect.objectContaining({ status: "succeeded", lastAssistantMessage: "mine" })]);
    expect(seen).toHaveLength(1); // B's own turn was never cancelled
  });

  test("a resuming tail reads its own turn from the row, never from persisted leftovers (seq > 0 proves nothing)", async () => {
    const store = memoryStore();
    // A crash mid-drain: two leftover events of a PREVIOUS turn persisted
    // under this run, no own turn.started yet, no turn_id.
    store.events.push(
      { runId: "run-R", seq: 0, event: JSON.parse(turnCompleted("turn_old")) },
      { runId: "run-R", seq: 1, event: JSON.parse(sessionWaiting()) },
    );
    const stream = liveStream();
    stream.push(sessionWaiting()); // yet another leftover
    const handle = tailRun({
      runId: "run-R",
      agentSessionId: "sess-r",
      openStream: stream.open,
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    await until(() => store.events.length === 3, "the leftover to persist");
    expect(store.runStatus).toBe("running"); // pre-fix: `seq > 0` ⇒ succeeded here
    stream.push(turnStarted("turn_R"));
    stream.push(turnCompleted("turn_R"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.runStatus).toBe("succeeded");
    expect(store.turnIds.get("run-R")).toBe("turn_R");
  });

  test("a resuming tail recovers a persisted own turn.started from before the column existed", async () => {
    const store = memoryStore();
    store.events.push({ runId: "run-P", seq: 0, event: JSON.parse(turnStarted("turn_P")) });
    const stream = liveStream();
    stream.push(turnCompleted("turn_P"));
    stream.push(sessionWaiting());
    const handle = tailRun({
      runId: "run-P",
      agentSessionId: "sess-p",
      openStream: stream.open,
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await handle.done;
    expect(store.turnIds.get("run-P")).toBe("turn_P");
    expect(store.runStatus).toBe("succeeded");
  });

  test("an observation that sees a turn nobody pending owns has seen a SUCCESSOR start: every owned obligation is over", async () => {
    const store = memoryStore();
    store.runStatus = "canceled";
    store.turnIds.set("run-S", "turn_S");
    store.obligations.set("run-S", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-S",
      agentSessionId: "sess-s",
      openStream: stream.open,
      cancelRemoteTurn: async () => {},
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    stream.push(turnStarted("turn_Z"));
    await handle.done;
    expect(store.obligations.has("run-S")).toBeFalse();
    expect(store.turnIds.get("run-S")).toBe("turn_S"); // never re-attributed
  });

  test("detach on an observation tail keeps the obligation (the sweeper re-opens it)", async () => {
    const store = memoryStore();
    store.runStatus = "canceled";
    store.obligations.set("run-D", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-D",
      agentSessionId: "sess-d",
      openStream: stream.open,
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.detach();
    await handle.done;
    expect(store.obligations.has("run-D")).toBeTrue();
  });
});

describe("RunTailerManager — one reader per session", () => {
  test("cancelRunGuarded resolves once the row is finalized, NOT when the observation ends; the observation keeps the tail registered until eve confirms", async () => {
    const store = memoryStore();
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    const stream = liveStream();
    const seen: Array<{ turnId?: string } | undefined> = [];
    const handle = manager.start({
      runId: "run-1",
      agentSessionId: "s",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
    });
    await until(() => store.runStatus === "running", "adoption");
    const outcome = await manager.cancelRunGuarded("run-1", "stopped", { awaitRemote: true });
    expect(outcome).toBe("pending");
    expect(store.runStatus).toBe("canceled");
    expect(manager.activeCount).toBe(1);
    expect(manager.hasSessionTail("s")).toBeTrue();
    // A duplicate Stop on an observation tail is a no-op.
    expect(await manager.cancelRunGuarded("run-1", "again", { awaitRemote: true })).toBeNull();
    stream.push(turnStarted("t1"));
    stream.push(turnCancelled("t1"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(seen).toEqual([{ turnId: "t1" }]);
    expect(manager.activeCount).toBe(0);
    expect(store.obligations.size).toBe(0);
  });

  test("observe() refuses a second reader on a session that already has a tail; start() on a session under observation detaches the observer and the new tail inherits its obligations", async () => {
    const store = memoryStore();
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const seen: Array<{ turnId?: string } | undefined> = [];
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    const observerStream = liveStream();
    const observer = manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: observerStream.open,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(observer).not.toBeNull();
    expect(observer!.observing).toBeTrue();
    expect(
      manager.observe({
        runId: "run-C",
        agentSessionId: "s",
        openStream: liveStream().open,
        cancelRemoteTurn,
        deadlineAt: Date.now() + 60_000,
      }),
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A successor's normal tail takes the session over.
    const successorStream = liveStream();
    const successor = manager.start({
      runId: "run-B",
      agentSessionId: "s",
      openStream: successorStream.open,
      cancelRemoteTurn,
    });
    await observer!.done; // detached (handover), obligation untouched
    expect(store.obligations.has("run-A")).toBeTrue();
    await until(() => store.runStatus === "running", "B to adopt after the handover");
    successorStream.push(turnStarted("turn_A"));
    await until(() => seen.length === 1, "A's qualified cancel from B's tail");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    successorStream.push(turnCancelled("turn_A"));
    successorStream.push(sessionWaiting());
    successorStream.push(turnStarted("turn_B"));
    successorStream.push(turnCompleted("turn_B"));
    successorStream.push(sessionWaiting());
    await successor.done;
    expect(store.obligations.size).toBe(0);
    expect(store.turnIds.get("run-B")).toBe("turn_B");
    expect(store.runStatus).toBe("succeeded");
    expect(manager.activeCount).toBe(0);
  });

  test("stopAll detaches an observation tail — the obligation survives for the next boot's sweeper", async () => {
    const store = memoryStore();
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    const stream = liveStream();
    manager.start({
      runId: "run-1",
      agentSessionId: "s",
      openStream: stream.open,
      cancelRemoteTurn: async () => {},
    });
    await until(() => store.runStatus === "running", "adoption");
    await manager.cancelRunGuarded("run-1", "stopped", { awaitRemote: true });
    expect(store.obligations.has("run-1")).toBeTrue();
    await manager.stopAll("shutdown");
    expect(manager.activeCount).toBe(0);
    expect(store.obligations.has("run-1")).toBeTrue();
    expect(store.runStatus).toBe("canceled");
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
