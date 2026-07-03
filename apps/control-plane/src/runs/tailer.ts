/**
 * NDJSON event tailer (docs/PLAN.md Phase 1 task 5) — one tail per active
 * run:
 *
 *   GET <worker>/agents/<hash>/eve/v1/session/<id>/stream?startIndex=<n>
 *
 * parses NDJSON lines → appends `run_events` (per-run monotonic `seq`) →
 * publishes frames on the in-process bus for SSE followers → marks the run's
 * status from terminal events → stops cleanly.
 *
 * RESUME: `startIndex` is eve's count of session events already consumed;
 * ours is exactly the number of run_events persisted across the session's
 * runs, so a reconnect (or a follow-up run) resumes without replays or gaps.
 *
 * TERMINAL MAPPING (REPORT finding 14: parks close the turn —
 * `turn.completed` then `session.waiting`; resumes run as a new turn):
 * - turn.failed / session.failed → run failed (session → error on
 *   session.failed)
 * - session.waiting + a pending input.requested in THIS run → run waiting
 *   (parked approval; session → waiting)
 * - session.waiting otherwise → run succeeded (chat sessions always park on
 *   next-user-message after a completed turn)
 * - session.completed → run succeeded, session closed (task-mode)
 * - LEFTOVER events of a previous, early-stopped turn (drained by a fresh
 *   run's first connect) are persisted but never classified as terminals —
 *   see the `sawOwnTurn` gate in the consume loop.
 *
 * WALL-CLOCK CAP (task 6): MAX_RUN_WALL_CLOCK_MS starts when tailing starts;
 * expiry marks the run failed and aborts the tail. Best-effort abort: eve
 * 0.19.0 exposes no documented session-cancel HTTP route, so there is
 * nothing remote to call — the run keeps its failed status platform-side and
 * eve's own turn eventually parks or fails; real enforcement moves into the
 * eve limits config the compiler emits (deferred per plan; MAX-turns ditto).
 */
import type {
  AgentSessionStatus,
  EveStreamEvent,
  RunStatus,
} from "@invisible-string/shared";

import type { RunEventBus } from "./bus";
import type { RunStore } from "./store";

// ── NDJSON parsing ──────────────────────────────────────────────────────────

/**
 * Parse an NDJSON byte stream into events. Malformed lines are skipped
 * (defensive — the eve contract is one JSON object per line); a trailing
 * unterminated line is flushed at stream end.
 */
export async function* ndjsonEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EveStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    const event = parseLine(tail);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): EveStreamEvent | null {
  if (line.length === 0) return null;
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    if (typeof parsed.type !== "string") return null;
    return parsed as EveStreamEvent;
  } catch {
    return null;
  }
}

// ── Terminal classification (pure) ──────────────────────────────────────────

export interface TerminalDecision {
  runStatus: Extract<RunStatus, "succeeded" | "failed" | "waiting">;
  sessionStatus: AgentSessionStatus;
  error?: string;
}

/**
 * Is `event` a tail-stopping boundary for the current run, and what does it
 * mean? `pendingInputRequest` = an input.requested was seen in THIS run
 * without a subsequent action.result resolving it.
 */
export function classifyTerminal(
  event: EveStreamEvent,
  pendingInputRequest: boolean,
): TerminalDecision | null {
  switch (event.type) {
    case "turn.failed":
      return {
        runStatus: "failed",
        sessionStatus: "active",
        error: `${event.data.code}: ${event.data.message}`,
      };
    case "session.failed":
      return {
        runStatus: "failed",
        sessionStatus: "error",
        error: `${event.data.code}: ${event.data.message}`,
      };
    case "session.completed":
      return { runStatus: "succeeded", sessionStatus: "closed" };
    case "session.waiting":
      return pendingInputRequest
        ? { runStatus: "waiting", sessionStatus: "waiting" }
        : { runStatus: "succeeded", sessionStatus: "active" };
    default:
      return null;
  }
}

/** Track whether an approval/input request is still unanswered in this run. */
export function nextPendingInputRequest(
  current: boolean,
  event: EveStreamEvent,
): boolean {
  if (event.type === "input.requested") return true;
  if (event.type === "action.result") return false;
  return current;
}

// ── The tailer ──────────────────────────────────────────────────────────────

export type OpenRunStream = (
  startIndex: number,
  signal: AbortSignal,
) => Promise<Response>;

