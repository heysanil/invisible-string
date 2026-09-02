/**
 * Tailer unit tests: NDJSON parsing (fixtures captured live in the Phase-0
 * spike), terminal classification, seq bookkeeping, `startIndex` reconnect,
 * reconnect exhaustion, and the wall-clock cap — all against in-memory
 * fakes (no DB, no network).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  DEFAULT_SEIZED_WRITE_MARGIN_MS,
  MAX_DRAINING_TAILS_PER_SESSION,
  classifyTerminal,
  ndjsonEvents,
  nextPendingAuthorization,
  nextPendingInputRequest,
  seizedWriteBoundMs,
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
  /** `runs.message_hash` per run — the turn correlator (null = content-less send). */
  messageHashes: Map<string, string | null>;
  /**
   * `remote_cancel_pending_at` / `remote_cancel_unresolved_at` per run;
   * `createdAt` (default = pendingAt) is the row age used as the identical-text
   * tie-breaker, and insertion order otherwise stands in for send order.
   */
  obligations: Map<string, { pendingAt: Date; unresolvedAt: Date | null; createdAt?: Date }>;
  /** Live runs on the session with a correlator and no turn yet (successor lookup). */
  liveRuns: Array<{ runId: string; messageHash: string | null }>;
  /** Record a run's latest send (the dispatch-attempt CAS's correlator write). */
  sent(runId: string, message: string | null): void;
}

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    events: [],
    runPatches: [],
    runStatus: null,
    sessionStatus: null,
    turnIds: new Map(),
    messageHashes: new Map(),
    obligations: new Map(),
    liveRuns: [],
    sent(runId, message) {
      store.messageHashes.set(runId, message === null ? null : sha256(message));
    },
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
      if (patch.messageHash !== undefined) store.messageHashes.set(runId, patch.messageHash);
      return true;
    },
    async getRunTurnState(runId) {
      return {
        status: store.runStatus ?? "queued",
        turnId: store.turnIds.get(runId) ?? null,
        messageHash: store.messageHashes.get(runId) ?? null,
        remoteCancelPendingAt: store.obligations.get(runId)?.pendingAt ?? null,
      };
    },
    async setRunTurnId(runId, turnId) {
      const current = store.turnIds.get(runId);
      if (current !== undefined && current !== turnId) return false;
      store.turnIds.set(runId, turnId);
      return true;
    },
    async listSessionClaimants() {
      // ONE read (mirrors the drizzle store's single statement): unresolved
      // obligations INCLUDED, ranked last, oldest first within each band;
      // live runs = those with a correlator and no turn yet.
      const obligations = [...store.obligations.entries()]
        .map(([runId, o], index) => ({
          runId,
          turnId: store.turnIds.get(runId) ?? null,
          messageHash: store.messageHashes.get(runId) ?? null,
          pendingAt: o.pendingAt,
          unresolvedAt: o.unresolvedAt,
          createdAt: o.createdAt ?? new Date(o.pendingAt.getTime() + index),
        }))
        .sort((a, b) =>
          (a.unresolvedAt === null) !== (b.unresolvedAt === null)
            ? a.unresolvedAt === null
              ? -1
              : 1
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
      const live = store.liveRuns
        .filter((run) => !store.turnIds.has(run.runId) && !store.obligations.has(run.runId))
        .map((run, index) => ({ ...run, createdAt: new Date(index) }));
      return { obligations, live };
    },
    async listUnownedContentTurns() {
      // Persisted `message.received` turns no run owns (no turn_id equals
      // their id), oldest first, with whether their boundary is on disk.
      const owned = new Set(store.turnIds.values());
      return store.events
        .map((e) => e.event)
        .filter(
          (event): event is Extract<EveStreamEvent, { type: "message.received" }> =>
            event.type === "message.received",
        )
        .filter((event) => !owned.has(event.data.turnId))
        .map((event) => ({
          turnId: event.data.turnId,
          messageHash: sha256(event.data.message),
          ended: store.events.some(
            (e) =>
              (e.event.type === "turn.cancelled" || e.event.type === "turn.completed") &&
              e.event.data.turnId === event.data.turnId,
          ),
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

/** The messages the committed fixtures' turns were opened with (their correlators). */
const PONG = "Reply with exactly: pong"; // mocked-turn-events.ndjson
const PARKED = "Call the record_note tool with note: 'durability-proof'."; // mocked-parked-events.ndjson

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const turnStarted = (turnId: string) =>
  JSON.stringify({ type: "turn.started", data: { sequence: 0, turnId } });
/** eve's echo of the message that opened `turnId` — the turn's correlator. */
const messageReceived = (turnId: string, message: string) =>
  JSON.stringify({
    type: "message.received",
    data: { message, parts: [{ type: "text", text: message }], sequence: 0, turnId },
  });
/** The content-less opening of an input-response turn (no message.received). */
const stepStarted = (turnId: string) =>
  JSON.stringify({ type: "step.started", data: { sequence: 0, stepIndex: 0, turnId } });
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
    store.sent("run-1", PONG);
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
    store.sent("run-1", PARKED);
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
    store.sent("run-1", PONG);
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
    const seen: Array<{ turnId?: string } | undefined> = [];

    const handle = tailRun({
      runId: "run-1",
      agentSessionId: "sess-1",
      openStream: async (_startIndex, signal) =>
        // Two events, then silence — the run never reaches a terminal event.
        ndjsonResponse(lines.slice(0, 2), { stayOpen: true, signal }),
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus,
      maxWallClockMs: 60,
      remoteCancelObserveMs: 40,
      onFinish: (info) => finishes.push(info),
    });
    await handle.done;

    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toContain("wall-clock cap");
    // Partial progress is preserved — the `turn.started` is HELD until its
    // correlator arrives (never did), so only the session.started landed.
    expect(store.events.map((e) => e.event.type)).toEqual(["session.started"]);
    // No stop-message was seen → nothing for the delivery seam.
    expect(finishes[0]?.lastAssistantMessage).toBeNull();
    // A turn that may still be running owes eve the same confirmation a
    // Stop does: the obligation rides the failing CAS, observation followed
    // it to its window, and the residual was declared — never a silent clear.
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(store.obligations.get("run-1")?.unresolvedAt).toBeInstanceOf(Date);
    expect(seen).toHaveLength(0); // the turn was never attributed: nothing (unqualified) was sent
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
    store.sent("run-2", "follow-up");
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
    store.sent("run-1", PONG);
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
    store.sent("run-c", "hi");
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
    store.sent("run-d", "hi");
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

  test("the wall-clock cap BEFORE the turn is attributed sends NOTHING (never an unqualified cancel), settles `failed` WITH the obligation, and observes", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-wc", "slow work");
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-wc",
      agentSessionId: "sess-wc",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 30,
    });
    await until(() => store.runStatus === "failed", "the cap to settle the row");
    // Pre-fix: one UNQUALIFIED `{}` cancel went out here — a no-op at eve
    // before `turn.started`, and a successor's turn killer if it arrived late.
    expect(seen).toHaveLength(0);
    expect(store.runPatches.at(-1)?.error).toContain("wall-clock cap");
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(store.obligations.has("run-wc")).toBeTrue();
    expect(handle.observing).toBeTrue();

    // The turn starts late: attributed by content, cancelled QUALIFIED,
    // cleared on its boundary — exactly like a Stop.
    stream.push(turnStarted("turn_wc"));
    stream.push(messageReceived("turn_wc", "slow work"));
    await until(() => seen.length === 1, "the qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_wc" }]);
    stream.push(turnCancelled("turn_wc"));
    await handle.done;
    expect(store.obligations.has("run-wc")).toBeFalse();
    expect(store.runStatus).toBe("failed"); // never re-marked
  });

  test("the wall-clock cap AFTER the turn is attributed issues the QUALIFIED cancel, and a failing remote cancel never fails the run harder", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-wc2", "slow work");
    const stream = liveStream();
    stream.push(turnStarted("turn_wc2"));
    stream.push(messageReceived("turn_wc2", "slow work"));
    const handle = tailRun({
      runId: "run-wc2",
      agentSessionId: "sess-wc2",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
        throw new Error("worker unreachable");
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60,
      remoteCancelObserveMs: 80,
    });
    await until(() => store.turnIds.get("run-wc2") === "turn_wc2", "the own turn");
    await handle.done; // the cap fires, observation elapses (transport keeps failing)
    expect(seen[0]).toEqual({ turnId: "turn_wc2" }); // qualified, never `{}`
    expect(seen.every((o) => o?.turnId === "turn_wc2")).toBeTrue();
    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.error).toContain("wall-clock cap");
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    // A transport failure never records the obligation as done.
    expect(store.obligations.get("run-wc2")?.unresolvedAt).toBeInstanceOf(Date);
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
    store.sent("run-pre", "stop me");
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
    stream.push(messageReceived("turn_9", "stop me"));
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
    expect(store.events.map((e) => e.event.type)).toEqual([
      "turn.started",
      "message.received",
      "turn.cancelled",
    ]);
  });

  test("a Stop AFTER turn.started issues the QUALIFIED cancel, still owes the boundary, and clears it on turn.completed", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-post", "work");
    const stream = liveStream();
    stream.push(turnStarted("turn_7"));
    stream.push(messageReceived("turn_7", "work"));
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
    store.sent("run-proof", PONG);
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
    store.sent("run-term", "work");
    const stream = liveStream();
    stream.push(turnStarted("turn_t"));
    stream.push(messageReceived("turn_t", "work"));
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
    store.sent("run-fail", "work");
    const stream = liveStream();
    stream.push(turnStarted("turn_f"));
    stream.push(messageReceived("turn_f", "work"));
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
    store.sent("run-A", "a");
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
    stream.push(messageReceived("turn_A", "a"));
    await until(() => seen.length === 1, "the qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    stream.push(turnCompleted("turn_A"));
    await handle.done;
    expect(store.obligations.has("run-A")).toBeFalse();
    expect(store.runPatches).toHaveLength(0); // no adoption, no re-marking
    expect(store.events.map((e) => e.event.type)).toEqual([
      "turn.started",
      "message.received",
      "turn.completed",
    ]);
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
    store.sent("run-A", "first");
    store.sent("run-B", "second");
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
    stream.push(messageReceived("turn_A", "first"));
    await until(() => seen.length === 1, "A's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    expect(store.turnIds.has("run-B")).toBeFalse(); // NOT B's own turn
    stream.push(stopMessage("turn_A", "leftover reply"));
    stream.push(turnCancelled("turn_A"));
    await until(() => !store.obligations.has("run-A"), "A's obligation to clear");
    stream.push(sessionWaiting());
    await until(() => store.events.length === 5, "the leftover session.waiting to persist");
    expect(store.runStatus).toBe("running"); // A's boundary never classifies B

    // B's own turn.
    stream.push(turnStarted("turn_B"));
    stream.push(messageReceived("turn_B", "second"));
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

  test("a resuming tail recovers its own persisted turn opening BY CONTENT when the proof never landed (never from a bare last turn.started, which may be foreign)", async () => {
    const store = memoryStore();
    store.sent("run-P", "mine");
    // A foreign opening persisted under this run, then the run's own —
    // its proof write lost — followed by its correlator.
    store.events.push(
      { runId: "run-P", seq: 0, event: JSON.parse(turnStarted("turn_X")) },
      { runId: "run-P", seq: 1, event: JSON.parse(messageReceived("turn_X", "theirs")) },
      { runId: "run-P", seq: 2, event: JSON.parse(turnStarted("turn_P")) },
      { runId: "run-P", seq: 3, event: JSON.parse(messageReceived("turn_P", "mine")) },
    );
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

  test("an observation that sees a turn nobody owns start has seen eve SERIALIZE past its attributed turn: every attributed obligation is over (the foreign turn itself is never attributed)", async () => {
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
    stream.push(messageReceived("turn_Z", "somebody else's"));
    await handle.done;
    expect(store.obligations.has("run-S")).toBeFalse();
    expect(store.turnIds.get("run-S")).toBe("turn_S"); // never re-attributed
    expect([...store.turnIds.values()]).not.toContain("turn_Z"); // foreign: nobody's
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

describe("tailRun — turn attribution by CONTENT (never by send order)", () => {
  const untilRunning = async (store: { runStatus: string | null }) => {
    await until(() => store.runStatus === "running", "the tail to adopt the run");
  };

  test("(a) a never-sent obligation cannot steal a successor's turn: B's message.received attributes to B only, A never claims it, no cancel ever hits B", async () => {
    // A was armed + canceled; its send failed (or crashed) before eve.
    // B then sent DIFFERENT text on the same session. Pre-fix: A — the
    // session's oldest open obligation with a null turn — claimed B's
    // `turn.started` in send order and a qualified cancel killed B's turn.
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-A", "alpha");
    store.sent("run-B", "beta");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
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
    });
    await untilRunning(store);
    stream.push(turnStarted("turn_1"));
    stream.push(messageReceived("turn_1", "beta"));
    await until(() => store.turnIds.get("run-B") === "turn_1", "B's own turn by content");
    expect(store.turnIds.has("run-A")).toBeFalse(); // pre-fix: "turn_1"
    expect(seen).toHaveLength(0); // pre-fix: [{ turnId: "turn_1" }] — B's turn cancelled
    // A newer run's proven turn supersedes A (eve is FIFO: A's message, had
    // it arrived, would have run first) — nothing owed, nothing cancelled.
    expect(store.obligations.has("run-A")).toBeFalse();
    stream.push(stopMessage("turn_1", "done"));
    stream.push(turnCompleted("turn_1"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.runStatus).toBe("succeeded");
    expect(seen).toHaveLength(0);
  });

  test("(b) an UNRESOLVED obligation stays attributable: A's late turn (matching content) is attributed to A, cancelled qualified, and clears BOTH columns; B is untouched", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-A", "alpha");
    store.sent("run-B", "beta");
    store.obligations.set("run-A", {
      pendingAt: new Date(Date.now() - 60_000),
      unresolvedAt: new Date(Date.now() - 1_000), // past the window, declared
    });
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
    });
    await untilRunning(store);
    // A's turn arrives late (eve was slow), before B's.
    stream.push(turnStarted("turn_A"));
    stream.push(messageReceived("turn_A", "alpha"));
    await until(() => seen.length === 1, "A's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    expect(store.turnIds.has("run-B")).toBeFalse(); // pre-fix: B claimed turn_A as its own
    stream.push(turnCancelled("turn_A"));
    await until(() => !store.obligations.has("run-A"), "A's obligation to clear (both columns)");
    stream.push(sessionWaiting());
    // B's own turn is the next one.
    stream.push(turnStarted("turn_B"));
    stream.push(messageReceived("turn_B", "beta"));
    await until(() => store.turnIds.get("run-B") === "turn_B", "B's own turn");
    stream.push(turnCompleted("turn_B"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.runStatus).toBe("succeeded");
    expect(seen).toHaveLength(1); // B was never cancelled
  });

  test("identical texts on one session: the oldest matching obligation claims first (pending before unresolved), then the next, then the tail's own — the documented tie", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-old", "same");
    store.sent("run-new", "same");
    store.sent("run-unres", "same");
    store.sent("run-B", "same");
    // The unresolved one is the OLDEST row but ranks last.
    store.obligations.set("run-unres", {
      pendingAt: new Date(0),
      unresolvedAt: new Date(),
      createdAt: new Date(0),
    });
    store.obligations.set("run-old", { pendingAt: new Date(1_000), unresolvedAt: null, createdAt: new Date(1_000) });
    store.obligations.set("run-new", { pendingAt: new Date(2_000), unresolvedAt: null, createdAt: new Date(2_000) });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-B",
      agentSessionId: "sess-same",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    for (const turnId of ["t1", "t2", "t3", "t4"]) {
      stream.push(turnStarted(turnId));
      stream.push(messageReceived(turnId, "same"));
      await until(() => [...store.turnIds.values()].includes(turnId), `${turnId} attributed`);
      stream.push(turnCancelled(turnId));
      stream.push(sessionWaiting());
    }
    expect(store.turnIds.get("run-old")).toBe("t1");
    expect(store.turnIds.get("run-new")).toBe("t2");
    expect(store.turnIds.get("run-unres")).toBe("t3");
    expect(store.turnIds.get("run-B")).toBe("t4");
    expect(seen).toEqual([{ turnId: "t1" }, { turnId: "t2" }, { turnId: "t3" }]);
    await handle.done;
    expect(store.runStatus).toBe("canceled"); // B's own turn was cancelled at eve
    expect(store.obligations.size).toBe(0);
  });

  test("a FOREIGN turn (content nobody on the session sent) is persisted, never attributed, never cancelled, and never classifies the run", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-B", "beta");
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-B",
      agentSessionId: "sess-f",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    stream.push(turnStarted("turn_x"));
    stream.push(messageReceived("turn_x", "not ours"));
    stream.push(turnCompleted("turn_x"));
    stream.push(sessionWaiting());
    await until(() => store.events.length === 4, "the foreign turn to persist");
    expect(store.turnIds.size).toBe(0);
    expect(seen).toHaveLength(0);
    expect(store.runStatus).toBe("running"); // its boundary is not ours
    stream.push(turnStarted("turn_b"));
    stream.push(messageReceived("turn_b", "beta"));
    stream.push(turnCompleted("turn_b"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.turnIds.get("run-B")).toBe("turn_b");
    expect(store.runStatus).toBe("succeeded");
  });

  test("content-less turns (an inputResponses resume opens with NO message.received) are attributed among content-less senders only, in send order", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-A", null); // A's latest send was an input response, then it was stopped
    store.sent("run-B", "beta"); // B sent a message
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-B",
      agentSessionId: "sess-cl",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    // A's resumed turn: turn.started straight to step.started.
    stream.push(turnStarted("turn_A"));
    stream.push(stepStarted("turn_A"));
    await until(() => seen.length === 1, "A's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    expect(store.turnIds.get("run-A")).toBe("turn_A");
    expect(store.turnIds.has("run-B")).toBeFalse(); // a message sender never claims a content-less turn
    stream.push(turnCancelled("turn_A"));
    stream.push(sessionWaiting());
    stream.push(turnStarted("turn_B"));
    stream.push(messageReceived("turn_B", "beta"));
    stream.push(turnCompleted("turn_B"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.turnIds.get("run-B")).toBe("turn_B");
    expect(store.runStatus).toBe("succeeded");
  });

  test("a follow tail whose OWN latest send was an input response claims the content-less turn as its own — and never a content turn", async () => {
    const store = memoryStore();
    store.sent("run-R", null);
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-R",
      agentSessionId: "sess-r",
      openStream: stream.open,
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    // Somebody's content turn first — not ours.
    stream.push(turnStarted("turn_c"));
    stream.push(messageReceived("turn_c", "text"));
    stream.push(turnCompleted("turn_c"));
    stream.push(sessionWaiting());
    await until(() => store.events.length === 4, "the content turn to persist");
    expect(store.turnIds.has("run-R")).toBeFalse();
    expect(store.runStatus).toBe("running");
    // The resumed turn.
    stream.push(turnStarted("turn_r"));
    stream.push(stepStarted("turn_r"));
    stream.push(turnCompleted("turn_r"));
    stream.push(sessionWaiting());
    await handle.done;
    expect(store.turnIds.get("run-R")).toBe("turn_r");
    expect(store.runStatus).toBe("succeeded");
  });

  test("an observation tail that drains a LIVE successor's turn hands the successor its proof by content (turn_id written) and is superseded", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-S", "stopped");
    store.sent("run-N", "next");
    store.obligations.set("run-S", { pendingAt: new Date(), unresolvedAt: null });
    store.liveRuns.push({ runId: "run-N", messageHash: sha256("next") });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-S",
      agentSessionId: "sess-succ",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    stream.push(turnStarted("turn_N"));
    stream.push(messageReceived("turn_N", "next"));
    await handle.done;
    expect(store.turnIds.get("run-N")).toBe("turn_N"); // the successor reads its own turn from the row
    expect(store.turnIds.has("run-S")).toBeFalse(); // never claimed by the never-started obligation
    expect(store.obligations.has("run-S")).toBeFalse(); // superseded by a newer run's proven turn
    expect(seen).toHaveLength(0);
  });

  test("a held turn.started survives a stream drop: it is never persisted before its correlator, and the reconnect re-reads it from the SAME cursor", async () => {
    const store = memoryStore();
    store.sent("run-H", "held");
    const startIndexes: number[] = [];
    let connects = 0;
    const handle = tailRun({
      runId: "run-H",
      agentSessionId: "sess-h",
      openStream: async (startIndex) => {
        startIndexes.push(startIndex);
        connects += 1;
        // 1st connect: the opening alone, then the stream ends (a drop).
        // 2nd connect: eve replays from the same cursor.
        return ndjsonResponse(
          connects === 1
            ? [turnStarted("t1")]
            : [turnStarted("t1"), messageReceived("t1", "held"), turnCompleted("t1"), sessionWaiting()],
        );
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 5_000,
      reconnectDelayMs: 1,
    });
    await handle.done;
    expect(startIndexes).toEqual([0, 0]);
    expect(store.events.map((e) => e.event.type)).toEqual([
      "turn.started",
      "message.received",
      "turn.completed",
      "session.waiting",
    ]);
    expect(store.turnIds.get("run-H")).toBe("t1");
    expect(store.runStatus).toBe("succeeded");
  });

  test("shutdown settles `failed` WITH the obligation and a QUALIFIED cancel when the turn is known — never an unqualified one — and aborts (the next boot's sweeper observes)", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-sd", "work");
    const stream = liveStream();
    stream.push(turnStarted("turn_sd"));
    stream.push(messageReceived("turn_sd", "work"));
    const handle = tailRun({
      runId: "run-sd",
      agentSessionId: "sess-sd",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await until(() => store.turnIds.get("run-sd") === "turn_sd", "the own turn");
    const outcome = await handle.cancel("control plane shutting down");
    await handle.done;
    expect(outcome).toBe("issued");
    expect(seen).toEqual([{ turnId: "turn_sd" }]);
    expect(store.runStatus).toBe("failed");
    expect(store.runPatches.at(-1)?.remoteCancelPendingAt).toBeInstanceOf(Date);
    expect(store.obligations.has("run-sd")).toBeTrue();
    expect(handle.observing).toBeFalse();
  });

  test("shutdown BEFORE the turn is known sends nothing and still records the obligation", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-sd2", "work");
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-sd2",
      agentSessionId: "sess-sd2",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await untilRunning(store);
    expect(await handle.cancel("control plane shutting down")).toBe("pending");
    await handle.done;
    expect(seen).toHaveLength(0);
    expect(store.runStatus).toBe("failed");
    expect(store.obligations.has("run-sd2")).toBeTrue();
  });
});

describe("RunTailerManager — one reader per session", () => {
  test("cancelRunGuarded resolves once the row is finalized, NOT when the observation ends; the observation keeps the tail registered until eve confirms", async () => {
    const store = memoryStore();
    store.sent("run-1", "m");
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
    stream.push(messageReceived("t1", "m"));
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
    store.sent("run-A", "a");
    store.sent("run-B", "b");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const seen: Array<{ turnId?: string } | undefined> = [];
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    const observerStream = liveStream();
    const observer = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: observerStream.open,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(observer).not.toBeNull();
    expect(observer!.observing).toBeTrue();
    expect(
      await manager.observe({
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
    successorStream.push(messageReceived("turn_A", "a"));
    await until(() => seen.length === 1, "A's qualified cancel from B's tail");
    expect(seen).toEqual([{ turnId: "turn_A" }]);
    successorStream.push(turnCancelled("turn_A"));
    successorStream.push(sessionWaiting());
    successorStream.push(turnStarted("turn_B"));
    successorStream.push(messageReceived("turn_B", "b"));
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

describe("tailRun — current obligations and serialized settlement (round 12: R1, R2)", () => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
  }
  const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("R1 — an obligation created AFTER the observation loaded its list (a continuation Stopped before its own tail started) is adopted at the turn opening: attributed by hash, cancelled QUALIFIED, cleared on its boundary — never persisted as foreign", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-A",
      agentSessionId: "sess-r1",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await sleep(10); // the observation is on the stream with [A] loaded

    // B: admitted while A observed, sent, and Stopped with NO tail of its
    // own — its marker lands after A's tail loaded its list, and B is
    // terminal, so the live-successor lookup cannot see it either.
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    stream.push(turnStarted("turn_B"));
    stream.push(messageReceived("turn_B", "b"));
    // Pre-fix: B's turn matched nothing in A's stale list, was persisted
    // FOREIGN, no cancel was ever sent, and B aged out unresolved.
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    expect(store.turnIds.get("run-B")).toBe("turn_B");
    expect(store.turnIds.has("run-A")).toBeFalse(); // A never claims B's text
    expect(store.events.map((e) => e.event.type)).toEqual(["turn.started", "message.received"]);

    stream.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B's obligation cleared on its boundary");
    // A's own turn never started: still owed, the observation goes on.
    expect(store.obligations.has("run-A")).toBeTrue();
    expect(handle.observing).toBeTrue();
    handle.detach();
    await handle.done;
  });

  test("R1 — the manager's observe() refusal SIGNALS the live tail: an obligation whose turn a previous reader already attributed is adopted with its id and cancelled QUALIFIED at once", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    const stream = liveStream();
    const observer = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: stream.open,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(observer).not.toBeNull();
    await sleep(10);

    // B's turn was attributed by an earlier reader (its id is on the row);
    // then B was Stopped without a tail, and the settlement asked to
    // observe it — refused (one reader), which now signals A's tail.
    store.sent("run-B", "b");
    store.turnIds.set("run-B", "turn_B");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    expect(
      await manager.observe({
        runId: "run-B",
        agentSessionId: "s",
        openStream: liveStream().open,
        cancelRemoteTurn,
        deadlineAt: Date.now() + 60_000,
      }),
    ).toBeNull();
    // Pre-fix: nothing happened here — B's qualified cancel waited for a
    // turn opening that had already gone by.
    await until(() => seen.length === 1, "B's qualified cancel from the signaled tail");
    expect(seen).toEqual([{ turnId: "turn_B" }]);

    stream.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    expect(store.obligations.has("run-A")).toBeTrue();
    expect(await manager.refreshSessionObligations("s")).toBeTrue();
    expect(await manager.refreshSessionObligations("nobody")).toBeFalse();
    await manager.stopAll();
  });

  /** A store whose FIRST `setRunTurnId` parks until released (attribution in flight). */
  function gatedStore(runId: string, message: string) {
    const store = memoryStore();
    store.sent(runId, message);
    const gate = deferred();
    let reached = false;
    const real = store.setRunTurnId;
    store.setRunTurnId = async (id, turnId) => {
      if (!reached) {
        reached = true;
        await gate.promise;
      }
      return real(id, turnId);
    };
    return { store, gate, reached: () => reached };
  }

  test("R2 — a Stop landing while the attribution's setRunTurnId is in flight waits for it and issues the QUALIFIED cancel with the attributed id (never a null-id obligation the boundary cannot match)", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const { store, gate, reached } = gatedStore("run-R", "race");
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-R",
      agentSessionId: "sess-r2",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
    });
    await until(() => store.runStatus === "running", "the tail to adopt the run");
    stream.push(turnStarted("turn_R"));
    stream.push(messageReceived("turn_R", "race"));
    await until(reached, "the attribution to reach setRunTurnId");

    // The Stop lands with the attribution parked mid-write.
    const stop = handle.cancel("stopped by user", { status: "canceled", awaitRemote: true });
    expect(await settled(stop)).toBeFalse(); // waits for the attribution
    gate.resolve();
    // Pre-fix: the settlement snapshotted `ownTurnId === null`, answered
    // `pending`, installed a null-id obligation, and the qualified cancel
    // was never sent.
    expect(await stop).toBe("issued");
    expect(seen).toEqual([{ turnId: "turn_R" }]);
    expect(store.turnIds.get("run-R")).toBe("turn_R");
    expect(store.runStatus).toBe("canceled");
    expect(store.obligations.has("run-R")).toBeTrue();
    expect(handle.observing).toBeTrue();

    // eve's own confirmation matches the attributed id and ends observation.
    stream.push(turnCancelled("turn_R"));
    await handle.done;
    expect(store.obligations.has("run-R")).toBeFalse();
  });

  test("R2 — the wall-clock cap firing while the attribution is in flight settles AFTER it and issues the QUALIFIED cancel with the attributed id", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const { store, gate, reached } = gatedStore("run-W", "capped");
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-W",
      agentSessionId: "sess-r2w",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 120,
    });
    await until(() => store.runStatus === "running", "the tail to adopt the run");
    stream.push(turnStarted("turn_W"));
    stream.push(messageReceived("turn_W", "capped"));
    await until(reached, "the attribution to reach setRunTurnId");
    await sleep(200); // the cap has fired; its settlement is queued behind the attribution
    expect(store.runStatus).toBe("running"); // pre-fix: already `failed` with a null-id obligation
    gate.resolve();
    await until(() => store.runStatus === "failed", "the cap's settlement");
    await until(() => seen.length === 1, "the qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_W" }]);
    expect(store.obligations.has("run-W")).toBeTrue();
    stream.push(turnCompleted("turn_W"));
    await handle.done;
    expect(store.obligations.has("run-W")).toBeFalse();
  });
});

