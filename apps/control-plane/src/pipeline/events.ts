/**
 * Pipeline event appender — writes `pipeline.*` step-lifecycle events
 * (shared pipeline-events.ts) into the parent run's `run_events` under the
 * SAME monotonic `seq` the eve tailer uses, and mirrors each row onto the
 * RunEventBus for live SSE followers. Because seq is claimed exactly the way
 * a resuming tailer claims it (count of already-persisted events), pipeline
 * timelines resume over Last-Event-ID with zero transport changes.
 *
 * One appender per driver lifetime; the driver is sequential, so emits never
 * race. A rebooted run creates a fresh appender whose base seq lands after
 * everything the previous incarnation persisted.
 */
import type {
  EveStreamEvent,
  PipelineStreamEvent,
  RunStatus,
} from "@invisible-string/shared";

import type { RunEventBus } from "../runs/bus";
import type { RunStore } from "../runs/store";

export interface PipelineEventAppender {
  readonly runId: string;
  /**
   * Events already persisted when this appender was created — 0 means a
   * fresh run (the driver keys "emit pipeline.started" off this).
   */
  readonly baseSeq: number;
  /** Persist one event under the next seq and publish it on the bus. */
  emit(event: PipelineStreamEvent): Promise<void>;
}

export async function createPipelineEventAppender(opts: {
  runStore: Pick<RunStore, "appendEvent" | "countRunEvents">;
  bus: RunEventBus;
  runId: string;
}): Promise<PipelineEventAppender> {
  const { runStore, bus, runId } = opts;
  const baseSeq = await runStore.countRunEvents(runId);
  let seq = baseSeq;
  return {
    runId,
    baseSeq,
    async emit(event) {
      const claimed = seq;
      seq += 1;
      // RunStore.appendEvent is typed over the eve vocabulary; run_events
      // rows carry the WIDENED RunStreamEventPayload (shared api.ts), which
      // pipeline.* belongs to — the store just persists jsonb. Widening the
      // store's signature is a runs/store.ts change this module must not
      // make (file owned elsewhere); the cast is the documented seam.
      const stored = await runStore.appendEvent(
        runId,
        claimed,
        event as unknown as EveStreamEvent,
      );
      bus.publish(runId, {
        kind: "event",
        frame: { runId, seq: claimed, event, at: stored.at },
      });
    },
  };
}

/**
 * Publish a run lifecycle transition to live SSE followers — the pipeline
 * driver's counterpart of the tailer's status frames (running at start,
 * waiting/running around an agent-step park, and the terminal status).
 * Status truth stays the `runs` row; this is the live mirror only.
 */
export function publishRunStatus(
  bus: RunEventBus,
  runId: string,
  status: RunStatus,
  error?: string | null,
): void {
  bus.publish(runId, {
    kind: "status",
    frame: { runId, status, ...(error != null ? { error } : {}) },
  });
}
