/**
 * Copilot panel state — owns the thread (streamed assistant messages +
 * suggestion cards), the socket lifecycle (one per open builder, disposed on
 * unmount), and the Apply/Dismiss flow.
 *
 * Protocol (packages/shared/src/copilot.ts): each `user_message` carries the
 * LIVE draft; the server streams `delta` text and validated `proposal`
 * frames, pausing its tool loop until the client answers each proposal with
 * a `mutation_result`. Applying routes the proposal through the builder
 * controller's dispatch (single writer) and reports `accepted`; dismissing
 * reports `rejected`. `abort` cuts the in-flight turn short.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CopilotProposal,
  CopilotServerFrame,
  WorkflowDefinition,
} from "@invisible-string/shared";

import {
  CopilotSocket,
  type CopilotSocketStatus,
  type WebSocketFactory,
} from "./socket";

export type SuggestionStatus = "pending" | "applied" | "dismissed";

export type CopilotThreadItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      streaming: boolean;
    }
  | {
      kind: "suggestion";
      id: string;
      proposal: CopilotProposal;
      status: SuggestionStatus;
    }
  | { kind: "error"; id: string; text: string }
  /** Muted system line (e.g. a mid-turn connection drop). */
  | { kind: "notice"; id: string; text: string };

export interface UseCopilotOptions {
  workspaceId: string;
  workflowId: string;
  /** Panel closed ⇒ no socket. */
  enabled: boolean;
  /** Read the LIVE draft (sent with every user message). */
  getDraft: () => WorkflowDefinition;
  /** Apply an accepted proposal through the builder controller. */
  applyProposal: (proposal: CopilotProposal) => void;
  createWebSocket?: WebSocketFactory;
  backoffBaseMs?: number;
}

export interface CopilotApi {
  items: readonly CopilotThreadItem[];
  status: CopilotSocketStatus;
  generating: boolean;
  /**
   * Send a user message. Returns false (without touching the thread) when it
   * cannot be delivered right now — socket still connecting/reconnecting or a
   * turn already in flight — so the caller can KEEP the composer text.
   */
  send: (text: string) => boolean;
  stop: () => void;
  applySuggestion: (suggestionId: string) => void;
  dismissSuggestion: (suggestionId: string) => void;
}

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

