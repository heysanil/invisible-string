/**
 * Live plumbing for a chat thread: one resumable SSE subscription per run.
 *
 * - History and live tail come from the SAME stream: `GET /runs/:id/stream`
 *   replays persisted run_events (server closes after a stream-terminal
 *   status), so a terminal run hydrates once and never reconnects.
 * - Frames land in a seq-deduped {@link FrameStore} — reconnects resume via
 *   Last-Event-ID (the store's maxSeq) and re-delivered frames are no-ops.
 * - `waiting` is stream-terminal: after answering a HITL input call
 *   {@link ThreadStreams.reopen} to attach a fresh tail (it resumes from the
 *   cursor, so nothing replays twice).
 * - run_status frames update the run's live status and bubble through
 *   `onRunStatus` so the caller can invalidate the session list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDto, RunStatus } from "@invisible-string/shared";

import { streamRun, type RunStreamHandle } from "../sse";
import { addFrame, EMPTY_FRAME_STORE, type FrameStore } from "./run-view";

export interface RunLiveState {
  store: FrameStore;
  /** Live status — run_status frames win over the fetched row. */
  status: RunStatus | null;
  error: string | null;
  /** Fatal stream error (4xx) message, if any. */
  streamError: string | null;
}

export interface ThreadStreams {
  /** Live per-run state, keyed by run id. */
  runs: ReadonlyMap<string, RunLiveState>;
  /** Re-attach a run's stream (used after answering a HITL input). */
  reopen: (runId: string) => void;
}

export interface UseThreadStreamsOptions {
  /** Test seam — defaults to lib/sse's streamRun. */
  streamFn?: typeof streamRun;
  /** Fired on every run_status frame (list invalidation lives here). */
  onRunStatus?: (runId: string, status: RunStatus) => void;
}

const EMPTY_LIVE: RunLiveState = {
  store: EMPTY_FRAME_STORE,
  status: null,
  error: null,
  streamError: null,
};

export function useThreadStreams(
  runs: readonly Pick<RunDto, "id" | "status">[],
  options: UseThreadStreamsOptions = {},
): ThreadStreams {
  const [state, setState] = useState<ReadonlyMap<string, RunLiveState>>(
    () => new Map(),
  );
  const handles = useRef(new Map<string, RunStreamHandle>());
  const stores = useRef(new Map<string, FrameStore>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateRun = useCallback(
    (runId: string, patch: (current: RunLiveState) => RunLiveState) => {
      setState((current) => {
        const existing = current.get(runId) ?? EMPTY_LIVE;
        const updated = patch(existing);
        if (updated === existing) return current;
        const next = new Map(current);
        next.set(runId, updated);
        return next;
      });
    },
    [],
  );

  const open = useCallback(
    (runId: string) => {
      handles.current.get(runId)?.close();
      const streamFn = optionsRef.current.streamFn ?? streamRun;
      // TEMP DIAG (CI-runner-only test failure) — remove before merge.
      console.log(
        "DIAG open()", runId,
        "| injected streamFn:", optionsRef.current.streamFn !== undefined,
      );
      const cursor = stores.current.get(runId)?.maxSeq ?? -1;
      const handle = streamFn(
        runId,
        {
          onRunEvent: (frame) => {
            const store = stores.current.get(runId) ?? EMPTY_FRAME_STORE;
            const next = addFrame(store, frame);
            if (next === store) return; // duplicate — seq is authoritative
            stores.current.set(runId, next);
            updateRun(runId, (current) => ({ ...current, store: next }));
          },
          onRunStatus: (frame) => {
            updateRun(runId, (current) => ({
              ...current,
              status: frame.status,
              error: frame.error ?? current.error,
            }));
            optionsRef.current.onRunStatus?.(runId, frame.status);
          },
          onError: (error) => {
            updateRun(runId, (current) => ({
              ...current,
              streamError: error.message,
            }));
          },
        },
        cursor >= 0 ? { lastEventId: cursor } : {},
      );
      handles.current.set(runId, handle);
    },
    [updateRun],
  );

  // Attach a stream per run id; close streams for runs that left the list.
  const runIds = runs.map((run) => run.id).join("\n");
  useEffect(() => {
    const wanted = new Set(runIds === "" ? [] : runIds.split("\n"));
    for (const runId of wanted) {
      if (!handles.current.has(runId)) open(runId);
    }
    for (const [runId, handle] of handles.current) {
      if (!wanted.has(runId)) {
        handle.close();
        handles.current.delete(runId);
      }
    }
  }, [runIds, open]);

  // Teardown on unmount.
  useEffect(() => {
    const owned = handles.current;
    return () => {
      for (const handle of owned.values()) handle.close();
      owned.clear();
    };
  }, []);

  const reopen = useCallback(
    (runId: string) => {
      open(runId);
    },
    [open],
  );

  return { runs: state, reopen };
}
