import { createFileRoute } from "@tanstack/react-router";
import { Bot } from "lucide-react";

import { AgentsGrid } from "../components/agents/AgentsGrid";
import { FixtureAgentsGrid } from "../components/agents/FixtureAgentsGrid";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import { useActiveWorkspaceId } from "../lib/workspace";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsIndex,
});

function AgentsIndex() {
  const { workspaceId, isPending: workspacePending } = useActiveWorkspaceId();

  if (FIXTURE_MODE) return <FixtureAgentsGrid />;

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
          icon={Bot}
          title="No active workspace"
          description="Select or create a workspace to hire agents."
        />
      </Panel>
    );
  }

  return <AgentsGrid workspaceId={workspaceId} />;
}
