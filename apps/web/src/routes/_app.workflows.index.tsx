/**
 * Workflows list — two-panel shape: the row list (trigger icon, agent chip,
 * Published/Draft + last-run state) and a right-pane explainer. A workflow is
 * a standing delegation: when a trigger fires, the chosen agent follows the
 * instructions. New workflows seed their draft with the workspace's first
 * PUBLISHED agent when one exists — no agent yet is a legal draft (the editor
 * surfaces the gap).
 */
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
import type { RunStatus, WorkflowSummaryDto } from "@invisible-string/shared";

import { monogramInitials } from "../components/agents/AgentMonogram";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip, type StatusTone } from "../components/ui/StatusChip";
import { useToast } from "../components/ui/Toast";
import { emptyDefinition } from "../lib/builder/model";
import { cn } from "../lib/cn";
import { useAgents } from "../lib/queries/agents";
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

const DELEGATION_COPY =
  "A workflow delegates work to an agent: when a trigger fires, your chosen agent follows the instructions.";

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
  const agents = useAgents(workspaceId);
  const createWorkflow = useCreateWorkflow(workspaceId);

  // Latest run status per workflow (sessions are ordered by activity desc);
  // chat sessions carry no workflow provenance and are skipped.
  const lastRunByWorkflow = new Map<string, RunStatus>();
  for (const session of sessions.data ?? []) {
    if (
      session.workflowId !== null &&
      session.lastRunStatus &&
      !lastRunByWorkflow.has(session.workflowId)
    ) {
      lastRunByWorkflow.set(session.workflowId, session.lastRunStatus);
    }
  }

  async function createNew() {
    // Seed the delegation with the first PUBLISHED agent; none yet is fine —
    // the editor's Agent section surfaces the gap and links to /agents.
    const firstPublished =
      agents.data?.find((agent) => agent.publishedVersionId !== null) ?? null;
    try {
      const result = await createWorkflow.mutateAsync({
        name: "Untitled workflow",
        draft: emptyDefinition(firstPublished?.id ?? null),
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
              ? DELEGATION_COPY
              : `${DELEGATION_COPY} Choose one from the list to open its editor, or create a new one.`
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
    ? (TRIGGER_ICON[workflow.triggerType] ?? Zap)
    : Zap;
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
          <AgentChip agentName={workflow.agentName} />
          {workflow.publishedAt !== null ? (
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

/** Who the workflow delegates to — tiny monogram + name (or the gap). */
function AgentChip({ agentName }: { agentName: string | null }) {
  if (agentName === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-capsule border border-dashed border-black/15 px-2 py-[2px] text-[11px] font-medium text-ink-4">
        <Bot size={10} aria-hidden="true" /> No agent
      </span>
    );
  }
  return (
    <span
      data-testid="workflow-agent-chip"
      className="inline-flex max-w-full items-center gap-1 rounded-capsule border border-black/[0.08] bg-white/50 py-[2px] pl-[2px] pr-2 text-[11px] font-medium text-ink-2"
    >
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 select-none items-center justify-center rounded-full bg-black/[0.06] text-[7.5px] font-semibold tracking-wide text-ink-3"
      >
        {monogramInitials(agentName)}
      </span>
      <span className="truncate">{agentName}</span>
    </span>
  );
}
