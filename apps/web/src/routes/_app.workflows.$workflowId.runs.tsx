/**
 * Run history for one workflow (the Runs tab). Each row: trigger glyph ·
 * started-at · duration · status chip · the failure message for failed runs.
 * Rows link to the run's step timeline (runs.$runId — this route renders the
 * child via its Outlet INSTEAD of the list while one is open, so a run URL is
 * shareable and survives reload).
 *
 * The list polls gently while any run is still moving; per-run live progress
 * rides the run's own SSE stream in the detail view.
 */
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import {
  Hand,
  Hash,
  KeyRound,
  ListChecks,
  Timer,
  Webhook,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import { isRunSettledStatus, type RunDto } from "@invisible-string/shared";

import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip } from "../components/ui/StatusChip";
import { useWorkflowRuns } from "../lib/pipeline/queries";
import { RUN_STATUS_TONE, runDuration } from "../lib/pipeline/run-display";
import { useWorkflowShell } from "../lib/pipeline/workflow-shell";
import { formatRelativeTime } from "../lib/format";
import { cn } from "../lib/cn";

export const Route = createFileRoute("/_app/workflows/$workflowId/runs")({
  component: WorkflowRuns,
});

const TRIGGER_ICON: Record<string, ComponentType<{ size?: number }>> = {
  manual: Hand,
  form: KeyRound,
  webhook: Webhook,
  slack: Hash,
  schedule: Timer,
};

function WorkflowRuns() {
  // A selected run replaces the list (its own header row links back here).
  const childOpen = useChildMatches().length > 0;
  if (childOpen) return <Outlet />;
  return <RunsList />;
}

function RunsList() {
  const { workspaceId, workflow } = useWorkflowShell();
  const runs = useWorkflowRuns(workspaceId, workflow.id);

  return (
    <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between px-5 pb-3 pt-5">
        <h2 className="text-[15px] font-semibold">Runs</h2>
        <span className="text-[12px] text-ink-4">
          {runs.data !== undefined
            ? `${runs.data.length} run${runs.data.length === 1 ? "" : "s"}`
            : null}
        </span>
      </header>
      <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />

      {runs.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={18} className="text-ink-4" />
        </div>
      ) : runs.isError ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-[13px] text-ink-3">
            Could not load runs.{" "}
            <button
              type="button"
              onClick={() => void runs.refetch()}
              className="underline underline-offset-2 hover:text-ink"
            >
              Retry
            </button>
          </p>
        </div>
      ) : runs.data.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ListChecks}
            title="No runs yet"
            description="Publish the workflow, then start one from the Run button — every dispatch lands here with its step timeline."
          />
        </div>
      ) : (
        <ul className="thin-scroll flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {runs.data.map((run) => (
            <RunRow key={run.id} workflowId={workflow.id} run={run} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RunRow({ workflowId, run }: { workflowId: string; run: RunDto }) {
  const Icon = TRIGGER_ICON[run.triggerEvent.triggerType] ?? Zap;
  const duration = runDuration(run);
  const active = !isRunSettledStatus(run.status);
  return (
    <li>
      <Link
        to="/workflows/$workflowId/runs/$runId"
        params={{ workflowId, runId: run.id }}
        data-testid="run-row"
        className={cn(
          "lift flex w-full flex-col gap-1 rounded-card px-3 py-2.5 text-left",
          "hover:bg-black/[0.04]",
        )}
      >
        <span className="flex items-center gap-2.5">
          <span
            title={`${run.triggerEvent.triggerType} trigger`}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-3"
          >
            <Icon size={14} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {formatRelativeTime(run.createdAt)}
          </span>
          {duration !== null ? (
            <span className="shrink-0 text-[11.5px] tabular-nums text-ink-4">
              {duration}
            </span>
          ) : active ? (
            <Spinner size={12} className="shrink-0 text-ink-4" />
          ) : null}
          <StatusChip tone={RUN_STATUS_TONE[run.status]} dot>
            {run.status}
          </StatusChip>
        </span>
        {run.status === "failed" && run.error !== null ? (
          <span className="truncate pl-[38px] text-[12px] text-err">
            {run.error}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
