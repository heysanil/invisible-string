/**
 * Copilot thread MODEL — a PURE reduction from the server's frame stream
 * (packages/shared/src/copilot.ts) to the item list the dock renders. Split
 * out of `useCopilot` so the interesting part (frame → thread) is testable
 * without a socket, a DOM or a React tree; the hook keeps only what is
 * genuinely effectful (socket lifecycle, applying accepted mutations through
 * the surface controller).
 *
 * The shape mirrors the main chat's timeline (lib/chat/run-view.ts) on
 * purpose — the 2026-08-11 spec (D7.1) asks for the SAME visual grammar, and
 * two divergent vocabularies for "the model thought, then it called a tool"
 * is exactly how two surfaces drift:
 *
 * - Interior work (thoughts + tool steps) collects into a `work` item — one
 *   collapsible rail-in-box, like {@link WorkSegment}.
 * - Assistant TEXT and a suggestion CARD both SEAL the open work item, so
 *   later work opens a new box BELOW them. Without that, a step that happened
 *   after the copilot spoke would be appended to a box rendered above the
 *   speech — a box that silently lies about when its rows happened.
 * - Thoughts and steps upsert by key GLOBALLY, never only within the open
 *   box: a step's `ok` frame legitimately lands after the copilot has spoken
 *   (the accept gate parks the loop for as long as the user takes), and a
 *   thought's sealing frame always arrives after that step's text deltas.
 *
 * Two wire facts this leans on, both from the server (copilot/session.ts):
 * - `thought.text` is CUMULATIVE, so a dropped frame self-heals on the next
 *   one and the reducer REPLACES rather than appends.
 * - `step.key` IS the model tool-call id, hence identical to
 *   `CopilotProposal.id` for every mutation step. That is what lets the dock
 *   render one row per step and hide the ones a suggestion card already shows
 *   in full ({@link proposalIdsOf}).
 */
import {
  humanizeToolName,
  type CopilotProposal,
  type CopilotServerFrame,
  type CopilotStepState,
} from "@invisible-string/shared";

export type SuggestionStatus = "pending" | "applied" | "dismissed";

/** One reasoning block — mirrors the chat's `ThoughtItem`. */
export interface CopilotThoughtItem {
  kind: "thought";
  /** Server key (`step:<index>`); the upsert address. */
  key: string;
  text: string;
  streaming: boolean;
}

/**
 * Display states for a step. The server's vocabulary is
 * {@link CopilotStepState} (pending | ok | error); `canceled` is derived HERE
 * because an aborted turn ends the stream with nothing further for the steps
 * that were still in flight — leaving them spinning forever would be the only
 * alternative.
 */
export type CopilotStepDisplayState = CopilotStepState | "canceled";

/** One tool step — mirrors the chat's `ToolItem`. */
export interface CopilotStepItem {
  kind: "step";
  /** The model tool-call id (= the proposal id for mutation steps). */
  key: string;
  /** Raw tool name, kept for debugging/tests. */
  toolName: string;
  /** `setPersona` → "Set persona" (the shared humanizer, same as the chat). */
  label: string;
  state: CopilotStepDisplayState;
  resultPreview: string | null;
}

export type CopilotTimelineItem = CopilotThoughtItem | CopilotStepItem;

export type CopilotThreadItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      streaming: boolean;
    }
  /** One contiguous stretch of interior work — rendered as a rail-in-box. */
  | {
      kind: "work";
      id: string;
      items: readonly CopilotTimelineItem[];
      /** Speech/a card/the turn's end happened after it — fold it. */
      sealed: boolean;
    }
  | {
      kind: "suggestion";
      id: string;
      proposal: CopilotProposal;
      status: SuggestionStatus;
      /**
       * The server did not wait for an accept (allow-edits, spec D7.2). The
       * card still renders — marked applied — so the turn stays an audit
       * trail instead of a silent edit.
       */
      autoApplied: boolean;
    }
  | { kind: "error"; id: string; text: string }
  /** Muted system line (e.g. a mid-turn connection drop). */
  | { kind: "notice"; id: string; text: string };

