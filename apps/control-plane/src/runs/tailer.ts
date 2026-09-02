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
 * CURSOR vs DEDUPE KEY — they are different things and must stay so:
 * - `startIndex` is the CURSOR: eve's absolute count of session events already
 *   consumed. Ours is the number of run_events persisted across the session's
 *   runs. It is the only lossless resume mechanism eve offers.
 * - eve 0.31's `meta.id` (an `evt_`-prefixed ULID, stamped once before the
 *   durable write and therefore stable across reconnects, rewinds and full
 *   replays) is the DEDUPE KEY. A re-read event is recognized and skipped
 *   instead of being persisted a second time under a fresh `seq`.
 *   It is NOT a cursor: ULIDs are time-ordered but not totally ordered across
 *   steps running in different processes, so `where id > $cursor` is lossy.
 *   It also does NOT suppress durable-step RETRIES — eve re-runs a step up to
 *   four times and the retry emits NEW ids for the same logical work.
 *
 * BOUNDED CATCH-UP READ (0.27.7): the first connect of a tail asks for
 * `includeTailIndex=1` and reads `x-eve-stream-tail-index` — eve's own count
 * of durably recorded events at attach time. Two uses:
 * - DRIFT REPAIR: if our persisted count is somehow ahead of eve's tail, the
 *   cursor is clamped instead of sending a startIndex past the end (which eve
 *   answers with an immediately-closed stream, i.e. an infinite reconnect
 *   loop that ends in a spurious `failed`).
 * - An explicit, LOGGED bound on the leftover drain below, instead of an
 *   unlabeled prefix of the live read.
 * `follow: false` and `streamReconnectPolicy: {reconnect:false}` are
 * `eve/client` SDK constructs, not wire parameters — this tailer speaks raw
 * HTTP and is the single owner of reconnection, which is what those options
 * buy. Never introduce a second cursor owner on the same stream.
 *
 * TERMINAL MAPPING (REPORT finding 14: parks close the turn —
 * `turn.completed` then `session.waiting`; resumes run as a new turn):
 * - turn.failed / session.failed → run failed (session → error on
 *   session.failed)
 * - turn.cancelled → NOT terminal on its own (eve always follows it with
 *   `session.waiting`) but latches cancellation, so the following
 *   `session.waiting` lands the run `canceled`, session stays `active`.
 *   Cancellation is a USER DECISION, never an error: it must never classify
 *   as `failed`, and — the likelier bug — never as `succeeded`, which would
 *   settle the run's Slack delivery obligation and post a truncated reply.
 * - session.waiting + a pending input.requested in THIS run → run waiting
 *   (parked approval; session → waiting)
 * - session.waiting + a pending authorization.required in THIS run → run
 *   waiting too (mid-run MCP consent challenge; same Slack-truncation hazard
 *   as an unlatched approval). NOTE this latch is DORMANT on eve 0.31.3 for
 *   platform connections: a getToken-only strategy surfaces a mid-run 401 as
 *   a plain failed action.result and `authorization.required` is emitted only
 *   by interactive auth strategies the platform does not author (spike
 *   REPORT finding 34). Implemented defensively against eve's declared wire
 *   types (`authorization.*` in eve-events.ts).
 * - session.waiting otherwise → run succeeded (chat sessions always park on
 *   next-user-message after a completed turn)
 * - session.completed → run succeeded, session closed (task-mode)
 * - context.cleared → not terminal; invalidates any pending input request
 *   (0.31 declares a response stale once its context is cleared).
 * - LEFTOVER events of a previous, early-stopped turn (drained by a fresh
 *   run's first connect) are persisted but never classified as terminals —
 *   see the `sawOwnTurn` gate in the consume loop. The tail-index bound
 *   makes that drain observable but cannot replace the gate: eve may have
 *   durably recorded THIS run's own `turn.started` before we attach, so the
 *   bound alone would swallow our own turn.
 *
 * TURN ATTRIBUTION BY CONTENT, AND THE ACCEPTANCE PROOF (`runs.turn_id`).
 * eve's 202 carries no turn id, so a send cannot be correlated with its turn
 * at send time — but eve's STREAM carries an exact correlator: every content
 * turn opens with `turn.started {turnId}` immediately followed by
 * `message.received {message: <the exact text sent>, turnId}` (LIVE-OBSERVED,
 * `EveMessageReceivedEvent`; spike fixture `task-output-schema-events.ndjson`).
 * The dispatch-attempt CAS records `runs.message_hash` = sha256 of the exact
 * message sent (runs/message-hash.ts — the digest, never the text) beside
 * the marker, and the tail attributes a turn the moment its opening is
 * complete: `turn.started` is HELD (not persisted, cursor not advanced — a
 * drop re-reads it) until the next event, which either is that turn's
 * `message.received` (a CONTENT turn, correlator = the hash of its message)
 * or is not (a CONTENT-LESS turn: a HITL `inputResponses` resume opens with
 * NO `message.received` — `turn.started` straight to `step.started`, spike
 * fixture `mocked-resumed-events.ndjson` — and its sender's `message_hash`
 * is null). The claimant is then, in order:
 *
 *   1. the session's open remote-cancel obligation whose `message_hash`
 *      equals the correlator (content-less turns match null hashes) and
 *      whose turn has not started — pending obligations before UNRESOLVED
 *      ones (still attributable: a late match clears both columns on the
 *      boundary), oldest first within each (identical texts sent on one
 *      session are the documented tie: oldest wins);
 *   2. (follow mode) this tail's own run, iff ITS `message_hash` equals the
 *      correlator — a run that sent a message never claims a content-less
 *      turn, and one that sent an input response never claims a content
 *      turn;
 *   3. (content turns) a LIVE run on the session with that hash and no
 *      `turn_id` yet — a successor admitted while an observation tail was on
 *      the stream, whose own tail has not taken over: its `turn_id` is
 *      written so it reads its own turn from the column;
 *   4. otherwise the turn is FOREIGN: persisted normally, never attributed,
 *      never canceled, never classified as anyone's own.
 *
 * The claimant set is ONE store read (`RunStore.listSessionClaimants`: the
 * open obligations AND the live unattributed runs in a single statement —
 * a no-tail Stop commits a run from live to settled in one CAS, and two
 * reads around that commit saw it in neither). Adoption is RETROACTIVE:
 * an obligation loaded or adopted with a null turn id is matched against
 * the session's persisted unowned content turns
 * (`RunStore.listUnownedContentTurns` — a `message.received` on disk whose
 * id no run carries as `turn_id`, i.e. one classified foreign when it
 * opened) so it never waits for an opening that already went by: a match
 * writes the proof and issues the qualified cancel, or meets the
 * obligation on the spot when the turn's own boundary is on disk too.
 *
 * Send ORDER attributes nothing any more (content-less turns aside — among
 * content-less senders only): a never-sent obligation cannot steal a
 * successor's turn unless the two texts are identical — the residual. The
 * attributed id is written to that run's `turn_id` (`setRunTurnId`) BEFORE
 * the held `turn.started` is persisted — that column is the ONLY evidence
 * eve accepted a turn. Nothing local proves it: a `running` status is
 * synthesized when reconciliation re-tails an unsent continuation,
 * `run_events` under a run can be a predecessor's leftovers, and eve's 202
 * on a pre-turn cancel is consumed as a no-op. A resuming tail reads its own
 * turn from the column (never from `seq > 0`). eve SERIALIZES turns, so any
 * turn starting also proves every attributed obligation with another id
 * over; a turn attributed to a NEWER run (own, or a live successor) proves
 * every obligation on the session over (`classifySessionSuccessor`'s rule).
 *
 * THE CONFIRMED CANCEL (observation mode). A user Stop no longer aborts the
 * tail: the row is finalized `canceled` at once — WITH the durable
 * obligation `remote_cancel_pending_at` in the same CAS — and the tail stays
 * on eve's stream in OBSERVATION mode, owing eve's own confirmation that the
 * turn ended. If the run's turn had already started, the Stop issues a
 * turn-QUALIFIED cancel (`{turnId}`) first; if not, nothing is sent yet
 * (eve would consume it as a no-op) and the qualified cancel goes out the
 * moment the run's own turn is attributed. The obligation clears ONLY on the
 * run's own turn boundary (`turn.cancelled` / `turn.completed` carrying its
 * turn id, or the following `session.waiting` / `session.completed`), a
 * session-terminal answer from eve (`session_not_active` / `no_active_turn`
 * on the cancel, `session.failed` on the stream), or — outside this tail — a
 * NEWER run on the session whose `turn_id` is set. Observation is wall-clock
 * bounded (`REMOTE_CANCEL_OBSERVE_MS` from the obligation's timestamp): on
 * expiry the run is declared UNRESOLVED (`remote_cancel_unresolved_at`,
 * marker retained, logged at warn) — an honest, visible residual, never a
 * silent clear, and still attributable by any later tail on the session. A
 * crash ends the observation but not the obligation: the periodic
 * remote-cancel sweeper re-opens an observation tail (`observe`) from the
 * run's persisted seq for any pending run with no live tail on its session
 * — the SAME primitive, with the same attribution rules — and a successor's
 * normal tail on that session takes the obligations over through its
 * leftover drain (the manager detaches an observation tail when a normal
 * tail starts on the same session: ONE reader per eve stream, always). A
 * handoff to a live tail checks LIVENESS at the handoff: a tail leaves the
 * manager's reader slot the instant it CLOSES — `close(reason)`, the ONE
 * transition every exit path takes synchronously at its start (a Stop or
 * shutdown settlement, an observation closing or expiring, a detach, the
 * run's natural terminal, reconnect exhaustion, the wall-clock cap, a
 * seizure) — never when its `done` resolves; a signal to a closed tail
 * answers false, and the caller then opens its own observer — chained
 * behind the closed tail's still-held cursor, never a second reader. That
 * chain wait is BOUNDED (`streamTakeoverMs`): a drain that never releases
 * its cursor (a reconnect or store call that never resolves) is SEIZED
 * after the bound — closed and fenced so it consumes, attributes and writes
 * nothing more, its in-flight event handling awaited — and the successor
 * takes the cursor over from the persisted counts. An observer's deadline
 * is armed at CREATION, so it fires during the chain wait too (unresolved
 * declared, the handle released) — a hung drain can never wedge a session.
 *
 * WALL-CLOCK CAP AND SHUTDOWN owe the same confirmation. MAX_RUN_WALL_CLOCK_MS
 * starts when tailing starts; expiry settles the run `failed` — WITH the
 * obligation in the same CAS, exactly like a Stop — and the tail switches to
 * observation: a turn-QUALIFIED cancel if the turn is known, NOTHING if not
 * (an unqualified cancel is a no-op before `turn.started` and could only ever
 * hit a successor's turn if it arrived late — the tail never sends one, for
 * any cause). Shutdown settles the row the same way and aborts (the process
 * cannot observe); the next boot's sweeper re-opens the observation.
 */
import {
  EVE_STREAM_TAIL_INDEX_HEADER,
  parseEveStreamTailIndex,
  type AgentSessionStatus,
  type EveStreamEvent,
  type Logger,
  type RunStatus,
} from "@invisible-string/shared";

import type { RunEventBus } from "./bus";
import { hashTurnMessage } from "./message-hash";
import type { PendingRemoteCancel, RunStore, SessionClaimants } from "./store";

/**
 * Terminal-run notification (metrics + outbound-delivery seam): status,
 * wall-clock of the tail, and the run's final assistant reply.
 */
export type RunFinishedHook = (info: {
  runId: string;
  status: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">;
  durationMs: number;
  /**
   * Text of the last `message.completed` with `finishReason: "stop"` seen in
   * THIS run's own turn (leftover events drained from a previous turn never
   * count — same gate as terminal classification). Null when the run produced
   * no terminal reply. The DeliveryService posts this back to the trigger
   * surface (Slack) for runs owing a `delivery_status = pending` reply.
   */
  lastAssistantMessage: string | null;
}) => void;

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
  runStatus: Extract<RunStatus, "succeeded" | "failed" | "waiting" | "canceled">;
  sessionStatus: AgentSessionStatus;
  error?: string;
}

/** Latched observations that change what a boundary event MEANS. */
export interface TerminalContext {
  /**
   * An input.requested was seen in THIS run without a subsequent action.result
   * resolving it.
   */
  pendingInputRequest: boolean;
  /**
   * An `authorization.required` was seen in THIS run without a subsequent
   * `authorization.completed` resolving it (mid-run MCP consent challenge).
   * Latched exactly like {@link pendingInputRequest}: while set, a settling
   * `session.waiting` means the run is WAITING on the user's consent — never
   * succeeded, which would settle its delivery obligation with a truncated
   * reply. Dormant on eve 0.31.3 for platform connections (finding 34).
   */
  pendingAuthorization?: boolean;
  /**
   * A `turn.cancelled` was seen in THIS run. eve always follows it with
   * `session.waiting`, and that pair means CANCELED — not succeeded (the
   * default reading of a bare `session.waiting`) and not failed.
   */
  canceledTurn?: boolean;
}

/**
 * Is `event` a tail-stopping boundary for the current run, and what does it
 * mean?
 *
 * Ordering inside `session.waiting` is load-bearing: cancellation outranks a
 * pending approval, because 0.31 declares a parked input request STALE once
 * its turn is cancelled — answering it would post a dead requestId, and
 * leaving the run `waiting` would park it on an approval eve has discarded.
 */
export function classifyTerminal(
  event: EveStreamEvent,
  context: TerminalContext | boolean,
): TerminalDecision | null {
  // Back-compat with the boolean-only signature used across the tests and the
  // older call sites: a bare boolean is `pendingInputRequest`.
  const {
    pendingInputRequest,
    pendingAuthorization = false,
    canceledTurn = false,
  } = typeof context === "boolean"
    ? { pendingInputRequest: context, canceledTurn: false }
    : context;
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
      if (canceledTurn) {
        // The session is untouched by a cancel and takes the next message
        // normally — hence `active`, not `waiting`/`closed`. No `error`:
        // cancellation is a user decision, and writing one here would render
        // a red failure banner over a deliberate Stop.
        return { runStatus: "canceled", sessionStatus: "active" };
      }
      // A pending consent challenge parks the run exactly like a pending
      // approval — both mean "eve is waiting on the user, not done".
      return pendingInputRequest || pendingAuthorization
        ? { runStatus: "waiting", sessionStatus: "waiting" }
        : { runStatus: "succeeded", sessionStatus: "active" };
    default:
      // Notably NOT `turn.cancelled`: it is not a boundary in eve's own sense
      // either (`isCurrentTurnBoundaryEvent` covers only the three session.*
      // events). Treating it as terminal would finish the run and drop the
      // trailing `session.waiting`, desynchronizing the session's startIndex
      // and corrupting the NEXT run's resume point.
      return null;
  }
}

