/**
 * Small display derivations for pipeline RUNS, shared by the runs list, the
 * run detail header, and the editor's run-overlay banner.
 */
import type { RunDto, RunStatus } from "@invisible-string/shared";

import type { StatusTone } from "../../components/ui/StatusChip";

export const RUN_STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: "neutral",
  running: "ink",
  waiting: "warning",
  succeeded: "success",
  failed: "error",
  canceled: "neutral",
};

/** Wall-clock duration of a settled run; null while it has no bookends. */
export function runDuration(run: RunDto): string | null {
  if (run.startedAt === null || run.completedAt === null) return null;
  const ms = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return formatDurationMs(ms);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