/** Append delta text to the trailing streaming assistant message (or open one). */
function appendDelta(
  current: CopilotThreadItem[],
  text: string,
): CopilotThreadItem[] {
  const last = current.at(-1);
  if (last && last.kind === "message" && last.role === "assistant" && last.streaming) {
    return [...current.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...current,
    { kind: "message", id: nextLocalId(), role: "assistant", text, streaming: true },
  ];
}

function settleStreaming(current: CopilotThreadItem[]): CopilotThreadItem[] {
  return current.map((item) =>
    item.kind === "message" && item.streaming
      ? { ...item, streaming: false }
      : item,
  );
}

/** Server error copy is protocol-speak — humanize what users may actually see. */
function humanizeError(code: string, message: string): string {
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

export function useCopilot(options: UseCopilotOptions): CopilotApi {
  const {
    workspaceId,
    workflowId,
    enabled,
    getDraft,
    applyProposal,
    createWebSocket,
    backoffBaseMs,
  } = options;

  const [items, setItems] = useState<CopilotThreadItem[]>([]);
  const [status, setStatus] = useState<CopilotSocketStatus>("closed");
  const [generating, setGenerating] = useState(false);

  // Mirror of `items` so event handlers can read the latest thread without
  // smuggling side effects into a state updater (StrictMode double-invokes
  // updaters — they must stay pure).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Mirror of `generating` for callbacks that must not capture stale state.
  const generatingRef = useRef(generating);
  generatingRef.current = generating;

  const socketRef = useRef<CopilotSocket | null>(null);
  // Live refs so the socket callbacks never capture stale props.
  const getDraftRef = useRef(getDraft);
  getDraftRef.current = getDraft;
  const applyProposalRef = useRef(applyProposal);
  applyProposalRef.current = applyProposal;

  const handleFrame = useCallback((frame: CopilotServerFrame) => {
    switch (frame.type) {
      case "delta":
        setGenerating(true);
        setItems((current) => appendDelta(current, frame.text));
        break;
      case "proposal":
        setItems((current) => [
          ...settleStreaming(current),
          {
            kind: "suggestion",
            id: frame.proposal.id,
            proposal: frame.proposal,
            status: "pending",
          },
        ]);
        break;
      case "done":
        setGenerating(false);
        setItems(settleStreaming);
        break;
      case "error":
        // turn_in_progress means the PREVIOUS turn is still streaming — the
        // stop affordance must survive (the real turn is still in flight).
        if (frame.code !== "turn_in_progress") setGenerating(false);
        setItems((current) => [
          ...settleStreaming(current),
          {
            kind: "error",
            id: nextLocalId(),
            text: humanizeError(frame.code, frame.message),
          },
        ]);
        break;
    }
  }, []);

  // ── socket lifecycle: one per open builder panel ───────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const socket = new CopilotSocket({
      workspaceId,
      workflowId,
      onFrame: handleFrame,
      onStatus: (next) => {
        setStatus(next);
        if (next === "reconnecting") {
          // The server session died with the socket — the in-flight turn is
          // gone. Settle the UI; pending cards stay actionable (Apply is a
          // pure client-side draft edit). Leave a visible marker so the
          // prose ("two suggestions…") can't silently disagree with what
          // actually arrived.
          if (generatingRef.current) {
            setItems((current) => [
              ...settleStreaming(current),
              {
                kind: "notice",
                id: nextLocalId(),
                text: "Connection lost — this response was cut short. Ask again to continue.",
              },
            ]);
          }
          setGenerating(false);
        }
      },
      ...(createWebSocket ? { createWebSocket } : {}),
      ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
    });
    socketRef.current = socket;
    return () => {
      socket.dispose();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [
    enabled,
    workspaceId,
    workflowId,
    handleFrame,
    createWebSocket,
    backoffBaseMs,
  ]);

  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return false;
      // One turn at a time: sending mid-turn would orphan the user's bubble
      // (the server answers turn_in_progress and drops the message).
      if (generatingRef.current) return false;
      const sent = socketRef.current?.send({
        type: "user_message",
        workflowId,
        draft: getDraftRef.current() as unknown as Record<string, unknown>,
        message: trimmed,
      });
      if (!sent) return false;
      setGenerating(true);
      setItems((current) => [
        ...current,
        {
          kind: "message",
          id: nextLocalId(),
          role: "user",
          text: trimmed,
          streaming: false,
        },
      ]);
      return true;
    },
    [workflowId],
  );

  const stop = useCallback(() => {
    socketRef.current?.send({ type: "abort" });
    setGenerating(false);
    setItems(settleStreaming);
  }, []);

  const decide = useCallback(
    (suggestionId: string, outcome: "accepted" | "rejected") => {
      // Side effects OUTSIDE the state updater (StrictMode-safe): find the
      // pending card, apply/report once, then mark its status.
      const item = itemsRef.current.find(
        (i): i is Extract<CopilotThreadItem, { kind: "suggestion" }> =>
          i.kind === "suggestion" && i.id === suggestionId,
      );
      if (!item || item.status !== "pending") return;
      if (outcome === "accepted") {
        applyProposalRef.current(item.proposal);
      }
      socketRef.current?.send({
        type: "mutation_result",
        proposalId: suggestionId,
        outcome,
      });
      setItems((current) =>
        current.map((i) =>
          i.kind === "suggestion" && i.id === suggestionId
            ? { ...i, status: outcome === "accepted" ? "applied" : "dismissed" }
            : i,
        ),
      );
    },
    [],
  );

  const applySuggestion = useCallback(
    (suggestionId: string) => decide(suggestionId, "accepted"),
    [decide],
  );
  const dismissSuggestion = useCallback(
    (suggestionId: string) => decide(suggestionId, "rejected"),
    [decide],
  );

  return { items, status, generating, send, stop, applySuggestion, dismissSuggestion };
}
