/**
 * Run stream client for `GET /runs/:id/stream` (contract:
 * packages/shared/src/api.ts "GET /runs/:id/stream").
 *
 * Fetch-based rather than native EventSource, deliberately:
 * - EventSource cannot present a *chosen* Last-Event-ID on a fresh
 *   connection (only on its own auto-reconnects), so resuming a stream a
 *   component re-mounted — the common case — would replay from 0.
 * - We control backoff, teardown, and typed frame parsing.
 *
 * Behavior:
 * - Frames are dispatched as typed {@link RunEventFrame} / {@link RunStatusFrame}.
 * - The `id:` field tracks the resume cursor; reconnects send it as the
 *   `Last-Event-ID` header (the server replays only seq > cursor).
 * - Reconnect on network drop / abnormal end with exponential backoff +
 *   jitter (server `retry:` hint honored as the base delay), reset after a
 *   healthy connection.
 * - The stream ends FOR GOOD when a stream-terminal run_status arrives
 *   (succeeded/failed/canceled/waiting — see isRunStreamTerminalStatus; a
 *   parked run resumes via POST /runs/:id/input, after which callers open a
 *   NEW stream that resumes seamlessly from the cursor).
 * - 4xx responses are fatal (auth/ownership/404) — surfaced via onError, no
 *   retry hammering.
 * - `close()` tears everything down (in-flight fetch aborted, timers cleared);
 *   afterwards no handler is ever called again.
 */
import {
  isRunStreamTerminalStatus,
  runStatusSchema,
  type EveStreamEvent,
  type RunEventFrame,
  type RunStatusFrame,
} from "@invisible-string/shared";
import { z } from "zod";

import { API_BASE_URL, ApiError } from "./api-client";

export type RunStreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface RunStreamHandlers {
  onRunEvent?: (frame: RunEventFrame) => void;
  onRunStatus?: (frame: RunStatusFrame) => void;
  onStateChange?: (state: RunStreamState) => void;
  /** Fatal errors only (4xx). Retryable failures surface as "reconnecting". */
  onError?: (error: ApiError) => void;
}

export interface RunStreamOptions {
  /** Resume cursor (run_events.seq) to start after; omit to replay from 0. */
  lastEventId?: number;
  baseUrl?: string;
  /** Base reconnect delay; doubles per attempt (default 500ms). */
  initialRetryDelayMs?: number;
  /** Backoff ceiling (default 10s). */
  maxRetryDelayMs?: number;
  /** Test seam; defaults to the ambient fetch at call time. */
  fetchFn?: typeof fetch;
}

export interface RunStreamHandle {
  close(): void;
  readonly state: RunStreamState;
  /** Latest seen `id:` (resume cursor); null before the first framed event. */
  readonly lastEventId: number | null;
}

// Wire guards: cheap structural checks; `event` keeps its frozen TS type.
const runEventFrameSchema = z.object({
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: z.looseObject({ type: z.string().min(1) }),
  at: z.string().min(1),
});

const runStatusFrameSchema = z.object({
  runId: z.string().min(1),
  status: runStatusSchema,
  error: z.string().nullable().optional(),
});

interface SseMessage {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

/**
 * Incremental SSE parser (whatwg spec subset: event/data/id/retry fields,
 * `:` comments, multi-line data, \r\n|\n|\r line endings).
 */
class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private id: string | null = null;
  private retry: number | null = null;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let match: RegExpMatchArray | null;
    // Consume complete lines only; a trailing partial stays buffered.
    while ((match = this.buffer.match(/^(.*?)(\r\n|\n|\r)/)) !== null) {
      this.buffer = this.buffer.slice(match[0].length);
      const line = match[1] ?? "";
      const message = this.processLine(line);
      if (message !== null) messages.push(message);
    }
    return messages;
  }

  private processLine(line: string): SseMessage | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // heartbeat comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) this.retry = parsed;
        break;
      }
      default:
        break; // unknown fields are ignored per spec
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    const message: SseMessage = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
      id: this.id,
      retry: this.retry,
    };
    this.eventName = "";
    this.dataLines = [];
    this.id = null;
    this.retry = null;
    // Blank line with no data/event is a no-op keepalive boundary.
    if (message.data === "" && message.event === "" && message.id === null) {
      return message.retry === null ? null : message;
    }
    return message;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

