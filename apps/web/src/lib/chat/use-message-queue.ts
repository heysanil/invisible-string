/**
 * Client-side message queue for a chat thread.
 *
 * The control plane allows ONE run per session (`waiting` counts as busy), so
 * a message typed while a run is working would come back 409 `session_busy`.
 * This hook defers it instead: messages accumulate, and when the slot frees
 * they merge into a single send.
 *
 * Three details are load-bearing and easy to "simplify" wrong:
 *
 * 1. The flush is CONDITION-triggered, not edge-triggered. A message enqueued
 *    while `canFlush` is already true has no edge to ride and would strand.
 * 2. A resolved flush removes the SNAPSHOTTED ids, never the whole queue.
 *    `queueing` is deliberately true during a flush, so Enter in that window
 *    enqueues — a wholesale clear() would delete a message that was never sent.
 * 3. A retry armed while the slot was free is cancelled the moment the slot is
 *    taken again. Firing it would burn the give-up budget on a request the
 *    client already knows will 409.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { isSessionBusy } from "../api-client";
import { errorMessage } from "../forms";
import { isSessionOver } from "./session-errors";

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface UseMessageQueueOptions {
  /** `!slotHeld && !sessionRetired && !sending` — the server's own rule. */
  canFlush: boolean;
  /** `postMessage.mutateAsync`; must REJECT on error. */
  send: (text: string) => Promise<void>;
  /** Hand the merged text back non-destructively (never clobber the box). */
  onGiveUp: (mergedText: string) => void;
  /** eve retired this session id — permanent. */
  onRetired: () => void;
  /** Test seam: bun:test has no fake timers. */
  retryDelayMs?: number;
}

export interface MessageQueue {
  queued: readonly QueuedMessage[];
  enqueue: (text: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Retry / give-up copy for the composer's hint line. */
  notice: string | null;
}

const MAX_BUSY_ATTEMPTS = 5;
const DEFAULT_RETRY_MS = 2_000;

const BUSY_NOTICE =
  "Still finishing up — your queued message will send shortly.";
const GAVE_UP_NOTICE =
  "This session is still busy, so your queued message wasn’t sent. It’s back in the box — try again in a moment.";

/**
 * A blank line, because every queued item is markdown: a single newline folds
 * the next item into the previous paragraph under CommonMark.
 */
export function mergeQueued(messages: readonly QueuedMessage[]): string {
  return messages.map((message) => message.text).join("\n\n");
}

/** Matches the short client-side id pattern in lib/slug.ts — never leaves the browser. */
function queuedMessageId(): string {
  return `qm_${crypto.randomUUID().replace(/-/g, "").slice(0, 13)}`;
}

export function useMessageQueue({
  canFlush,
  send,
  onGiveUp,
  onRetired,
  retryDelayMs = DEFAULT_RETRY_MS,
}: UseMessageQueueOptions): MessageQueue {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState(false);

  const flushing = useRef(false);
  const busyAttempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Callbacks change identity every render; keeping them in refs stops the
  // flush effect from re-firing on an unrelated parent repaint.
  const sendRef = useRef(send);
  sendRef.current = send;
  const giveUpRef = useRef(onGiveUp);
  giveUpRef.current = onGiveUp;
  const retiredRef = useRef(onRetired);
  retiredRef.current = onRetired;

  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setRetryPending(false);
  }, []);

  useEffect(() => {
    if (!canFlush) cancelRetry();
  }, [canFlush, cancelRetry]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!canFlush || retryPending || flushing.current || queued.length === 0) {
      return;
    }
    const included = new Set(queued.map((message) => message.id));
    const merged = mergeQueued(queued);
    const dropIncluded = () =>
      setQueued((current) =>
        current.filter((message) => !included.has(message.id)),
      );

    flushing.current = true;
    void sendRef.current(merged).then(
      () => {
        flushing.current = false;
        busyAttempts.current = 0;
        setNotice(null);
        dropIncluded();
      },
      (error: unknown) => {
        flushing.current = false;
        if (isSessionBusy(error)) {
          busyAttempts.current += 1;
          if (busyAttempts.current < MAX_BUSY_ATTEMPTS) {
            setNotice(BUSY_NOTICE);
            setRetryPending(true);
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              setRetryPending(false);
            }, retryDelayMs);
            return;
          }
          setNotice(GAVE_UP_NOTICE);
        } else if (isSessionOver(error)) {
          retiredRef.current();
          setNotice(null);
        } else {
          setNotice(errorMessage(error));
        }
        busyAttempts.current = 0;
        giveUpRef.current(merged);
        dropIncluded();
      },
    );
  }, [canFlush, queued, retryPending, retryDelayMs]);

  const enqueue = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setQueued((current) => [
      ...current,
      { id: queuedMessageId(), text: trimmed },
    ]);
    setNotice(null);
  }, []);

  const remove = useCallback((id: string) => {
    setQueued((current) => current.filter((message) => message.id !== id));
  }, []);

  const clear = useCallback(() => {
    setQueued([]);
    setNotice(null);
  }, []);

  return { queued, enqueue, remove, clear, notice };
}
