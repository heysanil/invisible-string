/**
 * Live pipeline progress for ONE run: opens the run's SSE stream while it is
 * in flight, folds `pipeline.*` frames through the pure run-progress reducer
 * (over a `run_steps` ledger seed when one is available), and tracks the
 * run's status frames. Everything display-facing comes out as the strip's
 * `runStates` map — the same shape the Runs detail derives from the ledger
 * alone for settled runs.
 *
 * The fold is recomputed from (seed, received events) rather than mutated in
 * place, so a ledger refetch landing AFTER frames started streaming cannot
 * lose the live tail — the events simply re-fold over the fresher seed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isPipelineStreamEvent,
  isRunSettledStatus,
  type PipelineStreamEvent,
  type RunStatus,
  type RunStepDto,
} from "@invisible-string/shared";

import type { StepRunState } from "../../components/pipeline";
import { streamRun } from "../sse";
import {
  applyPipelineEvents,
  emptyRunProgress,
  progressFromLedger,
  runStatesOf,
} from "./run-progress";

export interface PipelineRunProgressView {
  /** Per-step states for the strip's run density. */
  runStates: ReadonlyMap<string, StepRunState>;
  /** Latest run status (row status until a fresher stream frame lands). */
  status: RunStatus;
  /** Error text off the terminal run_status frame, when one carried it. */
  error: string | null;
}

export interface UsePipelineRunProgressOptions {
  /** `run_steps` ledger rows to seed from (the detail view's query). */
  seed?: readonly RunStepDto[] | null;
  /** Fired once when a streamed run_status goes settled (refetch hooks). */
  onSettled?: (() => void) | undefined;
}

export function usePipelineRunProgress(
  run: { id: string; status: RunStatus } | null,
  options: UsePipelineRunProgressOptions = {},
): PipelineRunProgressView {
  const { seed = null, onSettled } = options;
  const [events, setEvents] = useState<readonly PipelineStreamEvent[]>([]);
  const [streamedStatus, setStreamedStatus] = useState<RunStatus | null>(null);
  const [streamedError, setStreamedError] = useState<string | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const runId = run?.id ?? null;
  // Open a stream only while the run can still move; `waiting` and settled
  // runs read purely from the ledger (a parked run resumes via a NEW stream
  // opened by whoever answers the input request).
  const live =
    run !== null && (run.status === "queued" || run.status === "running");

  // Reset the accumulated tail when the run identity changes.
  useEffect(() => {
    setEvents([]);
    setStreamedStatus(null);
    setStreamedError(null);
  }, [runId]);

  useEffect(() => {
    if (runId === null || !live) return;
    const handle = streamRun(runId, {
      onRunEvent: (frame) => {
        const event = frame.event;
        if (!isPipelineStreamEvent(event)) return;
        setEvents((current) => [...current, event]);
      },
      onRunStatus: (frame) => {
        setStreamedStatus(frame.status);
        setStreamedError(frame.error ?? null);
        if (isRunSettledStatus(frame.status)) onSettledRef.current?.();
      },
    });
    return () => handle.close();
  }, [runId, live]);

  const runStates = useMemo(() => {
    const base = seed !== null ? progressFromLedger(seed) : emptyRunProgress();
    return runStatesOf(applyPipelineEvents(base, events));
  }, [seed, events]);

  return {
    runStates,
    status: streamedStatus ?? run?.status ?? "queued",
    error: streamedError,
  };
}
