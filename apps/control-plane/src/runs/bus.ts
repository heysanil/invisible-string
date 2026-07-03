/**
 * In-process pub/sub bridging the NDJSON tailer to live SSE followers.
 * Phase-1 topology has ONE control-plane process, so an in-memory bus is the
 * whole story; multi-instance fan-out (LISTEN/NOTIFY or similar) is a later
 * concern isolated behind this interface.
 */
import type { RunEventFrame, RunStatusFrame } from "@invisible-string/shared";

export type RunStreamFrame =
  | { kind: "event"; frame: RunEventFrame }
  | { kind: "status"; frame: RunStatusFrame };

export type RunStreamListener = (frame: RunStreamFrame) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunStreamListener>>();

  /** Subscribe to one run's frames; returns the unsubscribe function. */
  subscribe(runId: string, listener: RunStreamListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, frame: RunStreamFrame): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(frame);
      } catch {
        // One slow/broken subscriber must never break the tailer.
      }
    }
  }
}
