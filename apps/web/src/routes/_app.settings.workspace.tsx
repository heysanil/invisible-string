import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePanel } from "../components/settings/WorkspacePanel";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/settings/workspace")({
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  return (
    <WorkspaceGate title="Workspace">
      {({ workspaceId, workspaceName, canManage }) => (
        <WorkspacePanel
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canManage={canManage}
        />
      )}
    </WorkspaceGate>
  );
}
