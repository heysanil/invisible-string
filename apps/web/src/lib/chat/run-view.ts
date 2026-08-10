/**
 * The chat thread's run state machine — a PURE reduction from a run row +
 * its ordered `run_events` frames to the view model the thread renders:
 *
 *   user message → an ORDERED TIMELINE of segments
 *               → pending HITL inputs → error
 *
 * A run is `segments`, in the order the agent produced them: a
 * {@link WorkSegment} is a contiguous stretch of interior work (thoughts and
 * tool calls, one rail in one collapsible box) and a {@link SpeechSegment} is
 * one assistant utterance. Assistant text CLOSES the open work segment, so
 * later work opens a new one below — mid-run narration therefore renders where
 * it happened instead of being hoisted to the end.
 *
 * Two eve emitter facts drive the keys (spike/REPORT.md findings 30–33):
 * `(turnId, stepIndex)` is NOT unique for reasoning OR for messages — the
 * emitter resets its accumulator on every text delta / tool flush — so a key
 * that has already SEALED (a `reasoning.completed` / `message.completed`
 * landed) sends the next block to `${key}#2`, `#3`, … Sealing happens AFTER the
 * key is resolved, so a completion always lands on its own open block. A tool
 * call does NOT split a reasoning block; only text does, and a step's
 * `reasoning.completed` legitimately arrives after that step's tool events —
 * never seal a thought on the next tool call.
 *
 * Items are addressed GLOBALLY (`itemOwner`), not within the open segment:
 * an `action.result`/`action.partial` for a call issued before the agent spoke,
 * and durable step RETRIES that re-emit an entire sequence, both update the
 * item in place wherever it already lives rather than duplicating it into a
 * fresh box.
 *
 * Everything here is deterministic and side-effect free so the same code
 * path serves the live SSE stream, replayed history, tests and the fixture
 * mode. Frames are deduped + ordered by `seq` in {@link FrameStore} — seq is
 * authoritative (SSE resume can re-deliver frames; reducers never double
 * apply).
 *
 * CANCELLATION IS NOT FAILURE (eve 0.31). A stopped turn emits
 * `turn.cancelled` → `session.waiting` and NEVER `turn.failed` /
 * `session.failed`, so `turn.cancelled` must never reach the failure arm:
 * it freezes the run's output in place (whatever streamed before the stop
 * stays rendered), retires every unanswered input request, and lets the
 * session accept the next message normally.
 */
import {
  EVE_INPUT_REQUEST_KINDS,
  isRunSettledStatus,
  type EveInputRequest,
  type EveInputRequestKind,
  type EveJsonValue,
  type EveStreamEvent,
  type RunDto,
  type RunEventFrame,
  type RunStatus,
} from "@invisible-string/shared";

// ── Frame store (seq-deduped, ordered) ──────────────────────────────────────

export interface FrameStore {
  /** Sorted by seq ascending; one frame per seq. */
  readonly frames: readonly RunEventFrame[];
  /** Highest seq seen; -1 when empty. The SSE resume cursor. */
  readonly maxSeq: number;
}

export const EMPTY_FRAME_STORE: FrameStore = { frames: [], maxSeq: -1 };

/**
 * Insert a frame, ignoring duplicates by seq. Returns the SAME store object
 * when the frame was already present, so React state setters and memos can
 * bail out on identity.
 */
export function addFrame(store: FrameStore, frame: RunEventFrame): FrameStore {
  if (frame.seq > store.maxSeq) {
    // Fast path: in-order append (the common streaming case).
    return { frames: [...store.frames, frame], maxSeq: frame.seq };
  }
  if (store.frames.some((existing) => existing.seq === frame.seq)) return store;
  const frames = [...store.frames, frame].sort((a, b) => a.seq - b.seq);
  return { frames, maxSeq: store.maxSeq };
}

export function addFrames(
  store: FrameStore,
  frames: readonly RunEventFrame[],
): FrameStore {
  let next = store;
  for (const frame of frames) next = addFrame(next, frame);
  return next;
}