describe("tailer — ordering races (round 13: X1 one-read claimants + retroactive adoption, X2 handoff liveness)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("X1 — the claimant set is ONE read: B live+unmarked when the obligations are read, Stopped (marker committed) before any successor lookup could run, its turn opening in between → attributed at the opening (turn_id written, A superseded), and B's settlement finds its proof on the row: cancelled QUALIFIED at once, cleared on its boundary", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    // B: admitted while A observes, sent — live and unmarked.
    store.sent("run-B", "b");
    store.liveRuns.push({ runId: "run-B", messageHash: sha256("b") });
    // The reviewer's interleaving: B's no-tail Stop commits its marker (and
    // its terminal status) right after the tail's FIRST claimant read for
    // B's turn opening. Pre-fix that read was the obligations list alone
    // (B absent: unmarked) and the live-successor query came AFTER — by
    // then B was terminal, so it was in neither: FOREIGN.
    let armed = false;
    const real = store.listSessionClaimants;
    store.listSessionClaimants = async (id) => {
      const result = await real(id);
      if (armed) {
        armed = false;
        store.liveRuns = [];
        store.obligations.set("run-B", {
          pendingAt: new Date(),
          unresolvedAt: null,
          createdAt: new Date(Date.now() + 1),
        });
      }
      return result;
    };
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    const streamA = liveStream();
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: streamA.open,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(a).not.toBeNull();
    await sleep(10); // the observation is on the stream with [A] loaded
    armed = true;
    streamA.push(turnStarted("turn_B"));
    streamA.push(messageReceived("turn_B", "b"));
    // ONE snapshot: B was live in it, so the opening handed B its proof —
    // pre-fix this never happened (B was in neither read).
    await until(() => store.turnIds.get("run-B") === "turn_B", "B's proof from the opening");
    expect(store.turnIds.has("run-A")).toBeFalse();
    // A newer run's proven turn supersedes A: its observation closes.
    await a!.done;
    expect(store.obligations.has("run-A")).toBeFalse();
    expect(seen).toHaveLength(0);
    // B's Stop settles: no live reader on the session any more, so the
    // settlement opens B's own observation — which finds B's turn on the
    // row and issues the qualified cancel at once.
    expect(await manager.refreshSessionObligations("s")).toBeFalse();
    const streamB = liveStream();
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: streamB.open,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(b).not.toBeNull();
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    streamB.push(turnCancelled("turn_B"));
    await b!.done;
    expect(store.obligations.has("run-B")).toBeFalse();
    expect(manager.activeCount).toBe(0);
  });

  test("X1 — adoption is RETROACTIVE: an obligation adopted with a null turn id whose content turn is already persisted on the session (classified foreign when it opened) is attributed from disk, cancelled QUALIFIED, and cleared on its boundary", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const stream = liveStream();
    const handle = tailRun({
      runId: "run-A",
      agentSessionId: "sess-x1b",
      openStream: stream.open,
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await sleep(10);
    // B's turn opens while the store knows NOTHING that can claim it (no
    // marker, not live as far as the reader can see): foreign, persisted.
    stream.push(turnStarted("turn_B"));
    stream.push(messageReceived("turn_B", "b"));
    await until(() => store.events.length === 2, "B's turn opening to be persisted");
    expect(store.turnIds.has("run-B")).toBeFalse();
    expect(seen).toHaveLength(0);
    // Now B's Stop lands (marker, hash) and the settlement signals the tail.
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    expect(await handle.refreshObligations()).toBeTrue();
    // Pre-fix: adopted with turn_id null, waiting for an opening that had
    // already gone by — no cancel, and the boundary below matched nothing.
    await until(() => seen.length === 1, "B's qualified cancel from the persisted turn");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    expect(store.turnIds.get("run-B")).toBe("turn_B");
    stream.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    expect(store.obligations.has("run-A")).toBeTrue();
    handle.detach();
    await handle.done;
  });

  test("X1 — a re-opened observation (the sweeper's shape) whose own turn AND boundary are already persisted under an earlier reader (foreign then) meets the obligation on the spot — no cancel, no window, the row's status untouched", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-B", "b");
    store.obligations.set("run-B", { pendingAt: new Date(), unresolvedAt: null });
    // An earlier reader (run-P's tail) persisted B's whole turn as foreign.
    const persisted = [
      turnStarted("turn_B"),
      messageReceived("turn_B", "b"),
      turnCancelled("turn_B"),
      sessionWaiting(),
    ].map((line) => JSON.parse(line) as EveStreamEvent);
    persisted.forEach((event, seq) => store.events.push({ runId: "run-P", seq, event }));
    let connects = 0;
    const handle = tailRun({
      runId: "run-B",
      agentSessionId: "sess-x1c",
      openStream: async (...args) => {
        connects += 1;
        return liveStream().open(...args);
      },
      cancelRemoteTurn: async (options) => {
        seen.push(options);
      },
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      observe: { deadlineAt: Date.now() + 60_000 },
    });
    await handle.done;
    expect(store.turnIds.get("run-B")).toBe("turn_B");
    expect(store.obligations.has("run-B")).toBeFalse();
    expect(seen).toHaveLength(0); // the boundary is on disk: nothing to cancel
    expect(connects).toBe(0); // met before the stream was ever opened
    expect(store.runStatus).toBe("canceled");
    expect(store.runPatches).toHaveLength(0);
  });

  test("X2 — a handoff to an ABORTED tail is refused: A's observation closes (deadline → unresolved) while its reconnect hangs, B's settlement arrives before A's `done` → B gets its own observer at once (chained behind A's cursor — one reader), and B's cancel goes out QUALIFIED on its turn", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
    });
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    // A's stream: the first connect drops at once; the reconnect HANGS
    // (a slow worker) until the test releases it — so A's abort lands long
    // before its `done` resolves.
    let connectsA = 0;
    const hangA: { release: ((error: Error) => void) | null } = { release: null };
    const openA: OpenRunStream = async () => {
      connectsA += 1;
      if (connectsA === 1) return ndjsonResponse([]);
      return new Promise<Response>((_resolve, reject) => {
        hangA.release = reject;
      });
    };
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: openA,
      cancelRemoteTurn,
      deadlineAt: Date.now() + 40,
    });
    expect(a).not.toBeNull();
    await until(() => hangA.release !== null, "A's reconnect to hang");
    await until(() => a!.closed, "A's observation to close on its deadline");
    expect(store.obligations.get("run-A")?.unresolvedAt).not.toBeNull();
    expect(await settled(a!.done)).toBeFalse(); // the cursor is NOT released yet
    // A is no reader any more — but it still holds the stream.
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    expect(await manager.refreshSessionObligations("s")).toBeFalse();

    // B: Stopped without a tail; the guarded settlement asks to observe it.
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    const streamB = liveStream();
    let connectsB = 0;
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (...args) => {
        connectsB += 1;
        return streamB.open(...args);
      },
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    // Pre-fix: null — A was still in the session map, the signal returned
    // silently because A was aborted, and B had no reader until the sweep.
    expect(b).not.toBeNull();
    expect(b!.observing).toBeTrue();
    expect(manager.hasSessionTail("s")).toBeTrue();
    expect(manager.get("run-B")).toBe(b!);
    // ONE reader: B waits for A's cursor to be released before it opens.
    await sleep(20);
    expect(connectsB).toBe(0);
    hangA.release!(new Error("aborted"));
    await a!.done;
    await until(() => connectsB === 1, "B to open the stream once A released it");
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    streamB.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    expect(store.obligations.has("run-A")).toBeTrue(); // the honest residual stands
    b!.detach(); // A's unresolved obligation is still followed (attributable)
    await b!.done;
    expect(manager.activeCount).toBe(0);
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("X2 — start() on a session whose tail is draining chains behind its cursor (never a second reader), and a follow tail that has reached its terminal leaves the reader slot at once", async () => {
    const store = memoryStore();
    store.sent("run-1", "one");
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    // run-1's stream: the body read hangs after the terminal is consumed.
    const body: { release: (() => void) | null } = { release: null };
    const encoder = new TextEncoder();
    const open1: OpenRunStream = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const line of [
              turnStarted("t1"),
              messageReceived("t1", "one"),
              turnCompleted("t1"),
              sessionWaiting(),
            ]) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
            body.release = () => controller.close();
          },
        }),
        { status: 200 },
      );
    const first = manager.start({ runId: "run-1", agentSessionId: "s", openStream: open1 });
    await until(() => store.runStatus === "succeeded", "run-1 to reach its terminal");
    await first.done; // a terminal returns from the loop: done resolves regardless of the body
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
    body.release?.();

    // Now an OBSERVATION tail that aborts on a hung reconnect, then a
    // successor's normal tail: it must wait for the draining cursor.
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    let connectsA = 0;
    const hangA: { release: ((error: Error) => void) | null } = { release: null };
    const observer = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: async () => {
        connectsA += 1;
        if (connectsA === 1) return ndjsonResponse([]);
        return new Promise<Response>((_resolve, reject) => {
          hangA.release = reject;
        });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    await until(() => hangA.release !== null, "A's reconnect to hang");
    observer!.detach(); // aborted, cursor still held
    expect(observer!.closed).toBeTrue();
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    store.runStatus = null;
    store.sent("run-B", "b");
    let connectsB = 0;
    const streamB = liveStream();
    const successor = manager.start({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (...args) => {
        connectsB += 1;
        return streamB.open(...args);
      },
      cancelRemoteTurn: async () => {},
    });
    expect(manager.hasSessionTail("s")).toBeTrue();
    await sleep(20);
    expect(connectsB).toBe(0); // chained: nothing read while A holds the cursor
    expect(await store.getRunStatus("run-B")).toBeNull(); // not even adopted yet
    hangA.release!(new Error("aborted"));
    await observer!.done;
    await until(() => connectsB === 1, "B to open once the cursor is released");
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    streamB.push(turnCompleted("turn_B"));
    streamB.push(sessionWaiting());
    await successor.done;
    expect(await store.getRunStatus("run-B")).toEqual({ status: "succeeded", error: null });
    expect(manager.activeCount).toBe(0);
  });
});