/**
 * Track whether an approval/input request is still unanswered in this run.
 *
 * `turn.cancelled` and `context.cleared` both invalidate a parked request:
 * eve declares a response stale once its turn is cancelled or its context
 * cleared, so a run left `waiting` on one would park forever on an approval
 * eve has already discarded.
 */
export function nextPendingInputRequest(
  current: boolean,
  event: EveStreamEvent,
): boolean {
  if (event.type === "input.requested") return true;
  if (
    event.type === "action.result" ||
    event.type === "turn.cancelled" ||
    event.type === "context.cleared"
  ) {
    return false;
  }
  return current;
}

/**
 * Track whether a mid-run MCP consent challenge (`authorization.required`) is
 * still unresolved in this run — the authorization latch, mirroring
 * {@link nextPendingInputRequest}.
 *
 * Cleared ONLY by `authorization.completed` or the same invalidation
 * boundaries as an input request (`turn.cancelled`, `context.cleared`).
 * Deliberately NOT cleared by `action.result`: a tool result never resolves a
 * consent challenge — eve declares that resolution with its own
 * `authorization.completed` event.
 *
 * DORMANT on eve 0.31.3 for platform connections: getToken-only strategies
 * surface a mid-run 401 as a plain failed action.result, and
 * `authorization.required` is reachable only via interactive auth strategies
 * the platform does not author (spike REPORT finding 34). The latch stays in
 * defensively — the types are on eve's wire contract, and an eve upgrade that
 * starts emitting them must park the run, not mark it succeeded.
 */
export function nextPendingAuthorization(
  current: boolean,
  event: EveStreamEvent,
): boolean {
  if (event.type === "authorization.required") return true;
  if (
    event.type === "authorization.completed" ||
    event.type === "turn.cancelled" ||
    event.type === "context.cleared"
  ) {
    return false;
  }
  return current;
}

// ── The tailer ──────────────────────────────────────────────────────────────

export interface OpenRunStreamOptions {
  /**
   * Ask eve for the `x-eve-stream-tail-index` response header. Requested on
   * the FIRST open of a tail only — re-requesting it on every reconnect
   * re-pins the bound and turns a bounded read into a moving target.
   */
  includeTailIndex?: boolean;
}

export type OpenRunStream = (
  startIndex: number,
  signal: AbortSignal,
  options?: OpenRunStreamOptions,
) => Promise<Response>;

/**
 * eve's answer to a remote cancel, as far as the tail cares: `terminal` when
 * eve declared the SESSION dead (409 `session_not_active`, or 200
 * `no_active_turn` — eve's one dead-session rendering, REPORT finding 24) —
 * nothing can be running, so the obligation is met; anything else (202
 * `accepted`, or a seam that returns nothing) is `accepted` and proves
 * NOTHING about the turn — only eve's stream does.
 */
export type RemoteCancelReply = "accepted" | "terminal";

/**
 * Ask eve to cancel a turn on this session (`POST .../cancel`). Rejects on a
 * transport failure (the request provably never reached eve).
 */
export type CancelRemoteTurn = (options?: {
  /**
   * The turn to cancel (`turn.started.data.turnId`), used as eve's
   * stale-request guard: a late request naming a finished turn is a no-op,
   * so a qualified cancel can never stop a successor's turn. The tail only
   * ever issues QUALIFIED cancels — a Stop, the wall-clock cap and shutdown
   * alike wait for the run's own turn id and send nothing before it (an
   * unqualified cancel is a no-op before `turn.started` and could only ever
   * hit a successor's turn if it arrived late). The option stays optional
   * for the seam's shape; the tail never omits it.
   */
  turnId?: string;
}) => Promise<RemoteCancelReply | void>;

export interface TailRunOptions {
  runId: string;
  agentSessionId: string;
  openStream: OpenRunStream;
  /** Optional so focused unit fixtures need not model the control plane. */
  cancelRemoteTurn?: CancelRemoteTurn;
  store: RunStore;
  bus: RunEventBus;
  /** Per-run wall-clock cap in ms (MAX_RUN_WALL_CLOCK_MS). */
  maxWallClockMs: number;
  /**
   * Observation window in ms after a live Stop (REMOTE_CANCEL_OBSERVE_MS):
   * how long the tail keeps following the stream for eve's confirmation
   * before declaring the obligation unresolved. Default 10 minutes.
   */
  remoteCancelObserveMs?: number;
  /**
   * Start directly in OBSERVATION mode for an already-settled run carrying
   * its obligation (the sweeper / boot reconciliation re-opening a crashed
   * observation, or the post-eve recheck handing a canceled dispatch to
   * observation). No adoption CAS, no status frames; the tail persists
   * events from the run's persisted seq and follows the session's open
   * obligations (this run's among them) to their boundaries. `deadlineAt`
   * is the absolute epoch-ms bound (obligation timestamp + observe window).
   */
  observe?: { deadlineAt: number };
  /**
   * Chained start: wait for the prior holder of the session's stream to
   * release its cursor before reading anything. The manager passes the
   * handle of a detached observation tail (or a tail still draining) on the
   * same session so the two never read eve's stream at once (one cursor
   * owner per stream). The wait is UNBOUNDED while the prior is a live
   * reader (admission forbids that case; the manager warns) and BOUNDED by
   * `streamTakeoverMs` once it is closed: a drain that never releases its
   * cursor is seized (`RunTailHandle.seize`) and this tail takes over.
   */
  chainBehind?: ChainedStream;
  /**
   * How long a chained start waits for a CLOSED prior tail to release the
   * stream before seizing it (default {@link DEFAULT_STREAM_TAKEOVER_MS}).
   * The prior is being torn down — a reconnect or store call that never
   * resolves must not wedge the session behind it.
   */
  streamTakeoverMs?: number;
  /** Reconnect attempts after unexpected drops (default 5). */
  maxReconnectAttempts?: number;
  /** Base reconnect backoff in ms (default 500; ×2 per attempt). */
  reconnectDelayMs?: number;
  /** Metrics seam: called once when the run reaches a terminal state. */
  onFinish?: RunFinishedHook;
  /**
   * Health seam: called once per (non-duplicate) `authorization.required`
   * event with eve's connection name — the per-version SLUG the compiler
   * emitted, which the wiring resolves to a `connections` row via the agent
   * version's `connection_slugs` map and flips to `health: "auth_required"`.
   * Fired even for a leftover challenge drained from a previous turn:
   * connection health is a fact about the connection, not about this run.
   * Exceptions are swallowed (logged) — a health flip must never kill a tail.
   */
  onAuthorizationRequired?: (info: { connectionName: string }) => void;
  /**
   * Called SYNCHRONOUSLY the moment the tail CLOSES (`close(reason)` — the
   * one transition every exit path takes at its start: observation closed
   * (confirmed / unresolved), a detach, a settlement that aborts, the run's
   * natural terminal, reconnect exhaustion, a seizure), i.e. the instant
   * this tail will read no further event and adopt nothing. The manager
   * unbinds the session's reader slot here (not in `done.finally`, which
   * resolves only once the stream is released — possibly much later, behind
   * a hung connect), so a settlement arriving in between finds no live
   * reader and opens its own observer instead of signaling a tail that can
   * no longer act.
   */
  onClose?: () => void;
  /** Structured run-lifecycle logging (started/terminal). Optional. */
  logger?: Logger;
}