// ── View model ──────────────────────────────────────────────────────────────

export type StepState =
  | "pending"
  | "awaiting"
  | "ok"
  | "error"
  | "rejected"
  /** The turn was stopped before this call settled — no result will arrive. */
  | "canceled";

export interface PendingInputView {
  requestId: string;
  prompt: string;
  /**
   * eve's framework-owned discriminator (0.31) — the ONLY thing presentation
   * may route on. Never re-infer intent from `toolName`: a session-limit
   * prompt rides a synthetic `session_limit_continuation` "tool" that must not
   * render as a tool approval.
   */
  kind: EveInputRequestKind;
  /** Tool the approval gates (null for questions and session-limit prompts). */
  toolName: string | null;
  /** Tool input args, pre-rendered as compact JSON for the card. */
  argsPreview: string | null;
  options: readonly {
    id: string;
    label: string;
    /** eve's per-option help text (used by the session-limit prompt). */
    description?: string;
    style?: string;
  }[];
  allowFreeform: boolean;
  display: "confirmation" | "select" | "text";
}

export interface ThoughtItem {
  kind: "thought";
  /** `${turnId}:${stepIndex}`, plus `#2`, `#3`… once that key has sealed. */
  key: string;
  text: string;
  /** Wall-clock seconds for this pass; null while streaming or unmeasurable. */
  seconds: number | null;
  streaming: boolean;
}

export interface ToolItem {
  kind: "tool";
  /** Tool call id. */
  key: string;
  toolName: string;
  state: StepState;
  resultPreview: string | null;
}

export type TimelineItem = ThoughtItem | ToolItem;

export interface SpeechSegment {
  kind: "speech";
  /** `say:${turnId}:${stepIndex}`, plus `#2`, `#3`… once that key has sealed. */
  key: string;
  text: string;
  streaming: boolean;
}

export interface WorkSegment {
  kind: "work";
  /** `work:${first item's key}`. */
  key: string;
  items: readonly TimelineItem[];
  /** Span of THIS segment's own frames, floored at 1s; null under two frames. */
  elapsedSeconds: number | null;
  /** First frame's `at` — the component ticks its live counter from this. */
  startedAt: string | null;
  /** Accepting items right now. Drives the spinner + counter. */
  active: boolean;
  /** Blocked on the user. */
  waiting: boolean;
  /** A later segment exists — the auto-fold cue. */
  sealed: boolean;
}

export type RunSegment = SpeechSegment | WorkSegment;

export interface RunView {
  runId: string;
  status: RunStatus;
  /** The inbound user/trigger message that started this run. */
  userMessage: string;
  /** The run's top-level chronology. Empty when nothing has streamed yet. */
  segments: readonly RunSegment[];
  /** Unanswered `input.requested` entries (approval cards / questions). */
  pendingInputs: readonly PendingInputView[];
  error: string | null;
  /** Resolved model id from session.started (thread header chip). */
  modelId: string | null;
  /**
   * The run's turn was STOPPED by a user (`turn.cancelled`). Derived from the
   * event stream, so it is true the instant the frame lands — a beat before
   * the `run_status: canceled` frame — and it is never an error state.
   */
  canceled: boolean;
  /**
   * A `context.cleared` landed inside this run's frames: the agent's durable
   * model history was dropped while this run's tail was attached. The
   * transcript above stays readable; the agent simply no longer remembers it.
   */
  contextCleared: boolean;
}

// ── Reduction ───────────────────────────────────────────────────────────────

const PREVIEW_MAX = 200;

