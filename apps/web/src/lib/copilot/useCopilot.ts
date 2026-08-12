/**
 * Copilot panel state — owns the thread (streamed assistant messages, the
 * thought/step rail and suggestion cards), the socket lifecycle (one per open
 * dock, disposed on unmount), and the Apply/Dismiss flow. Surface-agnostic:
 * everything the workflow and agent editors differ on rides the injected
 * {@link CopilotSurfaceAdapter}.
 *
 * Protocol (packages/shared/src/copilot.ts): each `user_message` names its
 * `surface` + `entityId`, carries the LIVE draft, the surface's row IDENTITY
 * where it has one, and the ALLOW-EDITS flag for that turn; the server streams
 * `delta` text, `thought`/`step` progress and validated `proposal` frames,
 * pausing its tool loop until the client answers each proposal with a
 * `mutation_result`. Applying routes the proposal through the surface
 * controller's dispatch (single writer) and reports `accepted`; dismissing
 * reports `rejected`. `abort` cuts the in-flight turn short.
 *
 * IDENTITY rides its own frame field rather than the draft because it is not
 * IN the draft: `agents.name`/`agents.description` are row columns and an
 * `AgentDefinition` has neither, so a server reading them off the draft could
 * never see anything. Bounded here as well as server-side — an over-long
 * mid-edit description must degrade to a truncated identity, never to a
 * rejected frame that silently costs the user their whole turn.
 *
 * APPLYING IS NOT ALWAYS INSTANT. Most proposals are reducer dispatches, but
 * the agent rename is a PATCH, so `applyProposal` may resolve asynchronously
 * and may FAIL. The card is held in `applying` until it settles, and a failure
 * marks it `failed` and reports `rejected` (with a reason) rather than
 * `accepted` — telling the server a mutation landed when it did not would
 * leave the model editing an agent it cannot see.
 *
 * ALLOW-EDITS (spec D7.2) does not move the writer — the client still applies
 * every mutation. It only removes the ASK: the server marks such proposals
 * `autoApplied` and continues its loop without parking, so this hook applies
 * them on arrival and opens their card already settled. It sends no
 * `mutation_result` for them (there is no waiter to resolve), and it keys off
 * the FRAME's flag rather than the current toggle, so flipping the toggle
 * mid-turn can never make the client and the server disagree about who was
 * waiting for whom.
 *
 * The thread transitions themselves are pure and live in ./thread.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  COPILOT_MAX_IDENTITY_DESCRIPTION_CHARS,
  COPILOT_MAX_IDENTITY_NAME_CHARS,
  type CopilotAgentIdentity,
  type CopilotServerFrame,
} from "@invisible-string/shared";

import type { ApplyProposalResult, CopilotSurfaceAdapter } from "./adapter";
import {
  CopilotSocket,
  type CopilotSocketStatus,
  type WebSocketFactory,
} from "./socket";
import {
  appendNotice,
  appendUserMessage,
  decideSuggestion,
  reduceCopilotFrame,
  settleCopilotTurn,
  type CopilotThreadItem,
} from "./thread";

export type {
  CopilotStepDisplayState,
  CopilotStepItem,
  CopilotThoughtItem,
  CopilotThreadItem,
  CopilotTimelineItem,
  SuggestionStatus,
} from "./thread";

export interface UseCopilotOptions {
  workspaceId: string;
  /**
   * The surface being edited. Read through a live ref — a new adapter object
   * per render is fine and never re-keys the socket (the socket is
   * per-workspace; the entity rides each frame).
   */
  adapter: CopilotSurfaceAdapter;
  /** Panel closed ⇒ no socket. */
  enabled: boolean;
  /**
   * Allow-edits mode for the NEXT turn (spec D7.2). Read at send time through
   * a live ref, so it is a property of the turn the user started — not of
   * whatever the toggle happens to say when a frame lands.
   */
  allowEdits?: boolean;
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