// TEMP DIAG (CI-runner-only test failure) — remove before merge.
console.log("DIAG sse.ts module evaluated");

/** Subscribe to a run's SSE stream. Returns a handle owning the connection. */
export function streamRun(
  runId: string,
  handlers: RunStreamHandlers,
  options: RunStreamOptions = {},
): RunStreamHandle {
  console.log("DIAG real streamRun called for run:", runId);
  const abort = new AbortController();
  const initialDelay = options.initialRetryDelayMs ?? 500;
  const maxDelay = options.maxRetryDelayMs ?? 10_000;

  let state: RunStreamState = "connecting";
  let lastEventId: number | null = options.lastEventId ?? null;
  let retryBase = initialDelay;

  const setState = (next: RunStreamState) => {
    if (state === "closed" || state === next) return;
    state = next;
    handlers.onStateChange?.(next);
  };

  const close = () => {
    if (state !== "closed") {
      state = "closed";
      handlers.onStateChange?.("closed");
    }
    abort.abort();
  };

  const fail = (error: ApiError) => {
    handlers.onError?.(error);
    close();
  };

  /** Reads one connection to its end. Returns true when terminal. */
  const consume = async (body: ReadableStream<Uint8Array>): Promise<boolean> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        const messages = parser.push(decoder.decode(value, { stream: true }));
        for (const message of messages) {
          if (message.retry !== null) retryBase = Math.max(1, message.retry);
          if (message.id !== null) {
            const seq = Number(message.id);
            if (Number.isInteger(seq) && seq >= 0) lastEventId = seq;
          }
          if (message.event === "run_event") {
            const frame = parseJson(message.data, runEventFrameSchema);
            if (frame !== null) {
              // A delivered frame proves a healthy connection — reset backoff.
              retryBase = initialDelay;
              handlers.onRunEvent?.({
                ...frame,
                event: frame.event as unknown as EveStreamEvent,
              });
            }
          } else if (message.event === "run_status") {
            const frame = parseJson(message.data, runStatusFrameSchema);
            if (frame !== null) {
              retryBase = initialDelay;
              handlers.onRunStatus?.(frame);
              if (isRunStreamTerminalStatus(frame.status)) return true;
            }
          }
          // Unknown event names are skipped (forward compatibility).
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };

  const loop = async () => {
    let attempt = 0;
    while (!abort.signal.aborted) {
      try {
        const fetchFn = options.fetchFn ?? fetch;
        const url = new URL(
          `/runs/${runId}/stream`,
          options.baseUrl ?? API_BASE_URL,
        );
        const headers: Record<string, string> = {
          accept: "text/event-stream",
        };
        if (lastEventId !== null) headers["last-event-id"] = String(lastEventId);
        const response = await fetchFn(url, {
          headers,
          credentials: "include",
          signal: abort.signal,
        });
        if (response.status >= 400 && response.status < 500) {
          fail(
            new ApiError(
              response.status,
              `http_${response.status}`,
              "The run stream was rejected — check the session still exists and you are signed in.",
            ),
          );
          return;
        }
        if (!response.ok || response.body === null) {
          throw new Error(`stream unavailable (${response.status})`);
        }
        setState("open");
        attempt = 0;
        const terminal = await consume(response.body);
        if (terminal) {
          close();
          return;
        }
        // Stream ended without a terminal status (proxy idle cut, deploy…):
        // resume from the cursor.
        throw new Error("stream ended early");
      } catch (error) {
        if (abort.signal.aborted) return;
        void error;
        setState("reconnecting");
        attempt += 1;
        const exponential = Math.min(retryBase * 2 ** (attempt - 1), maxDelay);
        const jittered = exponential * (0.5 + Math.random() * 0.5);
        await sleep(jittered, abort.signal);
      }
    }
  };

  void loop();

  return {
    close,
    get state() {
      return state;
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