/** Compact one-line preview of a tool result / args value. */
export function previewValue(value: EveJsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

const KNOWN_INPUT_KINDS: ReadonlySet<string> = new Set(EVE_INPUT_REQUEST_KINDS);

/**
 * eve's synthetic "tool" behind a session-limit continuation prompt
 * (`session-limit-continuation.js`). It is an implementation detail of the
 * budget guardrail, never a tool the user asked for, so it must not surface
 * as a tool chip.
 */
const SESSION_LIMIT_TOOL_NAME = "session_limit_continuation";

/**
 * Read the request's `kind`. eve 0.31 makes it REQUIRED, but `run_events`
 * rows persisted by 0.19-era agents are still replayed forever (SSE history,
 * an old thread reopened), and those carry no discriminator — so fall back to
 * the only signal those rows have rather than mislabelling every one of them
 * as a tool approval.
 */
export function inputRequestKindOf(
  request: EveInputRequest,
): EveInputRequestKind {
  const raw: unknown = (request as { kind?: unknown }).kind;
  if (typeof raw === "string" && KNOWN_INPUT_KINDS.has(raw)) {
    return raw as EveInputRequestKind;
  }
  return request.action?.toolName === "ask_question"
    ? "question"
    : "tool-approval";
}

function pendingInputFromRequest(request: EveInputRequest): PendingInputView {
  const kind = inputRequestKindOf(request);
  const toolName = request.action?.toolName ?? null;
  // A question's gating "tool" is `ask_question` and a session-limit prompt's
  // is eve's budget shim — neither is a tool call the user is approving, so
  // neither gets the tool chip + args preview treatment.
  const showsTool =
    kind === "tool-approval" && toolName !== SESSION_LIMIT_TOOL_NAME;
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    kind,
    toolName: showsTool ? toolName : null,
    argsPreview: showsTool ? previewValue(request.action?.input ?? null) : null,
    options: (request.options ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      style: option.style,
    })),
    allowFreeform: request.allowFreeform ?? false,
    display: request.display ?? (request.options?.length ? "select" : "text"),
  };
}

/**
 * Reduce a run + its frames to the thread view model.
 *
 * `statusOverride` lets the live layer apply a fresher `run_status` frame than
 * the fetched row carries — but ONLY while the row is unsettled. A SETTLED row
 * always wins, because the live layer cannot be fresher than one: the server
 * closes the tail at every stream-terminal status, so nothing can arrive after
 * it.
 *
 * The case that forces this: a run parked on HITL input closes its stream at
 * `waiting`, freezing the live status there permanently. Stopping that run
 * settles the ROW to `canceled` with no stream left to announce it — so a
 * naive `statusOverride ?? run.status` would keep rendering the stale
 * `waiting` forever (approval card still answerable, composer stuck disabled,
 * no stopped-notice) until the user navigates away. See isRunSettledStatus.
 */
