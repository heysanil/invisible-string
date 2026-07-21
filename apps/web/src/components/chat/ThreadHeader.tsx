/**
 * Thread header: session title, monogram-fronted agent chip + pinned agent
 * version, resolved model chip, a workflow provenance chip for
 * trigger-origin sessions, and an "Edit agent ↗" link into the agent editor.
 */
import { ArrowUpRight, Cpu, GitBranch, Zap } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { AgentMonogram } from "../agents/AgentMonogram";
import { livenessOf, StatusDot, type Liveness } from "./StatusDot";
import { Chip } from "./Chip";
import type {
  AgentSessionStatus,
  RunStatus,
} from "@invisible-string/shared";

export interface ThreadHeaderProps {
  title: string;
  agentName: string;
  agentId: string;
  /** Pinned agent version (short hash / id) — the session's frozen version. */
  versionLabel: string | null;
  /** Resolved model id from the run's session.started event. */
  modelId: string | null;
  /** Workflow provenance — set only for trigger-origin sessions. */
  workflowName: string | null;
  sessionStatus: AgentSessionStatus;
  lastRunStatus: RunStatus | null;
}

const LIVENESS_TEXT: Record<Liveness, string> = {
  running: "Running",
  waiting: "Waiting for your input",
  error: "Failed",
  idle: "Idle",
};

export function ThreadHeader({
  title,
  agentName,
  agentId,
  versionLabel,
  modelId,
  workflowName,
  sessionStatus,
  lastRunStatus,
}: ThreadHeaderProps) {
  const liveness = livenessOf(sessionStatus, lastRunStatus);
  return (
    <header className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot state={liveness} />
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {title}
          </h1>
          <span className="shrink-0 text-[11px] text-ink-4">
            {LIVENESS_TEXT[liveness]}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip
            leading={
              // Chip-scale monogram: the important overrides win over the
              // size preset (cn has no tailwind-merge).
              <AgentMonogram
                name={agentName}
                size="sm"
                className="size-4! text-[8px]!"
              />
            }
            title="Agent"
          >
            {agentName}
          </Chip>
          {versionLabel !== null ? (
            <Chip icon={GitBranch} mono title="Pinned agent version">
              {versionLabel}
            </Chip>
          ) : null}
          {modelId !== null ? (
            <Chip icon={Cpu} mono title="Resolved model">
              {modelId}
            </Chip>
          ) : null}
          {workflowName !== null ? (
            <Chip icon={Zap} title="Started by workflow">
              {workflowName}
            </Chip>
          ) : null}
        </div>
      </div>
      <Link
        to="/agents/$agentId"
        params={{ agentId }}
        className="lift inline-flex h-8 shrink-0 items-center gap-1 rounded-capsule border border-black/10 bg-white/40 px-3 text-[12.5px] font-medium text-ink-2 hover:bg-white/70 hover:text-ink"
      >
        Edit agent
        <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
      </Link>
    </header>
  );
}
