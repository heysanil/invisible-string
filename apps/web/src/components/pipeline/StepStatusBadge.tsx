/**
 * Run-status capsule for a step card ("run" density) — the E1 way to show a
 * step instance's lifecycle: color only as meaning (green done · amber
 * waiting · red failed), everything transient in ink. A live spinner marks
 * `running` (motion is already reduced-motion-safe via the Spinner
 * primitive's CSS).
 */
import type { RunStepStatus } from "@invisible-string/shared";

import { StatusChip, type StatusTone } from "../ui/StatusChip";
import { Spinner } from "../ui/Spinner";

const LABEL: Record<RunStepStatus, string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  canceled: "Canceled",
};

const TONE: Record<RunStepStatus, StatusTone> = {
  pending: "neutral",
  running: "ink",
  waiting: "warning",
  succeeded: "success",
  failed: "error",
  skipped: "neutral",
  canceled: "neutral",
};

export interface StepStatusBadgeProps {
  status: RunStepStatus;
  /** 1-based attempt; > 1 renders a "try n" suffix (retries are visible). */
  attempt?: number;
  className?: string;
}

export function StepStatusBadge({
  status,
  attempt,
  className,
}: StepStatusBadgeProps) {
  const retry = attempt !== undefined && attempt > 1 ? ` · try ${attempt}` : "";
  return (
    <StatusChip
      tone={TONE[status]}
      dot={status !== "running"}
      className={className}
      title={`Step ${LABEL[status].toLowerCase()}${retry}`}
    >
      {status === "running" ? <Spinner size={10} /> : null}
      {LABEL[status]}
      {retry}
    </StatusChip>
  );
}
