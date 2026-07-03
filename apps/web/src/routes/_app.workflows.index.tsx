import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Hand,
  Hash,
  KeyRound,
  Plus,
  Timer,
  Webhook,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import type {
  RunStatus,
  WorkflowSummaryDto,
} from "@invisible-string/shared";

import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip, type StatusTone } from "../components/ui/StatusChip";
import { useToast } from "../components/ui/Toast";
import { emptyDefinition } from "../lib/builder/model";
import { cn } from "../lib/cn";
import { useAgentPresets } from "../lib/queries/agent-presets";
import { useSessions } from "../lib/queries/sessions";
import { useCreateWorkflow, useWorkflows } from "../lib/queries/workflows";
import { errorMessage } from "../lib/forms";
import { useActiveWorkspaceId } from "../lib/workspace";

export const Route = createFileRoute("/_app/workflows/")({
  component: WorkflowsIndex,
});

const TRIGGER_ICON: Record<string, ComponentType<{ size?: number }>> = {
  manual: Hand,
  form: KeyRound,
  webhook: Webhook,
  slack: Hash,
  schedule: Timer,
};

const RUN_STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: "neutral",
  running: "neutral",
  waiting: "warning",
  succeeded: "success",
  failed: "error",
  canceled: "neutral",
};

function WorkflowsIndex() {
  const { workspaceId, isPending: workspacePending } = useActiveWorkspaceId();

  if (workspacePending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} className="text-ink-4" />
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <Panel className="panel-enter flex h-full items-center justify-center">
        <EmptyState
          icon={Zap}
          title="No active workspace"
          description="Select or create a workspace to build workflows."
        />
      </Panel>
    );
  }

  return <WorkflowsList workspaceId={workspaceId} />;
}

function WorkflowsList({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const workflows = useWorkflows(workspaceId);
  const sessions = useSessions(workspaceId);
  const agentPresets = useAgentPresets(workspaceId);
  const createWorkflow = useCreateWorkflow(workspaceId);

  // Latest run status per workflow (sessions are ordered by activity desc).
  const lastRunByWorkflow = new Map<string, RunStatus>();
  for (const session of sessions.data ?? []) {
    if (session.lastRunStatus && !lastRunByWorkflow.has(session.workflowId)) {
      lastRunByWorkflow.set(session.workflowId, session.lastRunStatus);
    }
  }

  async function createNew() {
    const firstPreset = agentPresets.data?.[0];
    try {
      const result = await createWorkflow.mutateAsync({
        name: "Untitled workflow",
        draft: firstPreset ? emptyDefinition(firstPreset.id) : undefined,
      });
      navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: result.workflow.id },
      });
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  const newButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={createNew}
      loading={createWorkflow.isPending}
    >
      <Plus size={14} aria-hidden="true" />
      New workflow
    </Button>
  );

  const list = workflows.data ?? [];

  return (
    <div className="flex h-full gap-5">
      <Panel
        aria-label="Workflows list"
        className="panel-enter flex w-72 shrink-0 flex-col md:w-80"
      >
        <header className="flex items-center justify-between px-5 pb-3 pt-5">
          <h1 className="text-[17px]">Workflows</h1>
          {newButton}
        </header>
        <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />

        {workflows.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={18} className="text-ink-4" />
          </div>
        ) : workflows.isError ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-[13px] text-ink-3">
              Could not load workflows.{" "}
              <button
                type="button"
                onClick={() => workflows.refetch()}
                className="underline underline-offset-2 hover:text-ink"
              >
                Retry
              </button>
            </p>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 py-8">
            <p className="text-center text-[13px] leading-relaxed text-ink-4">
              No workflows yet. Create one to get started.
            </p>
          </div>
        ) : (
          <ul className="thin-scroll flex flex-1 flex-col gap-1 overflow-y-auto p-2">
            {list.map((workflow) => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                lastRunStatus={lastRunByWorkflow.get(workflow.id) ?? null}
                onOpen={() =>
                  navigate({
                    to: "/workflows/$workflowId",
                    params: { workflowId: workflow.id },
                  })
                }
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        <EmptyState
          icon={Zap}
          title={list.length === 0 ? "No workflows yet" : "Select a workflow"}
          description={
            list.length === 0
              ? "Assemble a trigger, context, agent, and instructions into an agent that runs in the cloud."
              : "Choose a workflow from the list to open the builder, or create a new one."
          }
          action={list.length === 0 ? newButton : undefined}
        />
      </Panel>
    </div>
  );
}

function WorkflowRow({
  workflow,
  lastRunStatus,
  onOpen,
}: {
  workflow: WorkflowSummaryDto;
  lastRunStatus: RunStatus | null;
  onOpen: () => void;
}) {
  const Icon = workflow.triggerType
    ? (TRIGGER_ICON[workflow.triggerType] ?? Bot)
    : Bot;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "lift flex w-full flex-col gap-1.5 rounded-card px-3 py-2.5 text-left",
          "hover:bg-black/[0.04]",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-3">
            <Icon size={14} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
            {workflow.name}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-9">
          {workflow.publishedVersionId ? (
            <StatusChip tone="success" dot>
              Published
            </StatusChip>
          ) : (
            <StatusChip tone="neutral" dot>
              Draft
            </StatusChip>
          )}
          {lastRunStatus ? (
            <StatusChip tone={RUN_STATUS_TONE[lastRunStatus]}>
              {lastRunStatus}
            </StatusChip>
          ) : null}
        </div>
      </button>
    </li>
  );
}
