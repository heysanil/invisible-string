import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert } from "lucide-react";

import { AgentEditorScreen } from "../components/agents/AgentEditorScreen";
import { FixtureAgentEditor } from "../components/agents/FixtureAgentEditor";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { useContextResources } from "../lib/builder/resources";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import { useAgent } from "../lib/queries/agents";
import { useWorkspaceMembers } from "../lib/queries/members";
import { useModelAllowlist, useModelPresets } from "../lib/queries/models";
import { useActiveWorkspaceId, useWorkspaceRole } from "../lib/workspace";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentEditorRoute,
});

function AgentEditorRoute() {
  const { agentId } = Route.useParams();
  const { workspaceId, isPending: workspacePending } = useActiveWorkspaceId();

  if (FIXTURE_MODE) return <FixtureAgentEditor agentId={agentId} />;

  if (workspacePending) return <CenteredSpinner />;
  if (!workspaceId) {
    return (
      <EditorShell>
        <EmptyState
          icon={CircleAlert}
          title="No active workspace"
          description="Select a workspace to open the agent editor."
        />
      </EditorShell>
    );
  }
  return <AgentEditorLoader workspaceId={workspaceId} agentId={agentId} />;
}

function AgentEditorLoader({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const agent = useAgent(workspaceId, agentId);
  const resources = useContextResources(workspaceId);
  const members = useWorkspaceMembers(workspaceId);
  const modelPresets = useModelPresets(workspaceId);
  const allowlist = useModelAllowlist(workspaceId);
  const { canManage } = useWorkspaceRole(workspaceId);

  if (agent.isPending) return <CenteredSpinner />;

  if (agent.isError || !agent.data) {
    return (
      <EditorShell>
        <EmptyState
          icon={CircleAlert}
          title="Agent not found"
          description="It may have been deleted. Head back to the list to pick another."
          action={
            <Link
              to="/agents"
              className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-4 py-2 text-[13px] font-medium text-ink"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to agents
            </Link>
          }
        />
      </EditorShell>
    );
  }

  return (
    <AgentEditorScreen
      // Remount cleanly when switching between agents.
      key={agent.data.id}
      workspaceId={workspaceId}
      agent={agent.data}
      resources={resources}
      members={members.data ?? []}
      modelPresets={modelPresets.data ?? []}
      allowlist={allowlist.data ?? null}
      canManage={canManage}
    />
  );
}

// ── shells ──────────────────────────────────────────────────────────────────

function EditorShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <Panel className="panel-enter flex h-full items-center justify-center">
        {children}
      </Panel>
    </div>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} className="text-ink-4" />
    </div>
  );
}
