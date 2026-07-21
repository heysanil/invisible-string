/**
 * /agents list screen: a single full-width Panel with a responsive card grid
 * — agents are few and identity-rich, so each gets a card (monogram, name,
 * description, lifecycle chip) that links straight into the editor. "New
 * agent" creates an untitled draft and opens it (the editor is the form).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { Bot, Plus } from "lucide-react";
import type { AgentSummaryDto } from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { useAgents, useCreateAgent } from "../../lib/queries/agents";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Panel } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";
import { StatusChip } from "../ui/StatusChip";
import { useToast } from "../ui/Toast";
import { AgentMonogram } from "./AgentMonogram";

export function AgentsGrid({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const agents = useAgents(workspaceId);
  const createAgent = useCreateAgent(workspaceId);

  async function createNew() {
    try {
      const result = await createAgent.mutateAsync({ name: "Untitled agent" });
      navigate({
        to: "/agents/$agentId",
        params: { agentId: result.agent.id },
      });
    } catch (error) {
      toast({ variant: "error", message: errorMessage(error) });
    }
  }

  const newButton = (
    <Button
      variant="primary"
      size="sm"
      onClick={createNew}
      loading={createAgent.isPending}
    >
      {!createAgent.isPending ? <Plus size={14} aria-hidden="true" /> : null}
      New agent
    </Button>
  );

  return (
    <AgentsGridShell action={newButton}>
      {agents.isPending ? (
        <div
          role="status"
          aria-label="Loading agents"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full rounded-card-lg" />
          ))}
        </div>
      ) : agents.isError ? (
        <ErrorState
          message="Could not load this workspace's agents."
          onRetry={() => agents.refetch()}
        />
      ) : (agents.data ?? []).length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Agents are reusable teammates — a persona, a model, and the tools they're trusted with. Create one to chat with it or delegate workflows to it."
          action={newButton}
        />
      ) : (
        <AgentCardGrid agents={agents.data ?? []} />
      )}
    </AgentsGridShell>
  );
}

/** The Panel frame (header row + body) — shared with the fixture branch. */
export function AgentsGridShell({
  action,
  children,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel className="panel-enter flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 pb-3 pt-5">
        <h1 className="text-[17px]">Agents</h1>
        {action}
      </header>
      <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />
      <div className="thin-scroll flex-1 overflow-y-auto p-6">{children}</div>
    </Panel>
  );
}

/** Responsive card grid — presentational (fixture mode reuses it). */
export function AgentCardGrid({
  agents,
}: {
  agents: readonly AgentSummaryDto[];
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <li key={agent.id}>
          <AgentCard agent={agent} />
        </li>
      ))}
    </ul>
  );
}

function AgentCard({ agent }: { agent: AgentSummaryDto }) {
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.id }}
      className="lift flex h-full flex-col gap-3 rounded-card-lg border border-black/10 bg-white/40 p-4 hover:bg-white/60"
    >
      <div className="flex items-start gap-3">
        <AgentMonogram name={agent.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold text-ink">
            {agent.name}
          </span>
          {agent.description ? (
            <span className="line-clamp-2 text-[12px] leading-snug text-ink-3">
              {agent.description}
            </span>
          ) : (
            <span className="text-[12px] italic text-ink-4">No description</span>
          )}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <AgentLifecycleChip agent={agent} />
      </div>
    </Link>
  );
}

/**
 * Lifecycle chip: Published (green dot) / Draft (neutral dot); a published
 * version whose build failed surfaces as the red "Build failed" state, and an
 * in-flight build as a quiet "Building…".
 */
export function AgentLifecycleChip({ agent }: { agent: AgentSummaryDto }) {
  if (agent.publishedVersionId === null) {
    return (
      <StatusChip tone="neutral" dot>
        Draft
      </StatusChip>
    );
  }
  if (agent.buildStatus === "failed") {
    return <StatusChip tone="error">Build failed</StatusChip>;
  }
  if (agent.buildStatus === "pending" || agent.buildStatus === "building") {
    return <StatusChip tone="neutral">Building…</StatusChip>;
  }
  return (
    <StatusChip tone="success" dot>
      Published
    </StatusChip>
  );
}