/**
 * Clamp a surface's identity to the wire bounds. The server's schema rejects
 * the WHOLE frame on an over-long string, and a description longer than the
 * copilot's own cap is a legal row value (the DTO allows 2000), so trimming
 * here is what keeps a long description from costing the user the turn.
 */
function boundedIdentity(
  identity: CopilotAgentIdentity | null,
): CopilotAgentIdentity | null {
  if (!identity) return null;
  return {
    name: identity.name.slice(0, COPILOT_MAX_IDENTITY_NAME_CHARS),
    description:
      identity.description === null
        ? null
        : identity.description.slice(0, COPILOT_MAX_IDENTITY_DESCRIPTION_CHARS),
  };
}

/**
 * What the model is told when an accepted proposal could not be applied. It
 * rides `mutation_result.reason`, which the server feeds back on rejection —
 * so the copilot learns the edit did not land and can offer it again, rather
 * than continuing as though the agent already had the new name.
 */
const APPLY_FAILED_REASON =
  "The editor could not apply this change — it was not saved.";

/** Only an explicit `false` is a failure — `void` means "applied, nothing to say". */
function appliedOk(result: void | boolean): boolean {
  return result !== false;
}

function isThenable(
  result: ApplyProposalResult,
): result is Promise<void | boolean> {
  return typeof (result as { then?: unknown } | undefined)?.then === "function";
}