describe("tailer — liveness (round 14: Y1 close-on-every-exit, Y2 bounded chain wait + deadline armed at creation)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A promise the test resolves by hand. */
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };

  test("Y1 — a tail exiting through its NATURAL terminal closes synchronously: B's settlement signal landing while A's terminal writes are still in flight is refused (never adopted by a tail about to return), B gets its own observer at once — chained behind A's cursor — and B's cancel goes out QUALIFIED on its turn", async () => {
    const seen: Array<{ turnId?: string } | undefined> = [];
    const store = memoryStore();
    store.sent("run-A", "a");
    // A's terminal write (`markRun succeeded`) hangs until the test opens
    // the gate: the window between A's terminal and its `done.finally`.
    const terminalWrite = gate();
    const markRun = store.markRun;
    store.markRun = async (runId, patch) => {
      if (patch.status === "succeeded") await terminalWrite.promise;
      return markRun(runId, patch);
    };
    const manager = new RunTailerManager({ store, bus: new RunEventBus(), maxWallClockMs: 60_000 });
    const cancelRemoteTurn = async (options?: { turnId?: string }) => {
      seen.push(options);
    };
    const streamA = liveStream();
    const a = manager.start({
      runId: "run-A",
      agentSessionId: "s",
      openStream: streamA.open,
      cancelRemoteTurn,
    });
    await until(() => store.runStatus === "running", "A to adopt its run");
    streamA.push(turnStarted("turn_A"));
    streamA.push(messageReceived("turn_A", "a"));
    streamA.push(turnCompleted("turn_A"));
    streamA.push(sessionWaiting());
    // A has reached its terminal and is inside the gated write.
    await until(() => a.closed, "A to close on its natural terminal");
    expect(store.runStatus).toBe("running"); // the terminal write has not landed
    expect(await settled(a.done)).toBeFalse();
    // Pre-fix: A stayed in the reader slot until `done.finally` — a signal
    // here found `abort.signal.aborted === false`, A adopted B's obligation,
    // answered true, then returned: B had no reader until the next sweep.
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    store.sent("run-B", "b");
    store.obligations.set("run-B", { pendingAt: new Date(), unresolvedAt: null });
    expect(await manager.refreshSessionObligations("s")).toBeFalse();
    const streamB = liveStream();
    let connectsB = 0;
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (...args) => {
        connectsB += 1;
        return streamB.open(...args);
      },
      cancelRemoteTurn,
      deadlineAt: Date.now() + 60_000,
    });
    expect(b).not.toBeNull();
    expect(b!.observing).toBeTrue();
    expect(manager.hasSessionTail("s")).toBeTrue();
    // ONE reader: B is chained behind A's still-held cursor.
    await sleep(20);
    expect(connectsB).toBe(0);
    terminalWrite.open();
    await a.done;
    expect(store.runStatus).toBe("succeeded");
    await until(() => connectsB === 1, "B to open once A released the stream");
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    streamB.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    await b!.done;
    expect(manager.activeCount).toBe(0);
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("Y1 — reconnect exhaustion closes synchronously too: the handle leaves the reader slot before the `failed` write lands, and a signal in that window is refused", async () => {
    const store = memoryStore();
    store.sent("run-A", "a");
    const failedWrite = gate();
    const markRun = store.markRun;
    store.markRun = async (runId, patch) => {
      if (patch.status === "failed") await failedWrite.promise;
      return markRun(runId, patch);
    };
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      maxReconnectAttempts: 1,
      reconnectDelayMs: 1,
    });
    const a = manager.start({
      runId: "run-A",
      agentSessionId: "s",
      openStream: async () => ndjsonResponse([]), // drops at once, every time
      cancelRemoteTurn: async () => {},
    });
    await until(() => a.closed, "A to close on reconnect exhaustion");
    expect(store.runStatus).toBe("running");
    expect(await settled(a.done)).toBeFalse();
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    store.sent("run-B", "b");
    store.obligations.set("run-B", { pendingAt: new Date(), unresolvedAt: null });
    expect(await manager.refreshSessionObligations("s")).toBeFalse();
    failedWrite.open();
    await a.done;
    expect(store.runStatus).toBe("failed");
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("Y2 — a HUNG drain is seized: B chained behind A (closed, its reconnect never resolves) takes the stream over after the takeover bound — exactly one live reader, A fenced so its late-yielding connect writes NOTHING, no duplicate (run_id, seq)", async () => {
    const warns: string[] = [];
    const logger = createLogger({
      sink: (event) => {
        if (event.level === "warn") warns.push(event.event);
      },
      minLevel: "debug",
    });
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: 50,
      logger,
    });
    // A's reconnect HANGS and ignores the abort signal entirely (a proxy
    // that never answers) — the test resolves it LATE, with a body that
    // carries events, to prove the fence.
    let connectsA = 0;
    const hangA: { resolve: ((response: Response) => void) | null } = { resolve: null };
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: async () => {
        connectsA += 1;
        if (connectsA === 1) return ndjsonResponse([]);
        return new Promise<Response>((resolve) => {
          hangA.resolve = resolve;
        });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    await until(() => hangA.resolve !== null, "A's reconnect to hang");
    a!.detach(); // closed, cursor still held
    expect(manager.isSessionStreamHeld("s")).toBeTrue();

    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    const streamB = liveStream();
    let connectsB = 0;
    const seen: Array<{ turnId?: string } | undefined> = [];
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (...args) => {
        connectsB += 1;
        return streamB.open(...args);
      },
      cancelRemoteTurn: async (options?: { turnId?: string }) => {
        seen.push(options);
      },
      deadlineAt: Date.now() + 60_000,
    });
    expect(b).not.toBeNull();
    // Pre-fix: B awaited A's `done` with no bound — never opened, the
    // session wedged behind a drain nothing could release.
    await until(() => connectsB === 1, "B to take the stream over after the bound");
    expect(warns).toContain("run.tail_takeover");
    expect(await settled(a!.done)).toBeFalse(); // A's hung connect is abandoned, not resolved
    expect(manager.hasSessionTail("s")).toBeTrue(); // exactly one live reader: B
    expect(manager.get("run-B")).toBe(b!);
    expect(a!.closed).toBeTrue();
    // A's connect finally answers WITH events: fenced, A must write none.
    hangA.resolve!(
      ndjsonResponse([
        turnStarted("turn_late"),
        messageReceived("turn_late", "a"),
        turnCancelled("turn_late"),
        sessionWaiting(),
      ]),
    );
    await a!.done;
    expect(store.events.filter((e) => e.runId === "run-A")).toHaveLength(0);
    expect(store.turnIds.has("run-A")).toBeFalse(); // attributed nothing either
    // B reads its own turn; every persisted row is B's, each seq once.
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    streamB.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    expect(store.events.every((e) => e.runId === "run-B")).toBeTrue();
    expect(new Set(store.events.map((e) => e.seq)).size).toBe(store.events.length);
    b!.detach();
    await b!.done;
    expect(manager.activeCount).toBe(0);
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("Y2 — the observation deadline is armed at CREATION: it fires DURING the chain wait, declares the obligation unresolved, and releases the handle — the chained observer never opens a stream and no longer blocks the session", async () => {
    const warns: string[] = [];
    const logger = createLogger({
      sink: (event) => {
        if (event.level === "warn") warns.push(event.event);
      },
      minLevel: "debug",
    });
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: 60_000, // the bound is NOT what ends this wait
      logger,
    });
    let connectsA = 0;
    const hangA: { release: ((error: Error) => void) | null } = { release: null };
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: async () => {
        connectsA += 1;
        if (connectsA === 1) return ndjsonResponse([]);
        return new Promise<Response>((_resolve, reject) => {
          hangA.release = reject;
        });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    await until(() => hangA.release !== null, "A's reconnect to hang");
    a!.detach();
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    let connectsB = 0;
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async () => {
        connectsB += 1;
        return ndjsonResponse([], { stayOpen: true });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 40,
    });
    expect(b).not.toBeNull();
    expect(manager.hasSessionTail("s")).toBeTrue();
    // Pre-fix: the deadline was armed only AFTER the chain wait, so it never
    // fired — B stayed the session's live tail forever.
    await until(
      () => store.obligations.get("run-B")?.unresolvedAt != null,
      "B declared unresolved on its deadline while chained",
    );
    expect(warns).toContain("run.remote_cancel_unresolved");
    expect(b!.closed).toBeTrue();
    await b!.done; // the chain wait ends on B's own close
    expect(connectsB).toBe(0); // never a second reader
    expect(manager.hasSessionTail("s")).toBeFalse();
    expect(manager.get("run-B")).toBeUndefined();
    expect(store.obligations.has("run-B")).toBeTrue(); // marker kept — the honest residual
    expect(manager.isSessionStreamHeld("s")).toBeTrue(); // A still drains
    hangA.release!(new Error("aborted"));
    await a!.done;
    expect(manager.activeCount).toBe(0);
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
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

