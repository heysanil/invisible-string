import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsPanel } from "../components/settings/IntegrationsPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/settings/integrations")({
  component: IntegrationsRoute,
});

function IntegrationsRoute() {
  return (
    <WorkspaceGate title="Integrations">
      {({ workspaceId, canManage }) => (
        <IntegrationsPanel workspaceId={workspaceId} canManage={canManage} />
      )}
    </WorkspaceGate>
  );
}