export const DEFAULT_REMOTE_CANCEL_OBSERVE_MS = 10 * 60 * 1000;

/**
 * Bound on a chained tail's wait for a CLOSED prior tail to release the
 * session's stream before seizing it ({@link TailRunOptions.streamTakeoverMs}).
 */
export const DEFAULT_STREAM_TAKEOVER_MS = 5_000;

/** Retries of a failed (transport) qualified cancel issued by observation. */
const QUALIFIED_CANCEL_RETRY_ATTEMPTS = 3;
const QUALIFIED_CANCEL_RETRY_DELAY_MS = 5_000;

export interface CancelOptions {
  /**
   * Terminal status to mark the run with. Default `failed` (shutdown — the
   * row settles WITH its obligation if the turn may be live, and the tail
   * aborts: the next boot's sweeper observes); the run-cancel API passes
   * `canceled` so a user Stop is recorded as a clean cancellation AND the
   * tail stays on the stream in observation mode.
   */
  status?: "failed" | "canceled";
  /**
   * AWAIT the turn-qualified remote cancel's request (when the turn id is
   * known) before the row finalizes, so the returned outcome reports what
   * eve answered. Default false: fire-and-forget.
   */
  awaitRemote?: boolean;
}

/**
 * What became of a Stop's remote leg at the moment the row finalized:
 * `issued` (a turn-qualified cancel reached eve — 202; the turn boundary is
 * still owed and observation follows it), `pending` (the run's turn has not
 * started yet, so nothing was sent — observation issues the qualified cancel
 * when the turn is attributed), `failed` (the qualified cancel failed in
 * transport — observation retries it and still owes the boundary),
 * `terminal` (eve answered session-dead — nothing can be running; nothing
 * owed), `unavailable` (no remote seam — unit fixtures; nothing owed). Only
 * `terminal` and `unavailable` finalize WITHOUT the durable obligation.
 */
export type RemoteCancelOutcome =
  | "issued"
  | "pending"
  | "failed"
  | "terminal"
  | "unavailable";

export interface RunTailHandle {
  runId: string;
  agentSessionId: string;
  /** True while the tail is in observation mode (its run is already settled). */
  readonly observing: boolean;
  /**
   * True once the tail has CLOSED — every exit path (an abort, the run's
   * natural terminal, reconnect exhaustion, a seizure) takes the one
   * `close` transition synchronously at its start: it reads no further
   * event and can adopt nothing — NOT a reader any more, even though `done`
   * may still be pending (the stream is released only when `done` resolves).
   */
  readonly closed: boolean;
  /** Resolves the moment the tail closes (see `closed`) — before `done`. */
  onceClosed: Promise<void>;
  /** Resolves when the tail has fully stopped (terminal, observation closed, or dead). */
  done: Promise<void>;
  /**
   * Force the stream's release: close the tail (idempotent), FENCE it so it
   * consumes, attributes and writes nothing more even if the connection or
   * body it is stuck on later yields, and resolve once any event handling
   * already in flight has settled (the tail is between reads, or has
   * exited) — so the old reader's last write lands before a new reader
   * takes the cursor. The hung connect/read itself is abandoned (`done`
   * still trails it). A successor chained behind a drain that outlived
   * `streamTakeoverMs` calls this before taking over.
   */
  seize(): Promise<void>;
  /**
   * Stop the run. `status: "canceled"` (a user Stop) finalizes the row NOW —
   * with its obligation — and switches the tail to observation; the promise
   * resolves with the remote outcome once the row is finalized (NOT once
   * observation ends — that is `done`). The default `failed` (shutdown)
   * finalizes the row the same way — obligation included when the turn may
   * be live, a qualified cancel if the turn is known, never an unqualified
   * one — and aborts the tail. On an observation tail a non-user cancel is
   * a detach (the obligation survives for the sweeper).
   */
  cancel(reason?: string, options?: CancelOptions): Promise<RemoteCancelOutcome>;
  /**
   * Stop tailing WITHOUT marking the run terminal — used by the dead-worker
   * sweeper to detach a stale tail (its worker died) so the run can be
   * re-tailed against a freshly scheduled worker, and by the manager to hand
   * an observation tail's session over to a successor's normal tail. The run
   * keeps its current DB status; an observation's obligation stays on the
   * row.
   */
  detach(): void;
  /**
   * Re-read the session's open obligations from the store and adopt any this
   * tail does not follow yet (a Stop settled WITHOUT a tail while this tail
   * held the session's stream — the guarded settlement counts it `observing`
   * and signals the live tail through the manager). An adopted obligation
   * whose turn is already known gets its qualified cancel at once. Runs
   * through the tail's serial queue, so it never interleaves with an
   * attribution or a settlement. Resolves FALSE when the tail's abort has
   * landed (it re-read nothing and will act on nothing): the caller must
   * not count the handoff as done and opens its own observer instead.
   */
  refreshObligations(): Promise<boolean>;
}

/** The prior holder of a session's stream that a chained tail waits behind. */
export type ChainedStream = Pick<
  RunTailHandle,
  "runId" | "closed" | "onceClosed" | "done" | "seize"
>;

/** One open remote-cancel obligation this tail is following. */
interface Obligation {
  runId: string;
  turnId: string | null;
  /** The correlator of the run's latest send (null = content-less). */
  messageHash: string | null;
  /** Declared unresolved — still attributable, ranked after pending ones. */
  unresolved: boolean;
  /** Row age (epoch ms) — the tie-breaker among identical texts. */
  createdAt: number;
  /** This tail's own run (observation mode). */
  self: boolean;
}

/** Attribution priority: pending before unresolved, oldest first within each. */
function byAttributionPriority(a: Obligation, b: Obligation): number {
  if (a.unresolved !== b.unresolved) return a.unresolved ? 1 : -1;
  return a.createdAt - b.createdAt;
}

/** The correlator a turn's opening presents: its message's hash, or null. */
type TurnContent = { hash: string } | null;

type TurnAttribution = "own" | "obligation" | "successor" | "foreign";

function isTurnBoundaryEvent(
  event: EveStreamEvent,
): event is Extract<EveStreamEvent, { type: "turn.cancelled" | "turn.completed" }> {
  return event.type === "turn.cancelled" || event.type === "turn.completed";
}

