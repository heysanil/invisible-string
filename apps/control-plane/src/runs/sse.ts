/**
 * Resumable SSE for `GET /runs/:id/stream` (contract in
 * packages/shared/src/api.ts):
 *
 *   event: run_event   id: <seq>   data: RunEventFrame
 *   event: run_status               data: RunStatusFrame
 *
 * REPLAY-THEN-FOLLOW: subscribe to the live bus FIRST (buffering), replay
 * persisted run_events with seq > Last-Event-ID, then flush the buffer
 * deduped by seq — no gap, no double-send. Heartbeat comments keep proxies
 * from idling the connection. The stream closes after a stream-terminal
 * status (succeeded/failed/canceled/waiting — a parked run emits nothing
 * further until Phase-3 input handling resumes it as a new tail).
 */
import type { RunStatus, RunStatusFrame } from "@invisible-string/shared";

import type { RunEventBus } from "./bus";
import type { RunStore } from "./store";

/** No further frames will arrive for a run in this status (Phase 1). */
export function isStreamTerminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

/** Parse the `Last-Event-ID` header (or ?lastEventId=) into a seq cursor. */
export function parseLastEventId(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface RunSseOptions {
  runId: string;
  store: RunStore;
  bus: RunEventBus;
  lastEventId: number | null;
  heartbeatMs: number;
}

export function createRunSseResponse(options: RunSseOptions): Response {
  const { runId, store, bus, lastEventId, heartbeatMs } = options;
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const close = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {
          // already errored/closed
        }
      };
      const cleanup = () => {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
      };

      const sendEventFrame = (frame: {
        runId: string;
        seq: number;
        event: unknown;
        at: string;
      }) => {
        send(`event: run_event\nid: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`);
      };
      const sendStatusFrame = (frame: RunStatusFrame) => {
        send(`event: run_status\ndata: ${JSON.stringify(frame)}\n\n`);
        if (isStreamTerminalStatus(frame.status)) close();
      };

      // 1. Subscribe first — live frames land in the buffer during replay.
      let replaying = true;
      let lastSentSeq = lastEventId ?? -1;
      const buffered: Array<Parameters<typeof bus.publish>[1]> = [];
      unsubscribe = bus.subscribe(runId, (frame) => {
        if (replaying) {
          buffered.push(frame);
          return;
        }
        if (frame.kind === "event") {
          if (frame.frame.seq <= lastSentSeq) return;
          lastSentSeq = frame.frame.seq;
          sendEventFrame(frame.frame);
        } else {
          sendStatusFrame(frame.frame);
        }
      });

      send(`retry: 3000\n\n`);

      // 2. Replay persisted events after the client's cursor.
      const replayed = await store.listEventsAfter(runId, lastSentSeq);
      for (const record of replayed) {
        lastSentSeq = record.seq;
        sendEventFrame({ runId, seq: record.seq, event: record.event, at: record.at });
      }

      // 3. Flush frames buffered during replay (dedupe by seq).
      replaying = false;
      let sawTerminalStatus = false;
      for (const frame of buffered) {
        if (frame.kind === "event") {
          if (frame.frame.seq <= lastSentSeq) continue;
          lastSentSeq = frame.frame.seq;
          sendEventFrame(frame.frame);
        } else {
          sawTerminalStatus ||= isStreamTerminalStatus(frame.frame.status);
          sendStatusFrame(frame.frame);
        }
      }
      buffered.length = 0;

      // 4. If the run is already parked/finished, emit closure and stop —
      //    otherwise stay subscribed (live-follow).
      if (!closed && !sawTerminalStatus) {
        const status = await store.getRunStatus(runId);
        if (status !== null && isStreamTerminalStatus(status)) {
          sendStatusFrame({ runId, status });
        }
      }

      if (!closed) {
        heartbeat = setInterval(() => send(`: hb\n\n`), heartbeatMs);
      }
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