export interface TailRunOptions {
  runId: string;
  agentSessionId: string;
  openStream: OpenRunStream;
  store: RunStore;
  bus: RunEventBus;
  /** Per-run wall-clock cap in ms (MAX_RUN_WALL_CLOCK_MS). */
  maxWallClockMs: number;
  /** Reconnect attempts after unexpected drops (default 5). */
  maxReconnectAttempts?: number;
  /** Base reconnect backoff in ms (default 500; ×2 per attempt). */
  reconnectDelayMs?: number;
}

export interface CancelOptions {
  /**
   * Terminal status to mark the run with when the tail stops. Default
   * `failed` (wall-clock expiry / shutdown interruption); the run-cancel API
   * passes `canceled` so a user abort is recorded as a clean cancellation,
   * not a failure.
   */
  status?: "failed" | "canceled";
}

export interface RunTailHandle {
  runId: string;
  /** Resolves when the tail has fully stopped (terminal, canceled, or dead). */
  done: Promise<void>;
  /** Stop tailing and mark the run (`canceled` UI action or shutdown). */
  cancel(reason?: string, options?: CancelOptions): void;
  /**
   * Stop tailing WITHOUT marking the run terminal — used by the dead-worker
   * sweeper to detach a stale tail (its worker died) so the run can be
   * re-tailed against a freshly scheduled worker. The run keeps its current
   * DB status (e.g. `running`); the durable eve turn continues and the new
   * tail resumes from the persisted seq.
   */
  detach(): void;
}

