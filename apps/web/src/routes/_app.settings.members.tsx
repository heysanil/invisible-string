import { createFileRoute } from "@tanstack/react-router";

import { MembersPanel } from "../components/settings/MembersPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";
import { useViewer } from "../lib/auth/viewer";

export const Route = createFileRoute("/_app/settings/members")({ component: MembersRoute });

function MembersRoute() {
  const { viewer } = useViewer();
  return (
    <WorkspaceGate title="Members">
      {({ workspaceId, canManage }) => (
        <MembersPanel
          workspaceId={workspaceId}
          canManage={canManage}
          currentUserId={viewer?.user.id}
        />
      )}
    </WorkspaceGate>
  );
}