export function reduceRunView(
  run: Pick<RunDto, "id" | "status" | "triggerEvent" | "error">,
  store: FrameStore,
  statusOverride?: RunStatus,
): RunView {
  const status = isRunSettledStatus(run.status)
    ? run.status
    : (statusOverride ?? run.status);

  type WorkBuilder = {
    kind: "work";
    key: string;
    items: TimelineItem[];
    firstAt: string;
    lastAt: string;
    /**
     * Frames attributed to this segment. Needed because two frames landing in
     * the SAME millisecond are indistinguishable from one frame by timestamps
     * alone, and the two cases report different durations (see the elapsed
     * computation below).
     */
    frames: number;
  };
  type SpeechBuilder = {
    kind: "speech";
    key: string;
    text: string;
    completed: boolean;
  };
  type SegBuilder = WorkBuilder | SpeechBuilder;

  const segments: SegBuilder[] = [];
  /** EVERY item ever seen, wherever it lives — the global-upsert index. */
  const itemOwner = new Map<string, { seg: WorkBuilder; item: TimelineItem }>();
  const speechByKey = new Map<string, SpeechBuilder>();
  const thoughtSpan = new Map<string, { first: string; last: string }>();
  const sealedThoughts = new Set<string>();
  const sealedSpeech = new Set<string>();
  let current: WorkBuilder | null = null;

  const pendingByRequest = new Map<
    string,
    { view: PendingInputView; callId: string | null }
  >();

  let userMessage = run.triggerEvent.message;
  let error: string | null = run.error;
  let modelId: string | null = null;
  let canceled = false;
  let contextCleared = false;

  /**
   * Keyless append-type frames extend the currently open item of that kind.
   * 0.19-era `run_events` rows carry no `stepIndex` and are replayed forever;
   * a per-frame key would render one item per delta.
   */
  let openThoughtKey: string | null = null;
  let openSpeechBase: string | null = null;

  /** The live key for a base: skip forward past any sealed ordinal. */
  const liveKey = (base: string, sealed: ReadonlySet<string>) => {
    let key = base;
    let n = 1;
    while (sealed.has(key)) {
      n += 1;
      key = `${base}#${n}`;
    }
    return key;
  };

  const pushItem = (item: TimelineItem, at: string) => {
    let seg = current;
    if (seg === null) {
      seg = {
        kind: "work",
        key: `work:${item.key}`,
        items: [],
        firstAt: at,
        lastAt: at,
        frames: 0,
      };
      segments.push(seg);
      current = seg;
    }
    seg.items.push(item);
    seg.lastAt = at;
    seg.frames += 1;
    itemOwner.set(item.key, { seg, item });
  };

  /** In-place update wherever the item lives — even a segment closed long ago. */
  const updateItem = (key: string, next: TimelineItem, at: string): boolean => {
    const owner = itemOwner.get(key);
    if (owner === undefined) return false;
    const index = owner.seg.items.indexOf(owner.item);
    owner.seg.items[index] = next;
    owner.seg.lastAt = at;
    owner.seg.frames += 1;
    itemOwner.set(key, { seg: owner.seg, item: next });
    return true;
  };

  const upsertTool = (
    callId: string,
    toolName: string,
    state: StepState,
    resultPreview: string | null,
    at: string,
  ) => {
    const next: ToolItem = {
      kind: "tool",
      key: callId,
      toolName,
      state,
      resultPreview,
    };
    if (!updateItem(callId, next, at)) pushItem(next, at);
  };

  const toolItemFor = (callId: string): ToolItem | undefined => {
    const owner = itemOwner.get(callId);
    if (owner === undefined || owner.item.kind !== "tool") return undefined;
    return owner.item;
  };

  /** Assistant text. Opens a speech segment, which CLOSES the current work one. */
  const upsertSpeech = (base: string, text: string, complete: boolean) => {
    const key = liveKey(`say:${base}`, sealedSpeech);
    const existing = speechByKey.get(key);
    if (existing === undefined) {
      const seg: SpeechBuilder = {
        kind: "speech",
        key,
        text,
        completed: complete,
      };
      segments.push(seg);
      speechByKey.set(key, seg);
      current = null;
    } else {
      existing.text = text;
      existing.completed = existing.completed || complete;
    }
    if (complete) sealedSpeech.add(key);
  };

  const resolveInputsForCall = (callId: string) => {
    for (const [requestId, entry] of pendingByRequest) {
      if (entry.callId === callId) pendingByRequest.delete(requestId);
    }
  };

  /**
   * Every unanswered request is stale once the turn is cancelled or the
   * context is cleared — answering one would post a dead requestId that eve
   * replays to the model as an ordinary user message.
   */
  const retirePendingInputs = () => {
    pendingByRequest.clear();
  };

  for (const frame of store.frames) {
    const event = frame.event as EveStreamEvent;
    switch (event.type) {
      case "session.started":
        modelId = event.data.runtime?.modelId ?? modelId;
        break;
      case "message.received":
        userMessage = event.data.message;
        break;
      case "actions.requested":
        for (const action of event.data.actions) {
          if (!itemOwner.has(action.callId)) {
            pushItem(
              {
                kind: "tool",
                key: action.callId,
                toolName: action.toolName,
                state: "pending",
                resultPreview: null,
              },
              frame.at,
            );
          }
        }
        break;
      case "input.requested":
        for (const request of event.data.requests) {
          const callId = request.action?.callId ?? null;
          pendingByRequest.set(request.requestId, {
            view: pendingInputFromRequest(request),
            callId,
          });
          if (callId !== null) {
            const step = toolItemFor(callId);
            if (step !== undefined && step.state === "pending") {
              updateItem(callId, { ...step, state: "awaiting" }, frame.at);
            }
          }
        }
        break;
      // Preliminary tool output while a long call is still running:
      // last-write-wins per callId, never terminal for the step.
      case "action.partial": {
        const { result } = event.data;
        const existing = toolItemFor(result.callId);
        // Never walk a settled step backwards. eve emits partials before the
        // result, but a durable step RETRY re-emits the whole sequence, so a
        // partial can legitimately arrive after this call already resolved.
        if (
          existing !== undefined &&
          existing.state !== "pending" &&
          existing.state !== "awaiting"
        ) {
          break;
        }
        upsertTool(
          result.callId,
          result.toolName,
          existing?.state ?? "pending",
          previewValue(result.output),
          frame.at,
        );
        break;
      }
      case "action.result": {
        const { result, status: resultStatus, error: resultError } = event.data;
        const state: StepState =
          resultStatus === "completed"
            ? "ok"
            : resultStatus === "rejected"
              ? "rejected"
              : "error";
        const preview =
          state === "ok"
            ? previewValue(result.output)
            : (resultError?.message ?? previewValue(result.output) ?? "Failed");
        upsertTool(result.callId, result.toolName, state, preview, frame.at);
        resolveInputsForCall(result.callId);
        break;
      }
      case "reasoning.appended": {
        const { turnId, reasoningSoFar } = event.data;
        const stepIndex: number | undefined = event.data.stepIndex;
        // Annotated: the assignment back into `openThoughtKey` below would
        // otherwise make this initializer circular for inference.
        const key: string =
          stepIndex === undefined
            ? (openThoughtKey ?? `legacy:${frame.seq}`)
            : liveKey(`${turnId}:${stepIndex}`, sealedThoughts);
        if (stepIndex === undefined) openThoughtKey = key;
        const span = thoughtSpan.get(key);
        thoughtSpan.set(key, { first: span?.first ?? frame.at, last: frame.at });
        const next: ThoughtItem = {
          kind: "thought",
          key,
          text: reasoningSoFar,
          seconds: null,
          streaming: true,
        };
        if (!updateItem(key, next, frame.at)) pushItem(next, frame.at);
        break;
      }
      case "reasoning.completed": {
        const { turnId, reasoning } = event.data;
        const stepIndex: number | undefined = event.data.stepIndex;
        const key =
          stepIndex === undefined
            ? (openThoughtKey ?? `legacy:${frame.seq}`)
            : liveKey(`${turnId}:${stepIndex}`, sealedThoughts);
        if (stepIndex === undefined) openThoughtKey = null;
        const span = thoughtSpan.get(key);
        const first = span?.first ?? frame.at;
        const ms = Date.parse(frame.at) - Date.parse(first);
        const seconds =
          Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null;
        const next: ThoughtItem = {
          kind: "thought",
          key,
          text: reasoning,
          seconds,
          streaming: false,
        };
        if (!updateItem(key, next, frame.at)) pushItem(next, frame.at);
        // Seal AFTER resolving the key, so this completion lands on the open
        // block rather than skipping ahead to a fresh ordinal.
        sealedThoughts.add(key);
        break;
      }
      case "message.appended": {
        const { turnId, messageSoFar } = event.data;
        const stepIndex: number | undefined = event.data.stepIndex;
        if (messageSoFar.trim().length > 0) {
          const base: string =
            stepIndex === undefined
              ? (openSpeechBase ?? `legacy:${frame.seq}`)
              : `${turnId}:${stepIndex}`;
          if (stepIndex === undefined) openSpeechBase = base;
          upsertSpeech(base, messageSoFar, false);
        }
        break;
      }
      case "message.completed": {
        const { turnId, message } = event.data;
        const stepIndex: number | undefined = event.data.stepIndex;
        // A null/blank completion is eve's empty-delivery sentinel: it creates
        // no segment and therefore does not close the current work segment.
        if (message !== null && message.trim().length > 0) {
          const base =
            stepIndex === undefined
              ? (openSpeechBase ?? `legacy:${frame.seq}`)
              : `${turnId}:${stepIndex}`;
          upsertSpeech(base, message, true);
        }
        if (stepIndex === undefined) openSpeechBase = null;
        break;
      }
      // A USER DECISION, NEVER AN ERROR — deliberately its own arm, far from
      // the failure arm below, so it can never leak into `error`. eve stops
      // at the next durable step boundary (a tool already in flight still
      // lands its `action.result`), then emits `session.waiting`; whatever
      // streamed before the stop stays on screen, frozen.
      case "turn.cancelled": {
        canceled = true;
        retirePendingInputs();
        for (const [key, owner] of [...itemOwner]) {
          const { item } = owner;
          if (
            item.kind === "tool" &&
            (item.state === "pending" || item.state === "awaiting")
          ) {
            updateItem(key, { ...item, state: "canceled" }, frame.at);
          }
        }
        break;
      }
      // Durable model history dropped (the Clear context action). The
      // transcript stays readable; only the agent's memory of it is gone.
      case "context.cleared":
        contextCleared = true;
        retirePendingInputs();
        break;
      case "step.failed":
      case "turn.failed":
      case "session.failed":
        error = event.data.message;
        break;
      default:
        break;
    }
  }

  // A stream still in flight at the end of the frames IS the text so far, and
  // a cancelled turn's partial text is FINAL — the moment `turn.cancelled`
  // lands, `runLive` is false, so every caret freezes without waiting for the
  // status frame.
  const runLive = !canceled && (status === "queued" || status === "running");

  // Pending inputs only matter while the run is parked or still active —
  // a terminal run has nothing left to answer. `turn.cancelled` already
  // retired them above; this also covers a run whose status settled first.
  const pendingInputs =
    !canceled && (status === "waiting" || runLive)
      ? [...pendingByRequest.values()].map((entry) => entry.view)
      : [];

  const lastIndex = segments.length - 1;
  const outSegments: RunSegment[] = segments.map((seg, index) => {
    if (seg.kind === "speech") {
      return {
        kind: "speech",
        key: seg.key,
        text: seg.text,
        streaming: !seg.completed && runLive,
      };
    }
    // FLOOR AT ONE SECOND, and key the null case off the frame COUNT, not the
    // span. A segment is often a single tool call whose request and result land
    // inside the same millisecond — measuring `ms > 0` there would report no
    // duration at all and the summary would degrade from "Worked for 1s · 1
    // step" to "Worked · 1 step". Only a genuinely unmeasurable segment (one
    // frame) has no duration. Pre-segment code got this for free by spanning
    // the whole run; per-segment spans are short enough that it must be
    // explicit. Guard: the two elapsed tests in run-view.test.ts, plus
    // e2e/specs/agent-workflow.e2e.ts:111 which asserts the exact label.
    const ms = Date.parse(seg.lastAt) - Date.parse(seg.firstAt);
    const elapsedSeconds =
      seg.frames >= 2 && Number.isFinite(ms) && ms >= 0
        ? Math.max(1, Math.round(ms / 1000))
        : null;
    return {
      kind: "work",
      key: seg.key,
      items: seg.items.map((item) =>
        item.kind === "thought" && item.streaming && !runLive
          ? { ...item, streaming: false }
          : item,
      ),
      elapsedSeconds,
      startedAt: seg.firstAt,
      active: runLive && index === lastIndex,
      waiting:
        !canceled &&
        status === "waiting" &&
        index === lastIndex &&
        pendingInputs.length > 0,
      sealed: index < lastIndex,
    };
  });

  return {
    runId: run.id,
    status,
    userMessage,
    segments: outSegments,
    pendingInputs,
    // Error surfaces only when the run actually failed — a step that failed
    // mid-run but recovered must not leave a stale banner, and a CANCELLED
    // run is not a failure at all (it emits no failure event to read).
    error: status === "failed" ? (error ?? "Run failed") : null,
    modelId,
    canceled: canceled || status === "canceled",
    contextCleared,
  };
}
