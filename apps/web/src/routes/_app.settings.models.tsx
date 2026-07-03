import { createFileRoute } from "@tanstack/react-router";

import { ModelsPanel } from "../components/settings/ModelsPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/settings/models")({ component: ModelsRoute });

function ModelsRoute() {
  return (
    <WorkspaceGate title="Models">
      {({ workspaceId, canManage }) => (
        <ModelsPanel workspaceId={workspaceId} canManage={canManage} />
      )}
    </WorkspaceGate>
  );
}