export function tailRun(options: TailRunOptions): RunTailHandle {
  const {
    runId,
    agentSessionId,
    openStream,
    store,
    bus,
    maxWallClockMs,
    maxReconnectAttempts = 5,
    reconnectDelayMs = 500,
  } = options;

  const abort = new AbortController();
  let cancelReason: string | null = null;
  // An ABORT-driven stop marks the run "failed" (wall-clock expiry / shutdown)
  // unless a user cancel flipped this flag, which marks it "canceled".
  let canceledByUser = false;
  let finished = false;
  // Detach (dead-worker failover) aborts the loop but leaves the run's status
  // untouched so a re-tail on another worker can pick it up.
  let detaching = false;

  const publishStatus = (status: RunStatus, error?: string | null) => {
    bus.publish(runId, {
      kind: "status",
      frame: { runId, status, ...(error !== undefined ? { error } : {}) },
    });
  };

  const finishRun = async (
    status: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">,
    sessionStatus: AgentSessionStatus | null,
    error?: string,
  ) => {
    if (finished) return;
    finished = true;
    await store.markRun(runId, {
      status,
      error: error ?? null,
      ...(status === "waiting" ? {} : { completedAt: new Date() }),
    });
    if (sessionStatus) await store.markSession(agentSessionId, sessionStatus);
    publishStatus(status, error ?? null);
  };

  const wallClockTimer = setTimeout(() => {
    cancelReason ??= `run exceeded the wall-clock cap (${maxWallClockMs}ms)`;
    abort.abort();
  }, maxWallClockMs);

  const done = (async () => {
    // Resume points derived from what is already persisted (crash-safe).
    let seq = await store.countRunEvents(runId);
    let startIndex = await store.countSessionEvents(agentSessionId);
    let pendingInput = false;
    // TERMINAL GATE: a FRESH run's tail may first drain leftover events of
    // the session's PREVIOUS turn (early-stopped tail: wall-clock abort,
    // cancel, reconnect exhaustion, crash — eve durably finishes the turn
    // anyway and startIndex therefore undercounts). Those leftovers include
    // the old turn's `turn.completed`/`session.waiting`, which must be
    // persisted (keeping counts aligned) but NOT classified as THIS run's
    // terminal — otherwise the new run is instantly marked succeeded before
    // its own turn emits anything. Terminals only count once this run's own
    // turn boundary (`turn.started`) has been seen; a resuming tail
    // (seq > 0) already consumed its own turn.started. `session.failed` is
    // session-fatal and always classified.
    let sawOwnTurn = seq > 0;

    await store.markRun(runId, {
      status: "running",
      ...(seq === 0 ? { startedAt: new Date() } : {}),
    });
    publishStatus("running");

    let attempt = 0;
    try {
      for (;;) {
        let consumedThisConnect = 0;
        try {
          const response = await openStream(startIndex, abort.signal);
          if (!response.ok || response.body === null) {
            throw new Error(`stream returned ${response.status}`);
          }
          for await (const event of ndjsonEvents(response.body)) {
            // Persist FIRST, count after: if appendEvent throws (transient
            // Postgres error), the reconnect resumes from the same
            // startIndex and re-consumes this event instead of silently
            // skipping it forever.
            const stored = await store.appendEvent(runId, seq, event);
            consumedThisConnect += 1;
            startIndex += 1;
            bus.publish(runId, {
              kind: "event",
              frame: { runId, seq, event, at: stored.at },
            });
            seq += 1;

            if (event.type === "turn.started") {
              // This run's own turn boundary: leftover pending-input state
              // from a drained previous turn is historical, not ours.
              sawOwnTurn = true;
              pendingInput = false;
            }
            pendingInput = nextPendingInputRequest(pendingInput, event);

            const terminal =
              sawOwnTurn || event.type === "session.failed"
                ? classifyTerminal(event, pendingInput)
                : null;
            if (terminal) {
              await finishRun(
                terminal.runStatus,
                terminal.sessionStatus,
                terminal.error,
              );
              return;
            }
          }
          // Stream ended without a terminal event → treat like a drop.
          throw new Error("stream ended before a terminal event");
        } catch (error) {
          if (detaching) return; // failover: leave the run for a re-tail
          if (abort.signal.aborted) {
            await finishRun(
              canceledByUser ? "canceled" : "failed",
              canceledByUser ? "active" : null,
              cancelReason ?? "run tail aborted",
            );
            return;
          }
          attempt = consumedThisConnect > 0 ? 1 : attempt + 1;
          if (attempt > maxReconnectAttempts) {
            await finishRun(
              "failed",
              null,
              `event stream lost after ${maxReconnectAttempts} reconnect attempts: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
          await sleepAbortable(
            reconnectDelayMs * 2 ** (attempt - 1),
            abort.signal,
          );
          if (detaching) return; // failover during backoff
          if (abort.signal.aborted) {
            await finishRun(
              canceledByUser ? "canceled" : "failed",
              canceledByUser ? "active" : null,
              cancelReason ?? "run tail aborted",
            );
            return;
          }
        }
      }
    } finally {
      clearTimeout(wallClockTimer);
    }
  })();

  return {
    runId,
    done,
    cancel(reason, options) {
      cancelReason ??= reason ?? "run canceled";
      if (options?.status === "canceled") canceledByUser = true;
      abort.abort();
    },
    detach() {
      detaching = true;
      abort.abort();
    },
  };
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Manager: one tail per active run + graceful shutdown ───────────────────

export class RunTailerManager {
  private readonly handles = new Map<string, RunTailHandle>();

  constructor(
    private readonly defaults: {
      store: RunStore;
      bus: RunEventBus;
      maxWallClockMs: number;
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
    },
  ) {}

  start(options: {
    runId: string;
    agentSessionId: string;
    openStream: OpenRunStream;
  }): RunTailHandle {
    const existing = this.handles.get(options.runId);
    if (existing) return existing;
    const handle = tailRun({ ...this.defaults, ...options });
    this.handles.set(options.runId, handle);
    void handle.done.finally(() => {
      this.handles.delete(options.runId);
    });
    return handle;
  }

  get(runId: string): RunTailHandle | undefined {
    return this.handles.get(runId);
  }

  /**
   * Detach a tail (dead-worker failover) WITHOUT marking its run terminal, and
   * wait for it to fully stop so the caller can start a fresh tail for the same
   * run without the manager returning the stale handle. No-op when absent.
   */
  async detach(runId: string): Promise<void> {
    const handle = this.handles.get(runId);
    if (!handle) return;
    handle.detach();
    await handle.done; // `done.finally` removes it from the map
  }

  /**
   * Cancel a specific run's live tail (user abort), marking it `canceled` and
   * awaiting a clean stop. Returns true when a live tail was cancelled; false
   * when the run had no active tail (parked/queued/terminal — the caller marks
   * the row directly). Best-effort re: eve's turn: eve exposes no session-
   * cancel HTTP route (see the module header), so the platform stops streaming
   * and records the cancellation; eve's own turn parks/caps out server-side.
   */
  async cancelRun(runId: string, reason?: string): Promise<boolean> {
    const handle = this.handles.get(runId);
    if (!handle) return false;
    handle.cancel(reason, { status: "canceled" });
    await handle.done;
    return true;
  }

  /** Number of live tails (observability/tests). */
  get activeCount(): number {
    return this.handles.size;
  }

  async stopAll(reason = "control plane shutting down"): Promise<void> {
    const all = [...this.handles.values()];
    for (const handle of all) handle.cancel(reason);
    await Promise.allSettled(all.map((handle) => handle.done));
  }
}