export function tailRun(options: TailRunOptions): RunTailHandle {
  const {
    runId,
    agentSessionId,
    openStream,
    cancelRemoteTurn,
    store,
    bus,
    maxWallClockMs,
    remoteCancelObserveMs = DEFAULT_REMOTE_CANCEL_OBSERVE_MS,
    streamTakeoverMs = DEFAULT_STREAM_TAKEOVER_MS,
    maxReconnectAttempts = 5,
    reconnectDelayMs = 500,
    onFinish,
    onAuthorizationRequired,
    logger,
  } = options;

  const log = logger?.child({ runId, sessionId: agentSessionId });
  const tailStartedAt = Date.now();
  const abort = new AbortController();
  let cancelReason: string | null = null;
  /**
   * THE ONE EXIT TRANSITION. Every path out of the tail — a settlement's
   * abort, an observation closing or expiring, a detach, a seizure, the
   * run's natural terminal, reconnect exhaustion, and the `done` body's own
   * exit as a backstop — goes through here SYNCHRONOUSLY at its start:
   * `closed` flips, the manager frees the session's reader slot
   * (`onClose`), the stream is aborted, and from this instant
   * `refreshObligations` answers false and no event is consumed, attributed
   * or written. Only an explicit abort used to move a handle out of the
   * reader slot: a tail exiting through its natural terminal (or reconnect
   * exhaustion) stayed live until `done.finally`, so a settlement signal in
   * that window was adopted by a tail about to return — and its run had no
   * reader until the next sweep.
   */
  let closed = false;
  let resolveClosed!: () => void;
  const onceClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    try {
      options.onClose?.();
    } catch (error) {
      log?.warn("run.tail_close_hook_failed", {
        fields: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    abort.abort();
    resolveClosed();
    log?.debug("run.tail_closed", { fields: { reason } });
  };
  /**
   * Event handling in flight — the preamble's writes, or one consumed
   * event's attribution + persist. A seizure waits for it to settle so the
   * old reader's last write lands before the new reader takes the cursor;
   * between reads (and behind a hung connect) the tail is idle.
   */
  let busy = false;
  let idleWaiters: Array<() => void> = [];
  const setBusy = (value: boolean) => {
    busy = value;
    if (value) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };
  /** `follow` = a live run's tail; `observe` = owing eve a confirmation only. */
  let mode: "follow" | "observe" = options.observe ? "observe" : "follow";
  /**
   * `turn.started.data.turnId` of THIS run's own latest turn — loaded from
   * `runs.turn_id` at start (a resume), written there the moment it is
   * attributed. Function scope so it survives reconnects.
   */
  let ownTurnId: string | null = null;
  /** `runs.message_hash` of this run's latest send (null = content-less). */
  let ownMessageHash: string | null = null;
  // TERMINAL GATE: terminals only count once this run's own turn boundary
  // (`turn.started`) has been seen — everything before it is a previous
  // turn's leftover (see the module doc). Derived from the durable column,
  // never from `seq > 0` (leftovers persisted under this run satisfy that).
  let sawOwnTurn = false;
  /** The session's open obligations this tail follows (attribution priority). */
  let obligations: Obligation[] = [];
  let finished = mode === "observe";
  let observationClosed = false;
  /** The preamble has loaded the session's obligations (deadline callback). */
  let obligationsLoaded = false;
  // Final assistant reply of THIS run (see RunFinishedHook). Only tracked
  // once the run's own turn boundary has been seen — a leftover stop-message
  // drained from a previous turn must never be delivered as this run's reply.
  let lastAssistantMessage: string | null = null;
  // Detach (dead-worker failover / session handover) aborts the loop but
  // leaves the run's status and obligations untouched.
  let detaching = false;
  let observeTimer: ReturnType<typeof setTimeout> | null = null;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * THE TAIL'S SERIAL QUEUE. Turn attribution (the consume loop), settlement
   * (a Stop, the wall-clock cap, shutdown — each from its own timer or
   * request) and an obligation refresh (the manager's signal) all mutate
   * `ownTurnId` and `obligations` across awaits, and used to interleave: a
   * settlement that snapshotted `ownTurnId === null` while an attribution's
   * `setRunTurnId` was in flight installed a null-id obligation, so the
   * qualified cancel was never sent and the turn's own boundary could not
   * match it. Every such section now runs here, one at a time, in arrival
   * order — a settlement runs strictly after any in-flight attribution has
   * completed, and reads the turn id that attribution wrote.
   */
  let serial: Promise<void> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = serial.then(work, work);
    serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

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
    extra: { remoteCancelPendingAt?: Date } = {},
  ): Promise<boolean> => {
    if (finished) return false;
    finished = true;
    // Compare-and-swap: markRun refuses to overwrite a terminal status. When
    // another actor (run-cancel API, sweeper) already finalized this run, the
    // tail steps aside — no session stomp, no duplicate status frame.
    // ONE instant: a row settled WITH its obligation carries the same
    // timestamp in both columns by construction (a second clock read here
    // straddled a millisecond boundary now and then).
    const now = extra.remoteCancelPendingAt ?? new Date();
    const marked = await store.markRun(runId, {
      status,
      error: error ?? null,
      ...(status === "waiting" ? {} : { completedAt: now }),
      // ONE statement: a settled row is born carrying its obligation.
      ...extra,
    });
    if (!marked) {
      log?.info("run.finish_skipped", {
        fields: { attemptedStatus: status, reason: "run already terminal" },
      });
      return false;
    }
    if (sessionStatus) await store.markSession(agentSessionId, sessionStatus);
    publishStatus(status, error ?? null);
    const durationMs = Date.now() - tailStartedAt;
    onFinish?.({ runId, status, durationMs, lastAssistantMessage });
    const level = status === "failed" ? "warn" : "info";
    log?.emit(level, `run.${status}`, {
      durationMs,
      ...(error !== undefined ? { fields: { reason: error } } : {}),
    });
    return true;
  };

  const closeObservation = () => {
    if (observationClosed) return;
    observationClosed = true;
    close("observation closed");
  };

  /** An obligation is MET: clear the durable marker, drop it from the list. */
  const confirmObligation = async (obligation: Obligation, why: string) => {
    obligations = obligations.filter((o) => o !== obligation);
    try {
      await store.clearRemoteCancelPending(obligation.runId);
      log?.info("run.remote_cancel_confirmed", {
        fields: { obligationRunId: obligation.runId, turnId: obligation.turnId, why },
      });
    } catch (error) {
      // The marker stays; the sweeper retries. Never a stream error.
      log?.warn("run.remote_cancel_confirm_failed", {
        fields: {
          obligationRunId: obligation.runId,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
    if (mode === "observe" && obligations.length === 0) closeObservation();
  };

  /**
   * Issue the turn-QUALIFIED cancel for an obligation whose turn is known.
   * Fire-and-forget with bounded transport retries; eve's session-terminal
   * answer confirms the obligation on the spot.
   */
  const issueQualifiedCancel = (obligation: Obligation, attempt = 1): void => {
    // A closed tail is nobody's observer: the sweeper (or the caller's own
    // observer) re-issues from the row.
    if (closed || !cancelRemoteTurn || obligation.turnId === null) return;
    const turnId = obligation.turnId;
    void cancelRemoteTurn({ turnId })
      .then(async (reply) => {
        log?.info("run.remote_cancel_issued", {
          fields: { obligationRunId: obligation.runId, turnId, reply: reply ?? "accepted" },
        });
        if (reply === "terminal" && obligations.includes(obligation)) {
          await confirmObligation(obligation, "eve: session terminal");
        }
      })
      .catch((error: unknown) => {
        log?.warn("run.remote_cancel_failed", {
          fields: {
            why: "observation",
            obligationRunId: obligation.runId,
            turnId,
            attempt,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
        if (attempt >= QUALIFIED_CANCEL_RETRY_ATTEMPTS || closed) return;
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          if (!closed && obligations.includes(obligation)) {
            issueQualifiedCancel(obligation, attempt + 1);
          }
        }, QUALIFIED_CANCEL_RETRY_DELAY_MS * attempt);
        retryTimers.add(timer);
      });
  };

  const armObserveDeadline = (deadlineAt: number) => {
    if (observeTimer) clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      void (async () => {
        // Armed at CREATION — before a chained wait, before the preamble
        // loads the list. Until it is loaded the obligation is owed by
        // construction (`observe` is only opened for a run carrying its
        // marker); the store's CAS answers false if it was met meanwhile.
        const mine = obligationsLoaded
          ? obligations.find((o) => o.self)
          : { turnId: ownTurnId };
        if (mine) {
          // Explicit, visible residual — never a silent clear. Predecessor
          // obligations carried by this tail are bounded by the sweeper's
          // own age check against their own timestamps. The obligation
          // stays attributable: a later tail on the session still matches
          // its content and clears both columns on the boundary.
          let declared = false;
          try {
            declared = await store.markRemoteCancelUnresolved(runId);
          } catch (error) {
            log?.warn("run.remote_cancel_unresolved_write_failed", {
              fields: { reason: error instanceof Error ? error.message : String(error) },
            });
          }
          if (declared) {
            log?.warn("run.remote_cancel_unresolved", {
              fields: {
                turnId: mine.turnId,
                observeMs: remoteCancelObserveMs,
                reason:
                  "observation window elapsed with no confirmation from eve's stream — obligation left open and marked unresolved",
              },
            });
          } else {
            // Met by another actor (a proven successor, a session-terminal
            // answer on a route) while this tail was still watching.
            log?.info("run.observation_closed", {
              fields: { reason: "obligation already met or declared elsewhere" },
            });
          }
        }
        closeObservation();
      })();
    }, Math.max(0, deadlineAt - Date.now()));
  };

  const isKnownTurn = (turnId: string): boolean =>
    ownTurnId === turnId || obligations.some((o) => o.turnId === turnId);

  const toObligation = (row: PendingRemoteCancel): Obligation => ({
    runId: row.runId,
    turnId: row.turnId,
    messageHash: row.messageHash,
    unresolved: row.unresolvedAt !== null,
    createdAt: row.createdAt.getTime(),
    self: row.runId === runId,
  });

  /**
   * RETROACTIVE attribution, from disk. An obligation loaded or adopted with
   * a null turn id may already have had its turn: the turn opened BEFORE
   * the obligation existed for any reader (a continuation Stopped without
   * a tail after its message was on the wire), matched nothing, and was
   * persisted FOREIGN — by this tail, by a reader that has since crashed,
   * or by an earlier build. Waiting for "its turn opening" would wait
   * forever, the qualified cancel would never go out, and the obligation
   * would age out unresolved with its turn possibly still running. So every
   * null-turn CONTENT obligation is matched against the session's persisted
   * unowned content turns (`listUnownedContentTurns` — `message.received`
   * text hashed, no run's `turn_id` equal to the id) under the live rules:
   * attribution priority among the candidates, oldest persisted turn first
   * among identical texts, and ids this tail already knows are never
   * re-claimed. A match writes the proof (`setRunTurnId`) and either issues
   * the qualified cancel or — the turn's own boundary is on disk too —
   * meets the obligation on the spot. Content-less obligations have no
   * correlator to look back with and keep waiting for the live stream.
   * Best-effort: a store failure here leaves the obligation as it was.
   */
  const recoverPersistedTurns = async (candidates: Obligation[], why: string): Promise<void> => {
    if (closed) return;
    const open = candidates
      .filter((o) => obligations.includes(o) && o.turnId === null && o.messageHash !== null)
      .sort(byAttributionPriority);
    if (open.length === 0) return;
    let persisted: Awaited<ReturnType<RunStore["listUnownedContentTurns"]>>;
    try {
      persisted = await store.listUnownedContentTurns(agentSessionId);
    } catch (error) {
      log?.warn("run.persisted_turn_lookback_failed", {
        fields: { why, reason: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    const taken = new Set<string>();
    for (const obligation of open) {
      const match = persisted.find(
        (turn) =>
          !taken.has(turn.turnId) &&
          !isKnownTurn(turn.turnId) &&
          turn.messageHash === obligation.messageHash,
      );
      if (!match) continue;
      taken.add(match.turnId);
      obligation.turnId = match.turnId;
      if (obligation.self) ownTurnId = match.turnId;
      const written = await store.setRunTurnId(obligation.runId, match.turnId);
      log?.info("run.remote_cancel_turn_attributed", {
        fields: {
          obligationRunId: obligation.runId,
          turnId: match.turnId,
          written,
          by: "persisted",
          ended: match.ended,
          unresolved: obligation.unresolved,
          why,
        },
      });
      if (match.ended) {
        await confirmObligation(obligation, "own turn boundary already persisted");
      } else {
        issueQualifiedCancel(obligation);
      }
    }
  };

  /**
   * CURRENT obligations, not a start-of-tail snapshot. The list this tail
   * follows was loaded once when it started, but obligations are created
   * while it is live: a continuation admitted after an observation attached
   * and then Stopped BEFORE its own tail started (the post-eve recheck, or
   * `cancelAgentRun` with no tail) settles WITHOUT a tail, and the guarded
   * settlement leaves it to "the live tail on the session" — which never
   * loaded it. Its turn then matched nothing: the run is terminal, so the
   * live-successor lookup excluded it too, and the turn was persisted as
   * FOREIGN — no qualified cancel, the obligation left to age out
   * unresolved. So the store is re-read at every point where an obligation
   * can matter — each turn opening (before the claimant search), each
   * boundary (before the owner match), a settlement, and the manager's
   * signal — and merged: new rows are adopted (with their turn id, when a
   * previous reader already attributed it — the qualified cancel goes out
   * at once), known rows keep this tail's more recent turn id, and rows
   * another actor has cleared (a session-terminal answer on a route, the
   * guarded settlement) are dropped. Cheap: a few rows by session id.
   * Callers hold the serial queue. A turn opening passes the snapshot it
   * read (`listSessionClaimants` — ONE statement covering obligations AND
   * live successors), so its claimant search and this merge see the same
   * instant; every other caller reads here. Adopted rows with a null turn
   * id are then looked back on disk (`recoverPersistedTurns`).
   */
  const refreshObligationsUnlocked = async (
    why: string,
    snapshot?: SessionClaimants,
  ): Promise<void> => {
    // A closed tail adopts nothing: whatever is on the row belongs to the
    // caller's own observer (or the sweeper), which loads it from the store.
    if (closed) return;
    const current = (snapshot ?? (await store.listSessionClaimants(agentSessionId))).obligations;
    const next: Obligation[] = [];
    const adopted: Obligation[] = [];
    for (const row of current) {
      // A follow tail's own live run owes nothing (its marker, if any, is
      // written only by the settlement that flips this tail to observe).
      if (mode === "follow" && row.runId === runId) continue;
      const known = obligations.find((o) => o.runId === row.runId);
      if (known) {
        known.unresolved = row.unresolvedAt !== null;
        if (known.turnId === null && row.turnId !== null) {
          // The row learned its turn from another reader (or from this
          // tail's own attribution, in the settlement re-read): the
          // qualified cancel was owed the moment the id existed.
          known.turnId = row.turnId;
          if (known.self) ownTurnId = row.turnId;
          issueQualifiedCancel(known);
        }
        next.push(known);
        continue;
      }
      const obligation = toObligation(row);
      next.push(obligation);
      adopted.push(obligation);
      if (obligation.turnId !== null) issueQualifiedCancel(obligation);
    }
    const dropped = obligations.filter((o) => !current.some((row) => row.runId === o.runId));
    obligations = next;
    if (adopted.length > 0 || dropped.length > 0) {
      log?.info("run.obligations_refreshed", {
        fields: {
          why,
          adopted: adopted.map((o) => o.runId),
          dropped: dropped.map((o) => o.runId),
          following: obligations.map((o) => o.runId),
        },
      });
    }
    // An adopted obligation's turn may already have gone by on this stream
    // (persisted foreign before the obligation existed): attribute it from
    // disk now, never wait for an opening that already happened.
    await recoverPersistedTurns(adopted, why);
    if (mode === "observe" && obligations.length === 0) closeObservation();
  };

  /**
   * Attribute a turn by CONTENT (see the module doc) once its opening is
   * complete: `content` is the hash of its `message.received`, or null for a
   * content-less turn. A re-read of a known id is idempotent. Afterwards,
   * serialization: the turn starting proves every attributed obligation
   * with another id over, and a turn attributed to a NEWER run (own, or a
   * live successor) proves every obligation on the session over.
   *
   * Runs on the tail's serial queue (never interleaves with a settlement),
   * and consults the store's CURRENT claimants — obligations AND live
   * successors — from ONE read taken before the search. Two reads (the
   * obligations first, the live runs later) had a window: a no-tail Stop
   * committing a successor's marker between them flipped it from live to
   * settled, so it was in NEITHER result — its already-open turn was
   * classified foreign, and the obligation adopted afterwards with a null
   * id could neither be cancelled qualified nor cleared on its boundary.
   */
  const attributeTurn = (turnId: string, content: TurnContent): Promise<TurnAttribution> =>
    serialized(() => attributeTurnUnlocked(turnId, content));

  const attributeTurnUnlocked = async (
    turnId: string,
    content: TurnContent,
  ): Promise<TurnAttribution> => {
    const claimants = await store.listSessionClaimants(agentSessionId);
    await refreshObligationsUnlocked("turn opened", claimants);
    const correlator = content?.hash ?? null;
    const kind = content ? "content" : "content-less";
    let result: TurnAttribution;
    if (ownTurnId === turnId) {
      result = "own";
    } else if (obligations.some((o) => o.turnId === turnId)) {
      result = "obligation";
    } else {
      const claimant = obligations
        .filter((o) => o.turnId === null && o.messageHash === correlator)
        .sort(byAttributionPriority)[0];
      if (claimant) {
        claimant.turnId = turnId;
        const written = await store.setRunTurnId(claimant.runId, turnId);
        log?.info("run.remote_cancel_turn_attributed", {
          fields: {
            obligationRunId: claimant.runId,
            turnId,
            written,
            by: kind,
            unresolved: claimant.unresolved,
          },
        });
        issueQualifiedCancel(claimant);
        result = "obligation";
      } else if (mode === "follow" && ownMessageHash === correlator) {
        // Written BEFORE the event is persisted (crash-safe: the proof lands
        // first, the event is re-read on resume and recognized as own).
        const written = await store.setRunTurnId(runId, turnId);
        if (!written) {
          log?.warn("run.turn_id_refused", {
            fields: { turnId, reason: "a different turn id is already on the row" },
          });
        }
        ownTurnId = turnId;
        result = "own";
      } else if (content) {
        // A live successor whose own tail has not taken the stream over
        // yet (its turn was drained here): hand it its acceptance proof.
        // Same snapshot as the obligations above — never a second read.
        const successor = claimants.live.find(
          (run) => run.runId !== runId && run.messageHash === content.hash,
        );
        if (successor) {
          const written = await store.setRunTurnId(successor.runId, turnId);
          log?.info("run.turn_attributed_successor", {
            fields: { successorRunId: successor.runId, turnId, written },
          });
          result = "successor";
        } else {
          result = "foreign";
        }
      } else {
        result = "foreign";
      }
    }
    if (result === "foreign") {
      log?.info("run.turn_foreign", {
        fields: {
          turnId,
          by: kind,
          reason: "no run on the session sent this turn's content — persisted, never attributed, never canceled",
        },
      });
    }
    // SERIALIZATION. eve runs one turn at a time: this turn starting proves
    // every attributed obligation with another id over. A turn attributed
    // to a NEWER run (own in follow mode; a live successor) proves every
    // obligation on the session over — `classifySessionSuccessor`'s rule,
    // applied inline (every obligation predates a live run: admission
    // forbids a new run while one is live).
    const supersedesAll = result === "own" || result === "successor";
    for (const obligation of [...obligations]) {
      if (obligation.turnId === turnId) continue;
      if (obligation.turnId !== null) {
        await confirmObligation(obligation, "a later turn started");
      } else if (supersedesAll) {
        await confirmObligation(obligation, "superseded — a newer run's turn started");
      }
    }
    return result;
  };

  /**
   * Settle the row terminal WITH its obligation in one CAS — the shape every
   * cause shares (a user Stop, the wall-clock cap, shutdown): a turn-QUALIFIED
   * cancel if the turn is known, NOTHING if not; then observation (or, for
   * shutdown, an abort — the obligation is durable and the next boot's
   * sweeper observes). Returns the remote outcome once the row is finalized.
   *
   * Runs on the tail's serial queue: it starts only after any in-flight
   * attribution has completed (so the `ownTurnId` it reads is the one that
   * attribution wrote), and after finalizing it re-reads the row's `turn_id`
   * through the obligation refresh — an id that is known by then gets its
   * qualified cancel immediately, never "at the next attribution".
   */
  const settleAndObserve = (
    status: "canceled" | "failed",
    reason: string,
    settle: { awaitRemote?: boolean; observe: boolean },
  ): Promise<RemoteCancelOutcome> =>
    serialized(() => settleAndObserveUnlocked(status, reason, settle));

  const settleAndObserveUnlocked = async (
    status: "canceled" | "failed",
    reason: string,
    settle: { awaitRemote?: boolean; observe: boolean },
  ): Promise<RemoteCancelOutcome> => {
    const turnId = ownTurnId;
    let outcome: RemoteCancelOutcome;
    if (!cancelRemoteTurn) {
      outcome = "unavailable";
    } else if (turnId === null) {
      outcome = "pending";
      log?.info("run.remote_cancel_pending", {
        fields: {
          reason: "turn not started yet — the qualified cancel follows its attribution",
          cause: reason,
        },
      });
    } else if (settle.awaitRemote) {
      try {
        const reply = await cancelRemoteTurn({ turnId });
        outcome = reply === "terminal" ? "terminal" : "issued";
      } catch (error) {
        outcome = "failed";
        log?.warn("run.remote_cancel_failed", {
          fields: {
            why: reason,
            turnId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } else {
      void cancelRemoteTurn({ turnId }).catch((error: unknown) => {
        log?.warn("run.remote_cancel_failed", {
          fields: {
            why: reason,
            turnId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      });
      outcome = "issued";
    }
    // Finalize NOW, with the obligation in the same statement unless eve
    // (or the absence of a seam) says nothing can be running.
    const owes = outcome !== "unavailable" && outcome !== "terminal";
    const now = new Date();
    const marked = await finishRun(
      status,
      status === "canceled" ? "active" : null,
      reason,
      owes ? { remoteCancelPendingAt: now } : {},
    );
    if (!marked || !owes || !settle.observe) {
      // Nothing to observe here: another actor already finalized the row
      // (its own obligation, if any, is on it), nothing is owed, or the
      // process is going down (the obligation is durable; the sweeper
      // re-opens observation at the next boot).
      close("settled without observation");
      return outcome;
    }
    // OBSERVATION: stay on the stream for eve's own confirmation.
    mode = "observe";
    const mine: Obligation = {
      runId,
      turnId,
      messageHash: ownMessageHash,
      unresolved: false,
      createdAt: now.getTime(),
      self: true,
    };
    obligations = [...obligations, mine];
    if (wallClockTimer) clearTimeout(wallClockTimer);
    armObserveDeadline(now.getTime() + remoteCancelObserveMs);
    if (outcome === "failed") issueQualifiedCancel(mine, 2);
    // Re-read AFTER finalization: the row's `turn_id` is the authority. If
    // it is known now (this tail's attribution landed before this settlement
    // was queued but after the preamble's load, or another reader wrote it),
    // the qualified cancel goes out here — never deferred to an attribution
    // that has already happened. The same read adopts obligations settled
    // without a tail while this tail was live.
    await refreshObligationsUnlocked("settled");
    log?.info("run.observing", {
      fields: {
        turnId: obligations.find((o) => o.self)?.turnId ?? turnId,
        outcome,
        observeMs: remoteCancelObserveMs,
        cause: reason,
      },
    });
    return outcome;
  };

  const wallClockTimer =
    mode === "follow"
      ? setTimeout(() => {
          cancelReason ??= `run exceeded the wall-clock cap (${maxWallClockMs}ms)`;
          // Real enforcement: stop eve's turn — QUALIFIED if it is known,
          // nothing if not (the qualified cancel follows attribution) — and
          // owe eve the confirmation exactly like a Stop.
          void settleAndObserve("failed", cancelReason, { observe: true });
        }, maxWallClockMs)
      : null;

  /**
   * THE CHAIN WAIT, bounded. Behind a LIVE prior (a reader still following
   * its run — admission forbids two, the manager warned) the wait is
   * unbounded: seizing it would fail a live run. Once the prior is CLOSED
   * it is being torn down and owes nothing but its cursor: after
   * `streamTakeoverMs` without `done` its drain is hung (a reconnect or
   * store call that never resolves), so it is seized — closed and fenced,
   * its in-flight handling awaited (bounded again) — and this tail takes
   * the cursor over from the persisted counts. Own closure (the observation
   * deadline, a detach, shutdown) ends the wait at once.
   */
  const awaitStreamRelease = async (prior: ChainedStream): Promise<void> => {
    const priorDone = prior.done.then(
      () => "released" as const,
      () => "released" as const,
    );
    const ownClose = onceClosed.then(() => "closed" as const);
    const bounded = <T extends string>(
      ms: number,
      ...races: Array<Promise<T>>
    ): Promise<T | "timeout"> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const expiry = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
      return Promise.race<T | "timeout">([...races, expiry]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const first = await Promise.race([
      priorDone,
      prior.onceClosed.then(() => "prior closed" as const),
      ownClose,
    ]);
    if (first !== "prior closed") return;
    if ((await bounded(streamTakeoverMs, priorDone, ownClose)) !== "timeout") return;
    if (closed) return;
    log?.warn("run.tail_takeover", {
      fields: {
        drainingRunId: prior.runId,
        waitedMs: streamTakeoverMs,
        reason:
          "the closed prior tail never released the session's stream — seizing it and taking its cursor over",
      },
    });
    const seized = prior.seize().then(() => "seized" as const);
    if ((await bounded(streamTakeoverMs, seized, ownClose)) === "timeout" && !closed) {
      log?.warn("run.tail_takeover_forced", {
        fields: {
          drainingRunId: prior.runId,
          waitedMs: streamTakeoverMs,
          reason:
            "the seized tail's in-flight event handling did not settle — proceeding; its stream is fenced, a write that lands later is the residual",
        },
      });
    }
  };

  // OBSERVATION DEADLINE, armed at CREATION — before any chain wait, before
  // the preamble's loads: it fires while waiting too (unresolved declared,
  // the tail closed, its handle released), so a drain this observer is
  // chained behind can never hold it past its window.
  if (options.observe) armObserveDeadline(options.observe.deadlineAt);

  const run = async (): Promise<void> => {
    if (options.chainBehind) await awaitStreamRelease(options.chainBehind);
    if (closed) return;
    setBusy(true);
    // Resume points derived from what is already persisted (crash-safe).
    let seq = await store.countRunEvents(runId);
    let startIndex = await store.countSessionEvents(agentSessionId);
    // Stable eve event ids already persisted for THIS run. A reconnect that
    // re-reads an overlapping window recognizes them and skips the write —
    // the correctness guarantee index arithmetic alone could not give, since
    // an unparseable line (or any event we consumed without persisting)
    // silently undercounts `startIndex` forever and turns every later
    // reconnect into a duplicate-row generator.
    const seenEventIds = new Set(await store.listEventIds(runId));
    let pendingInput = false;
    let pendingAuthorization = false;
    let canceledTurn = false;
    // Tail index eve reported at attach (null = header absent/not requested).
    let requestTailIndex = true;
    let catchUpBound: number | null = null;

    // The durable turn state: this run's own turn and correlator (a resume),
    // and the session's open obligations in attribution priority (see the
    // module doc).
    const turnState = await store.getRunTurnState(runId);
    ownTurnId = turnState?.turnId ?? null;
    ownMessageHash = turnState?.messageHash ?? null;
    const pending = (await store.listSessionClaimants(agentSessionId)).obligations;
    obligations = pending.map(toObligation);
    obligationsLoaded = true;
    if (closed) return;
    if (mode === "observe") {
      const mine = obligations.find((o) => o.self);
      if (!mine) {
        close("nothing owed");
        log?.info("run.observation_skipped", {
          fields: { reason: "no open obligation on the row — met by another actor" },
        });
        return;
      }
      ownTurnId = mine.turnId ?? ownTurnId;
      mine.turnId = ownTurnId;
      // The turn is already known (a crashed observation, or a transport
      // failure the sweeper is retrying): (re)issue the qualified cancel.
      if (mine.turnId !== null) issueQualifiedCancel(mine);
      // Any obligation whose turn is NOT known may have had it already —
      // persisted foreign by a reader that is gone: attribute from disk
      // (own included: a crashed observation re-opened after the turn
      // opened; if the boundary is down too, nothing is owed and the
      // observation ends before it starts).
      await recoverPersistedTurns(obligations, "observation started");
      if (closed) return;
      log?.info("run.observing", {
        fields: {
          resumedSeq: seq,
          turnId: mine.turnId,
          obligations: obligations.map((o) => o.runId),
        },
      });
    } else {
      obligations = obligations.filter((o) => !o.self);
      // Predecessor obligations whose turn already went by (persisted
      // foreign under an earlier reader) are attributed from disk BEFORE
      // this run's own recovery below, so the identical-text tie resolves
      // as it does live: an obligation before the tail's own run.
      await recoverPersistedTurns(obligations, "tail started");
      sawOwnTurn = ownTurnId !== null;
      if (!sawOwnTurn && seq > 0) {
        // A tail that persisted its own turn's opening before the proof
        // could land (or a row from before the column existed): recover the
        // own turn from the persisted events BY CONTENT — a `message.received`
        // whose message hashes to this run's correlator, or (a content-less
        // send) a `turn.started` no `message.received` follows and no
        // obligation owns. Never "the last turn.started" — that may be a
        // foreign turn persisted under this run.
        const persisted = await store.listEventsAfter(runId, -1);
        const known = new Set(obligations.map((o) => o.turnId));
        let recovered: string | null = null;
        for (let i = 0; i < persisted.length; i += 1) {
          const stored = persisted[i]!.event;
          if (stored.type === "message.received") {
            if (
              ownMessageHash !== null &&
              !known.has(stored.data.turnId) &&
              hashTurnMessage(stored.data.message) === ownMessageHash
            ) {
              recovered = stored.data.turnId;
            }
          } else if (stored.type === "turn.started" && ownMessageHash === null) {
            const next = persisted[i + 1]?.event;
            const contentLess =
              next !== undefined &&
              !(next.type === "message.received" && next.data.turnId === stored.data.turnId);
            if (contentLess && !known.has(stored.data.turnId)) {
              recovered = stored.data.turnId;
            }
          }
        }
        if (recovered !== null) {
          await store.setRunTurnId(runId, recovered);
          ownTurnId = recovered;
          sawOwnTurn = true;
        }
      }
      if (closed) return;
      // CAS: a run another actor already finalized (sweeper failed it while
      // the dispatch was still in flight, or the user canceled it) must NOT
      // be resurrected to `running` — the tail simply never starts.
      const adopted = await store.markRun(runId, {
        status: "running",
        ...(seq === 0 ? { startedAt: new Date() } : {}),
      });
      if (!adopted) {
        finished = true;
        close("run already terminal");
        log?.info("run.tail_refused", {
          fields: { reason: "run already terminal — not resurrecting" },
        });
        return;
      }
      publishStatus("running");
      log?.info("run.started", {
        fields: {
          resumed: seq > 0,
          ownTurnId,
          contentLess: ownMessageHash === null,
          obligations: obligations.map((o) => o.runId),
        },
      });
    }

    /** The abort landed (close/expiry on observation, shutdown, a detach). */
    const finishAborted = async (): Promise<void> => {
      if (mode === "observe") return; // closed (confirmed / unresolved / detached)
      await finishRun("failed", null, cancelReason ?? "run tail aborted");
    };

    let attempt = 0;
    try {
      for (;;) {
        // An abort that landed BEFORE this connect (a detach or close during
        // the preamble's awaits): opening the stream with an already-aborted
        // signal would never be told to stop.
        if (detaching) return;
        if (abort.signal.aborted) {
          await finishAborted();
          return;
        }
        let consumedThisConnect = 0;
        // A `turn.started` HELD until the next event decides what the turn
        // is (module doc). Per connect: a drop re-reads it — it was never
        // persisted and the cursor never moved past it.
        let held: {
          event: Extract<EveStreamEvent, { type: "turn.started" }>;
          eventId: string | undefined;
          duplicate: boolean;
        } | null = null;
        try {
          setBusy(false); // nothing in flight behind a connect
          const response = await openStream(
            startIndex,
            abort.signal,
            requestTailIndex ? { includeTailIndex: true } : undefined,
          );
          // A close that landed during the connect (a seizure, an expiry):
          // a connect that ignored the signal must not be consumed.
          if (closed) throw new Error("tail closed during connect");
          if (!response.ok || response.body === null) {
            throw new Error(`stream returned ${response.status}`);
          }
          if (requestTailIndex) {
            requestTailIndex = false;
            const tailIndex = parseEveStreamTailIndex(
              response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER),
            );
            // Absent header (older agent / proxy that drops it) → keep the
            // count-derived cursor. `-1` is a REAL value meaning "empty
            // stream", not "unknown".
            if (tailIndex !== null) {
              if (startIndex > tailIndex + 1) {
                // Our persisted count is ahead of eve's durable truth (pruned
                // rows, a restored DB, an impossible state). Sending a cursor
                // past the end makes eve close the stream immediately, which
                // this loop can only read as a drop — reconnect forever, then
                // a spurious `failed`. Clamp to eve's truth and reconnect.
                log?.warn("run.cursor_clamped", {
                  fields: { from: startIndex, to: tailIndex + 1 },
                });
                startIndex = tailIndex + 1;
                throw new Error("cursor ahead of eve tail index — reopening");
              }
              // Only a FRESH tail can be draining a previous turn's leftovers;
              // a resuming tail's cursor already sits inside its own turn, so
              // bounding it would suppress its own terminal.
              if (seq === 0 && tailIndex >= startIndex) {
                catchUpBound = tailIndex;
                log?.info("run.catch_up", {
                  fields: { from: startIndex, throughIndex: tailIndex },
                });
              }
            }
          }

          /** Persist + publish one consumed event and advance both cursors. */
          const persist = async (
            event: EveStreamEvent,
            eventId: string | undefined,
            duplicate: boolean,
          ) => {
            if (!duplicate) {
              // Persist FIRST, count after: if appendEvent throws (transient
              // Postgres error), the reconnect resumes from the same
              // startIndex and re-consumes this event instead of silently
              // skipping it forever.
              const stored = await store.appendEvent(runId, seq, event);
              if (eventId !== undefined) seenEventIds.add(eventId);
              bus.publish(runId, {
                kind: "event",
                frame: {
                  runId,
                  seq,
                  event,
                  at: stored.at,
                  ...(eventId !== undefined ? { eventId } : {}),
                },
              });
              seq += 1;
            }
            consumedThisConnect += 1;
            startIndex += 1;
          };

          /** The own turn's opening landed: reset the per-turn latches. */
          const applyAttribution = (attribution: TurnAttribution) => {
            if (attribution !== "own") return;
            // This run's own turn boundary: leftover pending-input state
            // from a drained previous turn is historical, not ours — and it
            // ends the catch-up drain even if eve's tail index reached
            // further (eve may already have recorded our own turn).
            sawOwnTurn = true;
            pendingInput = false;
            pendingAuthorization = false;
            canceledTurn = false;
            catchUpBound = null;
          };

          for await (const event of busyMarked(ndjsonEvents(response.body))) {
            // THE FENCE: a closed tail consumes nothing further — not even
            // from a body that ignores the abort (a seized drain's stream
            // yielding late must never write a (run_id, seq) again).
            if (closed) throw new Error("tail closed — reading no further event");
            const eventId = event.meta?.id;
            // Reconnect-overlap guard. A re-read of an already-persisted
            // event advances the cursor and still drives the latches (the
            // classification may not have run before the drop) but is never
            // written or published twice.
            const duplicate = eventId !== undefined && seenEventIds.has(eventId);

            if (event.type === "turn.started") {
              // Two openings in a row cannot happen on eve's stream; if one
              // ever does, the first was content-less.
              if (held) {
                const attribution = await attributeTurn(held.event.data.turnId, null);
                await persist(held.event, held.eventId, held.duplicate);
                held = null;
                applyAttribution(attribution);
              }
              held = { event, eventId, duplicate };
              continue;
            }

            // Absolute index of THIS event in eve's session stream.
            const eventIndex = held ? startIndex + 1 : startIndex;

            // TURN ATTRIBUTION runs BEFORE the persist: the acceptance proof
            // (`turn_id`) must be on the row before the events that prove it
            // are durable, so a crash in between keeps the proof.
            if (held) {
              const heldTurnId = held.event.data.turnId;
              const content: TurnContent =
                event.type === "message.received" && event.data.turnId === heldTurnId
                  ? { hash: hashTurnMessage(event.data.message) }
                  : null;
              const attribution = await attributeTurn(heldTurnId, content);
              await persist(held.event, held.eventId, held.duplicate);
              held = null;
              applyAttribution(attribution);
              if (mode === "observe" && observationClosed) return;
            } else if (
              event.type === "message.received" &&
              !isKnownTurn(event.data.turnId)
            ) {
              // Resumed between a persisted opening and its correlator: the
              // opening was persisted only after a decision, so this is a
              // re-decision for a turn that matched nothing then (idempotent
              // — it matches nothing now, or the ledger changed).
              applyAttribution(
                await attributeTurn(event.data.turnId, {
                  hash: hashTurnMessage(event.data.message),
                }),
              );
            }

            await persist(event, eventId, duplicate);

            pendingInput = nextPendingInputRequest(pendingInput, event);
            pendingAuthorization = nextPendingAuthorization(
              pendingAuthorization,
              event,
            );
            if (!duplicate && event.type === "authorization.required") {
              // Health flip seam: a re-read duplicate never re-fires (its
              // first consume already did), and a throwing hook must never
              // become a stream error the reconnect loop misreads as a drop.
              try {
                onAuthorizationRequired?.({ connectionName: event.data.name });
              } catch (hookError) {
                log?.warn("run.authorization_hook_failed", {
                  fields: {
                    connectionName: event.data.name,
                    reason:
                      hookError instanceof Error
                        ? hookError.message
                        : String(hookError),
                  },
                });
              }
            }
            if (sawOwnTurn && event.type === "turn.cancelled") {
              // Latched, not terminal: `session.waiting` always follows and is
              // what actually finishes the run.
              canceledTurn = true;
            }
            if (
              sawOwnTurn &&
              event.type === "message.completed" &&
              event.data.finishReason === "stop" &&
              typeof event.data.message === "string"
            ) {
              lastAssistantMessage = event.data.message;
            }

            // OBLIGATION BOUNDARIES (eve's OWN confirmation): a turn boundary
            // carrying an owned obligation's turn id meets it; a session
            // boundary means no turn is in flight, so every OWNED obligation
            // is over — and a dead session (`session.completed`/`failed`)
            // can never start an unowned one either. The owner match reads
            // the CURRENT obligations (an obligation settled without a tail
            // whose turn a previous reader attributed is owned too), on the
            // serial queue so no settlement interleaves with it.
            if (isTurnBoundaryEvent(event)) {
              await serialized(async () => {
                await refreshObligationsUnlocked("turn boundary");
                const owned = obligations.find((o) => o.turnId === event.data.turnId);
                if (owned) await confirmObligation(owned, event.type);
              });
            } else if (
              event.type === "session.waiting" ||
              event.type === "session.completed" ||
              event.type === "session.failed"
            ) {
              await serialized(async () => {
                await refreshObligationsUnlocked("session boundary");
                for (const obligation of [...obligations]) {
                  if (obligation.turnId !== null || event.type !== "session.waiting") {
                    await confirmObligation(obligation, event.type);
                  }
                }
              });
            }
            if (mode === "observe") {
              if (observationClosed) return;
              continue;
            }

            // The catch-up window closes either at eve's attach-time tail
            // index or at our own turn, whichever comes first. It is logged,
            // not enforced: the TURN gate below is what actually suppresses
            // classification, because eve may already have durably recorded
            // this run's own turn before we attached — a bound-only rule
            // would swallow our own terminal and hang the run.
            if (catchUpBound !== null && eventIndex >= catchUpBound) {
              log?.info("run.catch_up_complete", {
                fields: { drained: eventIndex - (catchUpBound ?? 0) + 1 },
              });
              catchUpBound = null;
            }

            // LEFTOVER GATE: until this run's own turn lands, every event is
            // a previous (or foreign) turn's — persisted (counts stay
            // aligned) but never classified, or the drained
            // `turn.completed`/`session.waiting` would instantly mark this run
            // succeeded. `session.failed` is session-fatal and always counts.
            const terminal =
              sawOwnTurn || event.type === "session.failed"
                ? classifyTerminal(event, {
                    pendingInputRequest: pendingInput,
                    pendingAuthorization,
                    canceledTurn,
                  })
                : null;
            if (terminal) {
              // Close FIRST (synchronously): the reader slot is free before
              // the row settles, so a settlement signal landing during the
              // writes below finds no reader and opens its own observer.
              close(`terminal: ${terminal.runStatus}`);
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
          held = null; // never persisted, cursor never advanced: re-read on reconnect
          if (detaching) return; // failover / handover: leave the row alone
          if (abort.signal.aborted) {
            await finishAborted();
            return;
          }
          attempt = consumedThisConnect > 0 ? 1 : attempt + 1;
          if (attempt > maxReconnectAttempts) {
            close("reconnect attempts exhausted");
            if (mode === "observe") {
              // The obligation stays on the row; the sweeper re-opens the
              // observation (a dead agent/worker cannot be observed here).
              log?.warn("run.observation_lost", {
                fields: {
                  reconnectAttempts: maxReconnectAttempts,
                  obligations: obligations.map((o) => o.runId),
                  reason: error instanceof Error ? error.message : String(error),
                },
              });
              return;
            }
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
            await finishAborted();
            return;
          }
        }
      }
    } finally {
      if (wallClockTimer) clearTimeout(wallClockTimer);
      if (observeTimer) clearTimeout(observeTimer);
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    }
  };

  /** Marks the tail busy while the consumer handles each yielded event. */
  async function* busyMarked(
    events: AsyncIterable<EveStreamEvent>,
  ): AsyncGenerator<EveStreamEvent> {
    try {
      for await (const event of events) {
        setBusy(true);
        yield event;
        setBusy(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const done = (async () => {
    try {
      await run();
    } finally {
      // Backstop: any exit not closed at its start (a preamble store
      // failure rejecting `done`) closes here, before `done` settles.
      close("tail exited");
      setBusy(false);
    }
  })();

  const detach = () => {
    detaching = true;
    close("detached");
  };

  const seize = (): Promise<void> => {
    close("seized by a successor tail");
    if (!busy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  };

  return {
    runId,
    agentSessionId,
    get observing() {
      return mode === "observe";
    },
    get closed() {
      return closed;
    },
    onceClosed,
    done,
    async cancel(reason, options) {
      cancelReason ??= reason ?? "run canceled";
      if (mode === "observe") {
        // A duplicate Stop on an observation tail has nothing left to
        // finalize; shutdown DETACHES it — the obligation is durable and the
        // next boot's sweeper re-opens the observation.
        if (options?.status !== "canceled") detach();
        return "pending";
      }
      if (options?.status !== "canceled") {
        // SHUTDOWN: settle the row `failed` WITH its obligation (a qualified
        // cancel if the turn is known, nothing if not — never unqualified)
        // and abort; the process cannot observe, the next boot's sweeper can.
        return settleAndObserve("failed", cancelReason, { observe: false });
      }
      // USER STOP: the remote leg is turn-QUALIFIED or not sent at all, the
      // row finalizes `canceled` with the obligation, and the tail stays on
      // the stream in observation mode.
      return settleAndObserve("canceled", cancelReason, {
        awaitRemote: options?.awaitRemote ?? false,
        observe: true,
      });
    },
    detach,
    seize,
    refreshObligations: () =>
      serialized(async () => {
        // A closed tail re-reads nothing and can act on nothing: say so,
        // never "handed off" — the caller opens its own observer. Checked
        // AGAIN after the re-read: a terminal or an expiry landing during
        // it leaves the row for the caller's own observer to load.
        if (closed) return false;
        await refreshObligationsUnlocked("signaled");
        return !closed;
      }),
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

export interface StartTailOptions {
  runId: string;
  agentSessionId: string;
  openStream: OpenRunStream;
  cancelRemoteTurn?: CancelRemoteTurn;
  /** Per-run health seam (see {@link TailRunOptions.onAuthorizationRequired}). */
  onAuthorizationRequired?: (info: { connectionName: string }) => void;
}

export class RunTailerManager {
  private readonly handles = new Map<string, RunTailHandle>();
  /**
   * ONE reader per eve stream: the LIVE tail (any mode) per session. A tail
   * leaves this slot the instant it closes (`onClose`, synchronous — an
   * abort, its natural terminal, reconnect exhaustion alike) — it reads
   * nothing more and can adopt nothing, so a settlement arriving before its
   * `done` resolves must not be handed to it.
   */
  private readonly sessionHandles = new Map<string, RunTailHandle>();
  /**
   * Tails that have closed but whose `done` is still pending: the stream is
   * RELEASED only when `done` resolves (the body reader may still be inside
   * a read, or a connect may still be hanging), so a successor on the
   * session chains on it (`chainBehind`) rather than opening a second
   * cursor — bounded: a drain that outlives `streamTakeoverMs` is seized by
   * the successor — and the context controls count it as a holder of the
   * stream until then. A LIST per session, in close order: a successor that
   * seized a hung drain and then closed itself is a second draining tail on
   * the same session (one slot would overwrite the first and lose its
   * still-held stream); chaining goes behind the latest.
   */
  private readonly drainingHandles = new Map<string, RunTailHandle[]>();

  constructor(
    private readonly defaults: {
      store: RunStore;
      bus: RunEventBus;
      maxWallClockMs: number;
      remoteCancelObserveMs?: number;
      streamTakeoverMs?: number;
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
      /** Metrics seam propagated to every tail (run-duration histogram). */
      onFinish?: RunFinishedHook;
      /** Structured run-lifecycle logger propagated to every tail. */
      logger?: Logger;
    },
  ) {}

  /** The latest tail still draining the session's stream, if any. */
  private latestDraining(agentSessionId: string): RunTailHandle | undefined {
    const draining = this.drainingHandles.get(agentSessionId);
    return draining?.[draining.length - 1];
  }

  /** The tail currently holding the session's stream, live or draining. */
  private streamHolder(agentSessionId: string): RunTailHandle | undefined {
    return this.sessionHandles.get(agentSessionId) ?? this.latestDraining(agentSessionId);
  }

  /** Move a tail from the reader slot to the draining list (it closed). */
  private releaseReader(handle: RunTailHandle): void {
    if (this.sessionHandles.get(handle.agentSessionId) === handle) {
      this.sessionHandles.delete(handle.agentSessionId);
      const draining = this.drainingHandles.get(handle.agentSessionId) ?? [];
      draining.push(handle);
      this.drainingHandles.set(handle.agentSessionId, draining);
    }
  }

  /** The tail's `done` resolved: its stream is released. */
  private releaseStream(handle: RunTailHandle): void {
    const draining = this.drainingHandles.get(handle.agentSessionId);
    if (!draining) return;
    const remaining = draining.filter((h) => h !== handle);
    if (remaining.length === 0) this.drainingHandles.delete(handle.agentSessionId);
    else this.drainingHandles.set(handle.agentSessionId, remaining);
  }

  private open(
    options: StartTailOptions & Pick<TailRunOptions, "observe" | "chainBehind">,
  ): RunTailHandle {
    let handle: RunTailHandle | undefined;
    const opened = tailRun({
      ...this.defaults,
      ...options,
      onClose: () => {
        if (handle) this.releaseReader(handle);
      },
    });
    handle = opened;
    this.handles.set(handle.runId, handle);
    this.sessionHandles.set(handle.agentSessionId, handle);
    void handle.done.finally(() => {
      if (this.handles.get(opened.runId) === opened) this.handles.delete(opened.runId);
      this.releaseReader(opened);
      this.releaseStream(opened);
    });
    return handle;
  }

  /**
   * Start (or return) the live tail for a run. A session may have ONE
   * reader: an observation tail already on this session is detached and the
   * new tail waits for it to stop before reading — it inherits the session's
   * open obligations through its leftover drain (tailer module doc). A tail
   * still draining (closed, stream not yet released) is chained on the
   * same way — bounded by `streamTakeoverMs`, after which the successor
   * seizes the hung drain and takes its cursor over.
   */
  start(options: StartTailOptions): RunTailHandle {
    const existing = this.handles.get(options.runId);
    if (existing) return existing;
    const prior = this.sessionHandles.get(options.agentSessionId);
    const draining = this.latestDraining(options.agentSessionId);
    let chainBehind: ChainedStream | undefined;
    if (prior) {
      if (prior.observing) {
        this.defaults.logger?.info("run.observation_handover", {
          runId: options.runId,
          sessionId: options.agentSessionId,
          fields: { observedRunId: prior.runId },
        });
        prior.detach();
      } else {
        // Two live runs on one session is what admission forbids; chain
        // rather than open a second cursor on the same stream.
        this.defaults.logger?.warn("run.tail_chained", {
          runId: options.runId,
          sessionId: options.agentSessionId,
          fields: { priorRunId: prior.runId },
        });
      }
      chainBehind = prior;
    } else if (draining) {
      this.defaults.logger?.info("run.tail_drain_wait", {
        runId: options.runId,
        sessionId: options.agentSessionId,
        fields: { drainingRunId: draining.runId },
      });
      chainBehind = draining;
    }
    return this.open({ ...options, chainBehind });
  }

  /**
   * Re-open OBSERVATION for a settled run still owing eve a confirmation
   * (the sweeper, boot reconciliation, the post-eve recheck). Null when the
   * session's LIVE tail took the obligation over — it is signaled to re-read
   * the session's obligations, and only a signal it actually acted on counts
   * (`refreshObligations` resolves false once the tail has closed: such a
   * tail reads nothing more, and trusting the handoff would leave the run
   * with no reader until the next sweep). Otherwise a new observation tail
   * is opened — chained behind a tail still draining the stream, so there
   * is never a second cursor, with its observation deadline already armed
   * and the chain wait bounded — and returned. Async because the handoff is
   * awaited; the caller counts the run `observing` either way.
   */
  async observe(options: StartTailOptions & { deadlineAt: number }): Promise<RunTailHandle | null> {
    const existing = this.handles.get(options.runId);
    if (existing && !existing.closed) return existing;
    // Bounded: a live tail that aborts under the signal is released
    // synchronously, so the next iteration finds none (or one another
    // caller opened meanwhile — which is then a live reader to signal).
    for (let round = 0; round < 3; round += 1) {
      const live = this.sessionHandles.get(options.agentSessionId);
      if (!live) break;
      if (await this.refreshSessionObligations(options.agentSessionId)) return null;
    }
    const { deadlineAt, ...rest } = options;
    const draining = this.latestDraining(options.agentSessionId);
    if (draining) {
      this.defaults.logger?.info("run.tail_drain_wait", {
        runId: options.runId,
        sessionId: options.agentSessionId,
        fields: { drainingRunId: draining.runId },
      });
    }
    return this.open({ ...rest, observe: { deadlineAt }, chainBehind: draining });
  }

  get(runId: string): RunTailHandle | undefined {
    return this.handles.get(runId);
  }

  /**
   * Is a LIVE tail (follow or observation — one that still reads) on this
   * session in this process? A closed tail is not: it can carry no
   * obligation from here on.
   */
  hasSessionTail(agentSessionId: string): boolean {
    return this.sessionHandles.has(agentSessionId);
  }

  /**
   * Is the session's eve stream HELD in this process — by a live tail, or
   * by a closed one whose `done` has not resolved (its cursor is not
   * released yet)? The context controls' quiet check: a second reader must
   * not attach until the stream is released.
   */
  isSessionStreamHeld(agentSessionId: string): boolean {
    return this.streamHolder(agentSessionId) !== undefined;
  }

  /**
   * Signal the session's live tail (any mode) that the session's open
   * obligations changed — a Stop settled without a tail while this tail
   * holds the stream (the guarded settlement's `observing` verdict). The
   * tail re-reads the store and adopts the new obligation, issuing its
   * qualified cancel at once when the turn is already known. Resolves false
   * when no LIVE tail is on the session in this process — none at all, or
   * one that closed before (or while) the signal reached it: the caller
   * must then open its own observer, never count the handoff.
   */
  async refreshSessionObligations(agentSessionId: string): Promise<boolean> {
    const handle = this.sessionHandles.get(agentSessionId);
    if (!handle) return false;
    try {
      return await handle.refreshObligations();
    } catch (error) {
      // The tail is live and re-reads the store at its next turn opening
      // and boundary regardless — still the session's reader.
      this.defaults.logger?.warn("run.obligations_refresh_failed", {
        runId: handle.runId,
        sessionId: agentSessionId,
        fields: { reason: error instanceof Error ? error.message : String(error) },
      });
      return !handle.closed;
    }
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
   * Cancel a specific run's live tail (user abort), marking it `canceled`.
   * Returns true once the row is finalized; false when the run had no active
   * tail (parked/queued/terminal — the caller marks the row directly). The
   * tail then OBSERVES eve's stream for the turn boundary (tailer doc) — the
   * cancellation is cooperative at durable step boundaries, so "stopped"
   * never means "undone", and the row is finalized without waiting for eve's
   * `turn.cancelled`.
   */
  async cancelRun(runId: string, reason?: string): Promise<boolean> {
    const handle = this.handles.get(runId);
    if (!handle || handle.observing) return false;
    await handle.cancel(reason, { status: "canceled" });
    return true;
  }

  /**
   * The cancel route's shape of {@link cancelRun}: the turn-qualified remote
   * cancel (when the turn is known) is awaited BEFORE the row finalizes, and
   * the remote outcome is reported once the row is finalized — NOT once the
   * observation that follows has ended. Null when the run had no live tail.
   */
  async cancelRunGuarded(
    runId: string,
    reason: string,
    options: Pick<CancelOptions, "awaitRemote"> = {},
  ): Promise<RemoteCancelOutcome | null> {
    const handle = this.handles.get(runId);
    if (!handle || handle.observing) return null;
    return handle.cancel(reason, { status: "canceled", ...options });
  }

  /** Number of live tails, observation tails included (observability/tests). */
  get activeCount(): number {
    return this.handles.size;
  }

  async stopAll(reason = "control plane shutting down"): Promise<void> {
    const all = [...this.handles.values()];
    for (const handle of all) void handle.cancel(reason);
    await Promise.allSettled(all.map((handle) => handle.done));
  }
}
