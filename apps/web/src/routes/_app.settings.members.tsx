import { createFileRoute } from "@tanstack/react-router";

import { MembersPanel } from "../components/settings/MembersPanel";
import { WorkspaceGate } from "../components/WorkspaceGate";
import { useSession } from "../lib/auth-client";

export const Route = createFileRoute("/_app/settings/members")({ component: MembersRoute });

function MembersRoute() {
  const { data: session } = useSession();
  return (
    <WorkspaceGate title="Members">
      {({ workspaceId, canManage }) => (
        <MembersPanel
          workspaceId={workspaceId}
          canManage={canManage}
          currentUserId={session?.user.id}
        />
      )}
    </WorkspaceGate>
  );
}