export function useCopilot(options: UseCopilotOptions): CopilotApi {
  const {
    workspaceId,
    adapter,
    enabled,
    allowEdits,
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
  // Mirror of the allow-edits toggle (see UseCopilotOptions.allowEdits).
  const allowEditsRef = useRef(allowEdits === true);
  allowEditsRef.current = allowEdits === true;

  const socketRef = useRef<CopilotSocket | null>(null);
  // Live adapter ref so the socket callbacks never capture stale props (the
  // adapter is rebuilt per render by the owning screen).
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const handleFrame = useCallback((frame: CopilotServerFrame) => {
    switch (frame.type) {
      // Text, thinking and step progress all mean the turn is alive.
      case "delta":
      case "thought":
      case "step":
        setGenerating(true);
        break;
      case "proposal":
        // Allow-edits: apply NOW, outside the state updater (StrictMode
        // double-invokes updaters, and applying twice would double-dispatch
        // into the editor). The server has already moved on.
        if (frame.autoApplied === true) {
          const result = adapterRef.current.applyProposal(frame.proposal);
          // An auto-applied card opens as "Applied"; if the application was
          // async and failed, correct the receipt rather than leaving a
          // permanent claim about an edit that never landed. Nothing is sent
          // back — the server is not waiting for this one.
          if (isThenable(result)) {
            const proposalId = frame.proposal.id;
            void result.then((outcome) => {
              if (appliedOk(outcome)) return;
              setItems((current) =>
                decideSuggestion(current, proposalId, "failed"),
              );
            });
          }
        }
        break;
      case "done":
        setGenerating(false);
        break;
      case "error":
        // turn_in_progress means the PREVIOUS turn is still streaming — the
        // stop affordance must survive (the real turn is still in flight).
        if (frame.code !== "turn_in_progress") setGenerating(false);
        break;
    }
    setItems((current) => reduceCopilotFrame(current, frame));
  }, []);

  // ── socket lifecycle: one per open copilot panel ───────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const socket = new CopilotSocket({
      workspaceId,
      onFrame: handleFrame,
      onStatus: (next) => {
        setStatus(next);
        if (next === "reconnecting") {
          // The server session died with the socket — the in-flight turn is
          // gone. Settle the UI (steps still pending will never resolve);
          // pending cards stay actionable (Apply is a pure client-side draft
          // edit). Leave a visible marker so the prose ("two suggestions…")
          // can't silently disagree with what actually arrived.
          if (generatingRef.current) {
            setItems((current) =>
              appendNotice(
                settleCopilotTurn(current, { cancelPendingSteps: true }),
                "Connection lost — this response was cut short. Ask again to continue.",
              ),
            );
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
  }, [enabled, workspaceId, handleFrame, createWebSocket, backoffBaseMs]);

  const send = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    // One turn at a time: sending mid-turn would orphan the user's bubble
    // (the server answers turn_in_progress and drops the message).
    if (generatingRef.current) return false;
    const { entityRef, getDraft, getIdentity } = adapterRef.current;
    const identity = boundedIdentity(getIdentity?.() ?? null);
    const sent = socketRef.current?.send({
      type: "user_message",
      surface: entityRef.surface,
      entityId: entityRef.entityId,
      draft: getDraft() as unknown as Record<string, unknown>,
      message: trimmed,
      // Omitted where the surface has none (workflows) — the server then
      // falls back to the persisted row rather than to nothing.
      ...(identity ? { identity } : {}),
      // Sent only when ON: the field is optional and defaults to the accept
      // gate, which is the safe direction for an omission.
      ...(allowEditsRef.current ? { allowEdits: true } : {}),
    });
    if (!sent) return false;
    setGenerating(true);
    setItems((current) => appendUserMessage(current, trimmed));
    return true;
  }, []);

  const stop = useCallback(() => {
    socketRef.current?.send({ type: "abort" });
    setGenerating(false);
    // The server's `done: aborted` would settle these too, but a stop must
    // land instantly and must not depend on a frame that a dying socket may
    // never deliver.
    setItems((current) =>
      settleCopilotTurn(current, { cancelPendingSteps: true }),
    );
  }, []);

  /** Report the outcome to the server and settle the card. Called once. */
  const settleDecision = useCallback(
    (
      suggestionId: string,
      outcome: "accepted" | "rejected",
      options: { status: "applied" | "failed" | "dismissed"; reason?: string },
    ) => {
      socketRef.current?.send({
        type: "mutation_result",
        proposalId: suggestionId,
        outcome,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      setItems((current) =>
        decideSuggestion(current, suggestionId, options.status),
      );
    },
    [],
  );

  const decide = useCallback(
    (suggestionId: string, outcome: "accepted" | "rejected") => {
      // Side effects OUTSIDE the state updater (StrictMode-safe): find the
      // pending card, apply/report once, then mark its status.
      const item = itemsRef.current.find(
        (i): i is Extract<CopilotThreadItem, { kind: "suggestion" }> =>
          i.kind === "suggestion" && i.id === suggestionId,
      );
      if (!item || item.status !== "pending") return;
      if (outcome === "rejected") {
        settleDecision(suggestionId, "rejected", { status: "dismissed" });
        return;
      }

      const result = adapterRef.current.applyProposal(item.proposal);
      if (!isThenable(result)) {
        // The common case: a reducer dispatch, done in this tick.
        if (appliedOk(result)) {
          settleDecision(suggestionId, "accepted", { status: "applied" });
        } else {
          settleDecision(suggestionId, "rejected", {
            status: "failed",
            reason: APPLY_FAILED_REASON,
          });
        }
        return;
      }
      // Async apply (the agent rename's PATCH): park the card so it neither
      // claims success nor stays clickable, and answer the server only once
      // the write has actually landed. The server's tool loop is waiting for
      // this frame, so every path below must send exactly one.
      setItems((current) => decideSuggestion(current, suggestionId, "applying"));
      void result.then(
        (settled) => {
          if (appliedOk(settled)) {
            settleDecision(suggestionId, "accepted", { status: "applied" });
          } else {
            settleDecision(suggestionId, "rejected", {
              status: "failed",
              reason: APPLY_FAILED_REASON,
            });
          }
        },
        () => {
          settleDecision(suggestionId, "rejected", {
            status: "failed",
            reason: APPLY_FAILED_REASON,
          });
        },
      );
    },
    [settleDecision],
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
