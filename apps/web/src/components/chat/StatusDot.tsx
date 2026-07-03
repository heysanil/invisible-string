/**
 * Session/run liveness indicator — color is meaning only (E1):
 * running ● ink pulsing · waiting ⏸ amber · error ✗ red · idle/done neutral.
 */
import type {
  AgentSessionStatus,
  RunStatus,
} from "@invisible-string/shared";

import { cn } from "../../lib/cn";

export type Liveness = "running" | "waiting" | "error" | "idle";

/** Collapse session + last-run status into one indicator state. */
export function livenessOf(
  session: AgentSessionStatus,
  lastRunStatus: RunStatus | null,
): Liveness {
  if (lastRunStatus === "queued" || lastRunStatus === "running") return "running";
  if (session === "waiting" || lastRunStatus === "waiting") return "waiting";
  if (session === "error" || lastRunStatus === "failed") return "error";
  return "idle";
}

const LIVENESS_LABEL: Record<Liveness, string> = {
  running: "Running",
  waiting: "Waiting for input",
  error: "Failed",
  idle: "Idle",
};

export function StatusDot({
  state,
  className,
}: {
  state: Liveness;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={LIVENESS_LABEL[state]}
      title={LIVENESS_LABEL[state]}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        state === "running" && "dot-pulse bg-ink",
        state === "waiting" && "bg-warn",
        state === "error" && "bg-err",
        state === "idle" && "bg-black/20",
        className,
      )}
    />
  );
}
