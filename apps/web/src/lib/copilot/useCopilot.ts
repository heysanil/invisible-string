/**
 * Copilot panel state — owns the thread (streamed assistant messages +
 * suggestion cards), the socket lifecycle (one per open builder, disposed on
 * unmount), and the Apply/Dismiss flow. Applying routes the mutation through
 * the builder controller's dispatch (single writer) and reports `accepted`
 * to the server; dismissing reports `rejected`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CopilotMutation,
  CopilotServerFrame,
  CopilotSuggestion,
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
      suggestion: CopilotSuggestion;
      status: SuggestionStatus;
    }
  | { kind: "error"; id: string; text: string };

export interface UseCopilotOptions {
  workspaceId: string;
  workflowId: string;
  /** Panel closed ⇒ no socket. */
  enabled: boolean;
  /** Read the LIVE draft (used for hello + every user message). */
  getDraft: () => WorkflowDefinition;
  /** Apply an accepted mutation through the builder controller. */
  applyMutation: (mutation: CopilotMutation) => void;
  createWebSocket?: WebSocketFactory;
  backoffBaseMs?: number;
}

export interface CopilotApi {
  items: readonly CopilotThreadItem[];
  status: CopilotSocketStatus;
  generating: boolean;
  send: (text: string) => void;
  stop: () => void;
  applySuggestion: (suggestionId: string) => void;
  dismissSuggestion: (suggestionId: string) => void;
}

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function useCopilot(options: UseCopilotOptions): CopilotApi {
  const {
    workspaceId,
    workflowId,
    enabled,
    getDraft,
    applyMutation,
    createWebSocket,
    backoffBaseMs,
  } = options;

  const [items, setItems] = useState<CopilotThreadItem[]>([]);
  const [status, setStatus] = useState<CopilotSocketStatus>("closed");
  const [generating, setGenerating] = useState(false);

  const socketRef = useRef<CopilotSocket | null>(null);
  // Live refs so the socket callbacks never capture stale props.
  const getDraftRef = useRef(getDraft);
  getDraftRef.current = getDraft;
  const applyMutationRef = useRef(applyMutation);
  applyMutationRef.current = applyMutation;

  const handleFrame = useCallback((frame: CopilotServerFrame) => {
    switch (frame.type) {
      case "assistant_delta":
        setGenerating(true);
        setItems((current) => {
          const index = current.findIndex(
            (item) => item.kind === "message" && item.id === frame.messageId,
          );
          if (index === -1) {
            return [
              ...current,
              {
                kind: "message",
                id: frame.messageId,
                role: "assistant",
                text: frame.text,
                streaming: true,
              },
            ];
          }
          const existing = current[index]!;
          if (existing.kind !== "message") return current;
          const next = [...current];
          next[index] = { ...existing, text: existing.text + frame.text };
          return next;
        });
        break;
      case "assistant_done":
        setGenerating(false);
        setItems((current) =>
          current.map((item) =>
            item.kind === "message" && item.id === frame.messageId
              ? { ...item, streaming: false }
              : item,
          ),
        );
        break;
      case "suggestion":
        setItems((current) => [
          ...current,
          {
            kind: "suggestion",
            id: frame.suggestion.id,
            suggestion: frame.suggestion,
            status: "pending",
          },
        ]);
        break;
      case "copilot_error":
        setGenerating(false);
        setItems((current) => [
          ...current,
          { kind: "error", id: nextLocalId(), text: frame.message },
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
      onStatus: setStatus,
      // (Re)establish context on every open — reconnect resumes by
      // re-sending the current draft.
      onOpen: () => {
        socket.send({
          type: "client_hello",
          workflowId,
          draft: getDraftRef.current(),
        });
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

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const sent = socketRef.current?.send({
      type: "user_message",
      text: trimmed,
      draft: getDraftRef.current(),
    });
    if (!sent) return;
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
  }, []);

  const stop = useCallback(() => {
    socketRef.current?.send({ type: "stop" });
    setGenerating(false);
    setItems((current) =>
      current.map((item) =>
        item.kind === "message" && item.streaming
          ? { ...item, streaming: false }
          : item,
      ),
    );
  }, []);

  const decide = useCallback(
    (suggestionId: string, decision: "accepted" | "rejected") => {
      setItems((current) =>
        current.map((item) => {
          if (item.kind !== "suggestion" || item.id !== suggestionId) {
            return item;
          }
          if (item.status !== "pending") return item;
          if (decision === "accepted") {
            applyMutationRef.current(item.suggestion.mutation);
          }
          socketRef.current?.send({
            type: "suggestion_decision",
            suggestionId,
            decision,
          });
          return {
            ...item,
            status: decision === "accepted" ? "applied" : "dismissed",
          };
        }),
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