let localId = 0;
const nextLocalId = (): string => `local-${++localId}`;

// ── item helpers ────────────────────────────────────────────────────────────

/** Append delta text to the trailing streaming assistant message (or open one). */
function appendDelta(
  current: readonly CopilotThreadItem[],
  text: string,
): CopilotThreadItem[] {
  const last = current.at(-1);
  if (
    last &&
    last.kind === "message" &&
    last.role === "assistant" &&
    last.streaming
  ) {
    return [...current.slice(0, -1), { ...last, text: last.text + text }];
  }
  // Speech closes the open work box (see the module header).
  return [
    ...sealOpenWork(current),
    { kind: "message", id: nextLocalId(), role: "assistant", text, streaming: true },
  ];
}

/** Mark the trailing work item sealed (no-op when there is no open one). */
function sealOpenWork(
  current: readonly CopilotThreadItem[],
): CopilotThreadItem[] {
  const last = current.at(-1);
  if (!last || last.kind !== "work" || last.sealed) return [...current];
  return [...current.slice(0, -1), { ...last, sealed: true }];
}

function mapTimeline(
  items: readonly CopilotThreadItem[],
  fn: (item: CopilotTimelineItem) => CopilotTimelineItem,
): CopilotThreadItem[] {
  return items.map((item) =>
    item.kind === "work" ? { ...item, items: item.items.map(fn) } : item,
  );
}

/**
 * Upsert a timeline item by key.
 *
 * Found anywhere → replaced IN PLACE (wherever it already lives, including a
 * sealed box). Not found → appended to the open work box, opening one when
 * the thread's tail is not already work.
 */
function upsertTimelineItem(
  current: readonly CopilotThreadItem[],
  item: CopilotTimelineItem,
): CopilotThreadItem[] {
  const existing = current.some(
    (entry) =>
      entry.kind === "work" &&
      entry.items.some((row) => row.kind === item.kind && row.key === item.key),
  );
  if (existing) {
    return mapTimeline(current, (row) =>
      row.kind === item.kind && row.key === item.key ? item : row,
    );
  }
  const last = current.at(-1);
  if (last && last.kind === "work" && !last.sealed) {
    return [
      ...current.slice(0, -1),
      { ...last, items: [...last.items, item] },
    ];
  }
  return [
    ...current,
    { kind: "work", id: nextLocalId(), items: [item], sealed: false },
  ];
}

/** Server error copy is protocol-speak — humanize what users may actually see. */
export function humanizeCopilotError(code: string, message: string): string {
  switch (code) {
    case "turn_in_progress":
      return "Copilot is still working on the previous request — wait for it to finish (or press Stop).";
    case "over_budget":
      return message.includes("window")
        ? message
        : "That turn hit the copilot's budget limit — try a smaller request.";
    default:
      return message;
  }
}

// ── public transitions ──────────────────────────────────────────────────────

export function appendUserMessage(
  current: readonly CopilotThreadItem[],
  text: string,
): CopilotThreadItem[] {
  return [
    ...sealOpenWork(current),
    { kind: "message", id: nextLocalId(), role: "user", text, streaming: false },
  ];
}

export function appendNotice(
  current: readonly CopilotThreadItem[],
  text: string,
): CopilotThreadItem[] {
  return [...current, { kind: "notice", id: nextLocalId(), text }];
}

/**
 * End-of-turn settle: streaming messages and thoughts stop streaming, the open
 * work box seals.
 *
 * `cancelPendingSteps` additionally retires steps still `pending` — used when
 * the turn ended WITHOUT the server resolving them (abort, error, a dropped
 * socket). A completed turn leaves them alone: the server resolves every step
 * it opened, so a pending one there would be a server bug worth seeing.
 *
 * `sealWork: false` closes the streaming TEXT only and leaves every work box
 * untouched — the one case being `turn_in_progress`, which rejects the new
 * message while the previous turn keeps thinking. Folding its live box there
 * would tell the user the work stopped when it did not.
 */
