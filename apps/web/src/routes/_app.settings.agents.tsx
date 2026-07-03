import { createFileRoute } from "@tanstack/react-router";

import { AgentPresetsPanel } from "../components/settings/AgentPresetsPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/settings/agents")({ component: AgentsRoute });

function AgentsRoute() {
  return (
    <WorkspaceGate title="Agent presets">
      {({ workspaceId, canManage }) => (
        <AgentPresetsPanel workspaceId={workspaceId} canManage={canManage} />
      )}
    </WorkspaceGate>
  );
}
