import { createFileRoute } from "@tanstack/react-router";

import { AllowlistPanel } from "../components/settings/AllowlistPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/settings/allowlist")({
  component: AllowlistRoute,
});

function AllowlistRoute() {
  return (
    <WorkspaceGate title="Allowlist">
      {({ workspaceId, canManage }) => (
        <AllowlistPanel workspaceId={workspaceId} canManage={canManage} />
      )}
    </WorkspaceGate>
  );
}