describe("tailer — liveness (round 15: Z1 seized-write bound derived from statement_timeout, Z2 bounded draining list)", () => {
  /** A promise the test settles by hand. */
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const captureWarns = () => {
    const warns: string[] = [];
    const logger = createLogger({
      sink: (event) => {
        if (event.level === "warn") warns.push(event.event);
      },
      minLevel: "debug",
    });
    return { warns, logger };
  };
  /** The DB kills a statement at `statement_timeout`: postgres-js surfaces 57014. */
  const statementTimeoutError = () =>
    Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  // The derived bound the tests run on: 20 ms statement timeout + 20 ms
  // margin = 40 ms, behind a 30 ms first wait.
  const TAKEOVER = 30;
  const STATEMENT_TIMEOUT = 20;
  const MARGIN = 20;
  const BOUND = seizedWriteBoundMs(STATEMENT_TIMEOUT, MARGIN);

  test("seizedWriteBoundMs derives the bound from the statement timeout plus the margin — never two unrelated numbers", () => {
    expect(BOUND).toBe(40);
    expect(seizedWriteBoundMs(30_000)).toBe(30_000 + DEFAULT_SEIZED_WRITE_MARGIN_MS);
  });

  /**
   * A observing (canceled run-A owing a confirmation) on a live stream; its
   * appendEvent for run-A STALLS on the first call — the test decides later
   * whether that statement lands or dies. Returns the stall controls.
   */
  async function observeWithStalledAppend(
    manager: RunTailerManager,
    store: MemoryStore,
    streamA: ReturnType<typeof liveStream>,
  ) {
    const stall = deferred<void>();
    let appendCallsA = 0;
    let stalled = false;
    const appendEvent = store.appendEvent;
    store.appendEvent = async (runId, seq, event) => {
      if (runId === "run-A") {
        appendCallsA += 1;
        if (!stalled) {
          stalled = true;
          await stall.promise; // resolves = the statement landed; rejects = 57014
        }
      }
      return appendEvent(runId, seq, event);
    };
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: streamA.open,
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    expect(a).not.toBeNull();
    // A foreign turn (its content matches no run): attribution writes
    // nothing, then the held `turn.started` is persisted — and stalls.
    streamA.push(turnStarted("turn_x"));
    streamA.push(messageReceived("turn_x", "nobody sent this"));
    await until(() => stalled, "A to stall inside appendEvent");
    return { a: a!, stall, appendCallsA: () => appendCallsA };
  }

  test("Z1 — a seized tail's in-flight write DIES at the statement timeout: B waits the derived bound (not a fixed pause), reads the cursor only after it, and the session ends with exactly one (run_id, seq) sequence — the dead write is neither counted nor duplicated", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const streamA = liveStream();
    const { a, stall, appendCallsA } = await observeWithStalledAppend(manager, store, streamA);
    a.detach(); // closed, still BUSY inside the stalled write
    const detachedAt = Date.now();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();

    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    const streamB = liveStream();
    let startIndexB = -1;
    let connectedAt = 0;
    let rowsAtConnect = -1;
    const seen: Array<{ turnId?: string } | undefined> = [];
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (startIndex, signal) => {
        startIndexB = startIndex;
        connectedAt = Date.now();
        rowsAtConnect = store.events.length;
        return streamB.open(startIndex, signal);
      },
      cancelRemoteTurn: async (options?: { turnId?: string }) => {
        seen.push(options);
      },
      deadlineAt: Date.now() + 60_000,
    });
    expect(b).not.toBeNull();
    await until(() => startIndexB >= 0, "B to take the stream over");
    // (b) the second wait is the DERIVED bound: first wait + bound, never
    // the old fixed 5 s and never less than the statement timeout.
    expect(connectedAt - detachedAt).toBeGreaterThanOrEqual(TAKEOVER + BOUND - 5);
    expect(warns).toContain("run.tail_takeover");
    expect(warns).toContain("run.tail_takeover_forced");
    // (c) the cursor was read AFTER the bound: nothing of A's had landed.
    expect(rowsAtConnect).toBe(0);
    expect(startIndexB).toBe(0);
    expect(manager.hasSessionTail("s")).toBeTrue();
    expect(manager.get("run-B")).toBe(b!);

    // The DB kills A's statement (statement_timeout): it never lands, and the
    // fence lets A issue nothing further — exactly one appendEvent was ever
    // issued for run-A.
    stall.reject(statementTimeoutError());
    await a.done;
    expect(store.events.filter((e) => e.runId === "run-A")).toHaveLength(0);
    expect(appendCallsA()).toBe(1);

    // B reads its own turn from the cursor it took over.
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    await until(() => seen.length === 1, "B's qualified cancel");
    expect(seen).toEqual([{ turnId: "turn_B" }]);
    streamB.push(turnCancelled("turn_B"));
    await until(() => !store.obligations.has("run-B"), "B cleared on its boundary");
    // ONE sequence: every row is B's, every seq once, from the cursor B read.
    expect(store.events.every((e) => e.runId === "run-B")).toBeTrue();
    expect(store.events.map((e) => e.seq)).toEqual(store.events.map((_, i) => i));
    b!.detach();
    await b!.done;
    expect(manager.activeCount).toBe(0);
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("Z1 — a seized tail's in-flight write LANDS before the bound: seize settles on idle, B proceeds at once with that write in its cursor — included, never duplicated, no forced takeover", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const streamA = liveStream();
    const { a, stall } = await observeWithStalledAppend(manager, store, streamA);
    a.detach();
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    let startIndexB = -1;
    let rowsAtConnect = -1;
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (startIndex, signal) => {
        startIndexB = startIndex;
        rowsAtConnect = store.events.length;
        return ndjsonResponse([], { stayOpen: true, signal });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    expect(b).not.toBeNull();
    await until(() => warns.includes("run.tail_takeover"), "B to seize A");
    expect(startIndexB).toBe(-1); // B is inside the second (bounded) wait
    // A's statement returns in time: it lands, A goes idle, seize settles.
    stall.resolve();
    await until(() => startIndexB >= 0, "B to proceed on A's idle");
    expect(warns).not.toContain("run.tail_takeover_forced");
    // The landed write is IN the cursor B read, and appears exactly once.
    expect(rowsAtConnect).toBe(1);
    expect(startIndexB).toBe(1);
    expect(store.events).toEqual([
      { runId: "run-A", seq: 0, event: expect.objectContaining({ type: "turn.started" }) },
    ]);
    await a.done;
    expect(store.events).toHaveLength(1); // the fence: A wrote nothing further
    b!.detach();
    await b!.done;
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  test("Z1 — the fence is BETWEEN statements: a seized tail whose attribution write returns LATE (after B took over) issues no further statement — the landed turn id is honored by B, the event it was about to persist is never written by A", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    // A's attribution write (`setRunTurnId run-A`) stalls until the test lets
    // it through — LATE, after B has taken the stream over.
    const stall = deferred<void>();
    let stalled = false;
    let appendCallsA = 0;
    const setRunTurnId = store.setRunTurnId;
    store.setRunTurnId = async (runId, turnId) => {
      if (runId === "run-A" && !stalled) {
        stalled = true;
        await stall.promise;
      }
      return setRunTurnId(runId, turnId);
    };
    const appendEvent = store.appendEvent;
    store.appendEvent = async (runId, seq, event) => {
      if (runId === "run-A") appendCallsA += 1;
      return appendEvent(runId, seq, event);
    };
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const streamA = liveStream();
    const a = await manager.observe({
      runId: "run-A",
      agentSessionId: "s",
      openStream: streamA.open,
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    streamA.push(turnStarted("turn_a"));
    streamA.push(messageReceived("turn_a", "a")); // A's own obligation's content
    await until(() => stalled, "A to stall inside setRunTurnId");
    a!.detach();

    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    const streamB = liveStream();
    let startIndexB = -1;
    const seen: Array<{ turnId?: string } | undefined> = [];
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (startIndex, signal) => {
        startIndexB = startIndex;
        return streamB.open(startIndex, signal);
      },
      cancelRemoteTurn: async (options?: { turnId?: string }) => {
        seen.push(options);
      },
      deadlineAt: Date.now() + 60_000,
    });
    await until(() => startIndexB >= 0, "B to take over after the forced bound");
    expect(warns).toContain("run.tail_takeover_forced");
    expect(startIndexB).toBe(0);
    expect(store.turnIds.has("run-A")).toBeFalse(); // still in flight

    // A's statement returns LATE: it lands (the one outstanding statement),
    // and the very next store call — persisting the held turn.started — is
    // refused by the fence: never issued.
    stall.resolve();
    await a!.done;
    expect(store.turnIds.get("run-A")).toBe("turn_a");
    expect(appendCallsA).toBe(0);
    expect(store.events.filter((e) => e.runId === "run-A")).toHaveLength(0);
    expect(seen).toEqual([]); // a closed tail issues no cancel either

    // B honors the landed proof: on its next turn opening it re-reads the
    // obligations, learns run-A's turn id and sends THE qualified cancel.
    streamB.push(turnStarted("turn_B"));
    streamB.push(messageReceived("turn_B", "b"));
    await until(() => seen.length === 2, "B's qualified cancels for A's turn and its own");
    expect(seen).toEqual(expect.arrayContaining([{ turnId: "turn_a" }, { turnId: "turn_B" }]));
    expect(store.events.every((e) => e.runId === "run-B")).toBeTrue();
    expect(new Set(store.events.map((e) => e.seq)).size).toBe(store.events.length);
    b!.detach();
    await b!.done;
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
  });

  /** An observer whose FIRST connect drops and whose reconnect hangs, ignoring its abort. */
  async function observeHung(manager: RunTailerManager, runId: string) {
    let connects = 0;
    const hang = deferred<Response>();
    let hanging = false;
    const handle = await manager.observe({
      runId,
      agentSessionId: "s",
      openStream: async () => {
        connects += 1;
        if (connects === 1) return ndjsonResponse([]);
        hanging = true;
        return hang.promise;
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    expect(handle).not.toBeNull();
    await until(() => hanging, `${runId}'s reconnect to hang`);
    return { handle: handle!, hang };
  }

  test("Z2 — a seized drain whose `done` NEVER resolves is evicted after the derived bound: the session is no longer stream-held, the dead handle leaves the manager, and shutdown does not wait on it", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const { handle: a, hang } = await observeHung(manager, "run-A");
    a.detach();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    store.sent("run-B", "b");
    store.obligations.set("run-B", {
      pendingAt: new Date(),
      unresolvedAt: null,
      createdAt: new Date(Date.now() + 1),
    });
    let connectsB = 0;
    const b = await manager.observe({
      runId: "run-B",
      agentSessionId: "s",
      openStream: async (_startIndex, signal) => {
        connectsB += 1;
        return ndjsonResponse([], { stayOpen: true, signal });
      },
      cancelRemoteTurn: async () => {},
      deadlineAt: Date.now() + 60_000,
    });
    await until(() => connectsB === 1, "B to seize A and take over");
    b!.detach();
    await b!.done; // B released; A is the seized drain that never resolves
    expect(await settled(a.done)).toBeFalse();
    // Pre-fix: held forever — the context controls answered session_busy
    // until restart, and `stopAll` awaited a `done` that never came.
    await until(() => !manager.isSessionStreamHeld("s"), "A evicted after the bound");
    expect(warns).toContain("run.tail_drain_evicted");
    expect(manager.drainingTailCount("s")).toBe(0);
    expect(manager.get("run-A")).toBeUndefined();
    expect(manager.activeCount).toBe(0);
    expect(await settled(a.done)).toBeFalse(); // evicted WITHOUT its done
    await manager.stopAll(); // bounded: nothing left to await
    // A's connect finally answers with events: fenced, nothing is written.
    hang.resolve(
      ndjsonResponse([turnStarted("t"), messageReceived("t", "a"), turnCancelled("t"), sessionWaiting()]),
    );
    await a.done;
    expect(store.events).toHaveLength(0);
  });

  test("Z2 — with NO successor the manager seizes a hung drain itself after streamTakeoverMs and evicts it after the bound: a session never stays stream-held on a drain nobody chained behind", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    store.sent("run-A", "a");
    store.obligations.set("run-A", { pendingAt: new Date(), unresolvedAt: null });
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const { handle: a, hang } = await observeHung(manager, "run-A");
    a.detach();
    const detachedAt = Date.now();
    expect(manager.isSessionStreamHeld("s")).toBeTrue();
    await until(() => warns.includes("run.tail_drain_seized"), "the manager to seize the drain");
    expect(Date.now() - detachedAt).toBeGreaterThanOrEqual(TAKEOVER - 5);
    expect(manager.isSessionStreamHeld("s")).toBeTrue(); // seized, not yet evicted
    await until(() => !manager.isSessionStreamHeld("s"), "the drain evicted after the bound");
    expect(Date.now() - detachedAt).toBeGreaterThanOrEqual(TAKEOVER + BOUND - 5);
    expect(warns).toContain("run.tail_drain_evicted");
    expect(manager.get("run-A")).toBeUndefined();
    hang.resolve(ndjsonResponse([turnStarted("t"), messageReceived("t", "a")]));
    await a.done;
    expect(store.events).toHaveLength(0);
  });

  test("Z2 — repeated hung drains never grow the list: each successor's seizure starts its predecessor's eviction clock, and the list drains back to empty", async () => {
    const { logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: TAKEOVER,
      statementTimeoutMs: STATEMENT_TIMEOUT,
      seizedWriteMarginMs: MARGIN,
      logger,
    });
    const hung: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i += 1) {
      const runId = `run-${i}`;
      store.sent(runId, `m${i}`);
      store.obligations.set(runId, {
        pendingAt: new Date(),
        unresolvedAt: null,
        createdAt: new Date(Date.now() + i),
      });
      const { handle } = await observeHung(manager, runId);
      handle.detach();
      hung.push(handle.done);
      // Bounded by the clock, not by how many were opened: a drain lives in
      // the list at most TAKEOVER + BOUND (70 ms) and each iteration spends
      // at least TAKEOVER (30 ms) chained behind the last one, so at most
      // ceil(70 / 30) + 1 = 4 can overlap — never the 5 opened so far.
      expect(manager.drainingTailCount("s")).toBeLessThanOrEqual(
        Math.ceil((TAKEOVER + BOUND) / TAKEOVER) + 1,
      );
    }
    await until(() => manager.drainingTailCount("s") === 0, "every hung drain evicted");
    expect(manager.isSessionStreamHeld("s")).toBeFalse();
    expect(manager.activeCount).toBe(0);
    for (const done of hung) expect(await settled(done)).toBeFalse();
  });

  test("Z2 — the cap backstops the list: beyond MAX_DRAINING_TAILS_PER_SESSION hung drains inside one bound window, the OLDEST is evicted at once", async () => {
    const { warns, logger } = captureWarns();
    const store = memoryStore();
    store.runStatus = "canceled";
    const manager = new RunTailerManager({
      store,
      bus: new RunEventBus(),
      maxWallClockMs: 60_000,
      reconnectDelayMs: 1,
      streamTakeoverMs: 5,
      statementTimeoutMs: 60_000, // the clock will NOT fire within this test
      logger,
    });
    const total = MAX_DRAINING_TAILS_PER_SESSION + 2;
    for (let i = 0; i < total; i += 1) {
      const runId = `run-${i}`;
      store.sent(runId, `m${i}`);
      store.obligations.set(runId, {
        pendingAt: new Date(),
        unresolvedAt: null,
        createdAt: new Date(Date.now() + i),
      });
      const { handle } = await observeHung(manager, runId);
      handle.detach();
      expect(manager.drainingTailCount("s")).toBeLessThanOrEqual(MAX_DRAINING_TAILS_PER_SESSION);
    }
    expect(manager.drainingTailCount("s")).toBe(MAX_DRAINING_TAILS_PER_SESSION);
    expect(warns.filter((w) => w === "run.tail_drain_evicted")).toHaveLength(2);
    expect(manager.get("run-0")).toBeUndefined(); // the oldest went first
    expect(manager.get("run-1")).toBeUndefined();
    expect(manager.get(`run-${total - 1}`)).toBeDefined();
  });
});

describe("RunTailerManager", () => {
  test("deduplicates tails per run and drops them when done", async () => {
    const store = memoryStore();
    store.sent("run-1", PONG);
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
