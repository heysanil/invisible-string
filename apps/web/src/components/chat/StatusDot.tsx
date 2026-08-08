/**
 * Session/run liveness indicator — color is meaning only (E1):
 * running ● ink pulsing · waiting ⏸ amber · error ✗ red · idle/stopped neutral.
 *
 * `stopped` deliberately shares the NEUTRAL dot with `idle` and differs only
 * in its label: a user stopping their own run is a decision, not a fault, so
 * painting it `#dc2626` would lie. It is a distinct state rather than plain
 * `idle` because "Stopped" is the honest answer to "what happened here?".
 */
import type {
  AgentSessionStatus,
  RunStatus,
} from "@invisible-string/shared";

import { cn } from "../../lib/cn";

export type Liveness = "running" | "waiting" | "error" | "stopped" | "idle";

/** Collapse session + last-run status into one indicator state. */
export function livenessOf(
  session: AgentSessionStatus,
  lastRunStatus: RunStatus | null,
): Liveness {
  if (lastRunStatus === "queued" || lastRunStatus === "running") return "running";
  if (session === "waiting" || lastRunStatus === "waiting") return "waiting";
  if (session === "error" || lastRunStatus === "failed") return "error";
  if (lastRunStatus === "canceled") return "stopped";
  return "idle";
}

const LIVENESS_LABEL: Record<Liveness, string> = {
  running: "Running",
  waiting: "Waiting for input",
  error: "Failed",
  stopped: "Stopped",
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
        (state === "stopped" || state === "idle") && "bg-black/20",
        className,
      )}
    />
  );
}
