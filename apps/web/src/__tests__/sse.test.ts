/**
 * lib/sse.ts against a REAL Bun SSE fixture server (no mocks): frame
 * delivery, terminal close without reconnect, Last-Event-ID resume after a
 * dropped connection, fatal 4xx, and clean teardown.
 */
import { afterAll, expect, test } from "bun:test";

import { streamRun, type RunStreamState } from "../lib/sse";
import type { RunEventFrame, RunStatusFrame } from "@invisible-string/shared";

// ── fixture server ───────────────────────────────────────────────────────────

interface SeenRequest {
  lastEventId: string | null;
}

let handler: (req: Request, seen: SeenRequest[]) => Response = () =>
  new Response("not configured", { status: 500 });
let seenRequests: SeenRequest[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    seenRequests.push({ lastEventId: req.headers.get("last-event-id") });
    return handler(req, seenRequests);
  },
});

afterAll(() => {
  server.stop(true);
});

const baseUrl = `http://localhost:${server.port}`;

function eventFrame(seq: number): string {
  const frame = {
    runId: "run_1",
    seq,
    event: { type: "turn.started", data: { sequence: seq, turnId: `t${seq}` } },
    at: "2026-07-03T00:00:00.000Z",
  };
  return `event: run_event\nid: ${seq}\ndata: ${JSON.stringify(frame)}\n\n`;
}

function statusFrame(status: string): string {
  return `event: run_status\ndata: ${JSON.stringify({ runId: "run_1", status })}\n\n`;
}

function sseResponse(
  write: (send: (text: string) => void, close: () => void) => void,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by the peer
        }
      };
      write(send, close);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("waitUntil timed out"));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

interface Collected {
  events: RunEventFrame[];
  statuses: RunStatusFrame[];
  states: RunStreamState[];
  errors: number[];
}

function collect(): Collected & {
  handlers: {
    onRunEvent: (frame: RunEventFrame) => void;
    onRunStatus: (frame: RunStatusFrame) => void;
    onStateChange: (state: RunStreamState) => void;
    onError: (error: { status: number }) => void;
  };
} {
  const events: RunEventFrame[] = [];
  const statuses: RunStatusFrame[] = [];
  const states: RunStreamState[] = [];
  const errors: number[] = [];
  return {
    events,
    statuses,
    states,
    errors,
    handlers: {
      onRunEvent: (frame) => events.push(frame),
      onRunStatus: (frame) => statuses.push(frame),
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error.status),
    },
  };
}

const fastRetry = { initialRetryDelayMs: 10, maxRetryDelayMs: 40 } as const;

// ── tests ────────────────────────────────────────────────────────────────────

test("delivers typed frames and closes for good on a terminal status", async () => {
  seenRequests = [];
  handler = () =>
    sseResponse((send, close) => {
      send("retry: 15\n\n"); // mirrors the real server's retry hint
      send(eventFrame(0));
      send(eventFrame(1));
      send(statusFrame("succeeded"));
      close();
    });

  const collected = collect();
  const handle = streamRun("run_1", collected.handlers, {
    baseUrl,
    ...fastRetry,
  });

  await waitUntil(() => collected.states.includes("closed"));
  expect(collected.events.map((frame) => frame.seq)).toEqual([0, 1]);
  expect(collected.events[0]!.event.type).toBe("turn.started");
  expect(collected.statuses.map((frame) => frame.status)).toEqual(["succeeded"]);
  expect(handle.lastEventId).toBe(1);
  expect(handle.state).toBe("closed");

  // Terminal close must NOT reconnect.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(seenRequests.length).toBe(1);
});

test("resumes with Last-Event-ID after the connection drops mid-run", async () => {
  seenRequests = [];
  handler = (_req, seen) => {
    if (seen.length === 1) {
      // First connection: two events, then an abnormal drop (no terminal).
      return sseResponse((send, close) => {
        send(eventFrame(0));
        send(eventFrame(1));
        close();
      });
    }
    // Reconnect: replay continues past the client's cursor.
    return sseResponse((send, close) => {
      send(eventFrame(2));
      send(statusFrame("waiting"));
      close();
    });
  };

  const collected = collect();
  streamRun("run_1", collected.handlers, { baseUrl, ...fastRetry });

  await waitUntil(() => collected.states.includes("closed"));
  expect(collected.events.map((frame) => frame.seq)).toEqual([0, 1, 2]);
  expect(collected.statuses.map((frame) => frame.status)).toEqual(["waiting"]);
  expect(collected.states).toContain("reconnecting");
  expect(seenRequests.length).toBe(2);
  expect(seenRequests[0]!.lastEventId).toBeNull();
  expect(seenRequests[1]!.lastEventId).toBe("1");
});

test("a 4xx response is fatal: onError fires once and nothing retries", async () => {
  seenRequests = [];
  handler = () =>
    new Response(
      JSON.stringify({ error: { code: "run_not_found", message: "nope" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    );

  const collected = collect();
  streamRun("run_missing", collected.handlers, { baseUrl, ...fastRetry });

  await waitUntil(() => collected.states.includes("closed"));
  expect(collected.errors).toEqual([404]);

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(seenRequests.length).toBe(1);
});

test("close() tears down: no further frames, no reconnect", async () => {
  seenRequests = [];
  let interval: ReturnType<typeof setInterval> | null = null;
  handler = () =>
    sseResponse((send) => {
      send(eventFrame(0));
      let seq = 1;
      interval = setInterval(() => {
        send(eventFrame(seq));
        seq += 1;
      }, 10);
    });

  const collected = collect();
  const handle = streamRun("run_1", collected.handlers, {
    baseUrl,
    ...fastRetry,
  });

  await waitUntil(() => collected.events.length >= 1);
  handle.close();
  expect(handle.state).toBe("closed");

  const deliveredAtClose = collected.events.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (interval !== null) clearInterval(interval);

  // Allow at most one in-flight frame around the abort; then silence.
  expect(collected.events.length).toBeLessThanOrEqual(deliveredAtClose + 1);
  expect(seenRequests.length).toBe(1);
  expect(collected.states[collected.states.length - 1]).toBe("closed");
});