export function settleCopilotTurn(
  current: readonly CopilotThreadItem[],
  options: { cancelPendingSteps?: boolean; sealWork?: boolean } = {},
): CopilotThreadItem[] {
  const settled = current.map((item) => {
    if (item.kind === "message" && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind !== "work" || options.sealWork === false) return item;
    return {
      ...item,
      sealed: true,
      items: item.items.map((row) => {
        if (row.kind === "thought") {
          return row.streaming ? { ...row, streaming: false } : row;
        }
        return options.cancelPendingSteps && row.state === "pending"
          ? { ...row, state: "canceled" as const }
          : row;
      }),
    };
  });
  return settled;
}

/**
 * Fold one server frame into the thread. Total over {@link CopilotServerFrame}
 * and side-effect free — the hook does the effectful half (applying an
 * auto-applied proposal, flipping `generating`).
 */
export function reduceCopilotFrame(
  current: readonly CopilotThreadItem[],
  frame: CopilotServerFrame,
): CopilotThreadItem[] {
  switch (frame.type) {
    case "delta":
      return appendDelta(current, frame.text);

    case "thought":
      return upsertTimelineItem(current, {
        kind: "thought",
        key: frame.key,
        text: frame.text,
        streaming: frame.streaming,
      });

    case "step":
      return upsertTimelineItem(current, {
        kind: "step",
        key: frame.key,
        toolName: frame.toolName,
        label: humanizeToolName(frame.toolName),
        state: frame.state,
        resultPreview: frame.resultPreview,
      });

    case "proposal":
      // A card seals the open box for the same reason speech does (and
      // settling also stops any still-streaming text/thought: the round-trip
      // that produced this tool call is over).
      return [
        ...settleCopilotTurn(current),
        {
          kind: "suggestion",
          id: frame.proposal.id,
          proposal: frame.proposal,
          // Auto-applied proposals are applied by the CLIENT (still the single
          // writer) the moment they arrive, so the card opens settled.
          status: frame.autoApplied === true ? "applied" : "pending",
          autoApplied: frame.autoApplied === true,
        },
      ];

    case "done":
      return settleCopilotTurn(current, {
        cancelPendingSteps: frame.reason === "aborted",
      });

    case "error":
      return [
        // `turn_in_progress` rejects THIS message; the previous turn is still
        // running, so its box keeps its spinner and its steps keep running.
        ...settleCopilotTurn(current, {
          cancelPendingSteps: true,
          ...(frame.code === "turn_in_progress" ? { sealWork: false } : {}),
        }),
        {
          kind: "error",
          id: nextLocalId(),
          text: humanizeCopilotError(frame.code, frame.message),
        },
      ];
  }
}

/** Mark one suggestion decided (Apply/Dismiss). */
export function decideSuggestion(
  current: readonly CopilotThreadItem[],
  suggestionId: string,
  status: SuggestionStatus,
): CopilotThreadItem[] {
  return current.map((item) =>
    item.kind === "suggestion" && item.id === suggestionId
      ? { ...item, status }
      : item,
  );
}

// ── render-time derivations ─────────────────────────────────────────────────

/**
 * Ids of every suggestion in the thread — i.e. every step key whose rail row
 * the dock SUPPRESSES, because the card renders that same tool call far more
 * fully (title, rationale, before→after, Apply/Dismiss). What survives in the
 * rail is exactly what has no card: the model's thinking and the invalid tool
 * calls it self-corrected, which is the opacity D7.1 exists to remove.
 */
export function proposalIdsOf(
  items: readonly CopilotThreadItem[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of items) if (item.kind === "suggestion") ids.add(item.id);
  return ids;
}

/** A work box's rows minus the ones a suggestion card already shows. */
export function visibleTimelineItems(
  items: readonly CopilotTimelineItem[],
  hiddenStepKeys: ReadonlySet<string>,
): readonly CopilotTimelineItem[] {
  return items.filter(
    (item) => item.kind !== "step" || !hiddenStepKeys.has(item.key),
  );
}
