import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ContextHome, type ContextScopeTab } from "../components/context/ContextHome";
import { WorkspaceGate } from "../components/WorkspaceGate";

export const Route = createFileRoute("/_app/context/")({ component: ContextIndex });

function ContextIndex() {
  const navigate = useNavigate();

  function openSkill(scope: ContextScopeTab, skillId: string) {
    void navigate({
      to: "/context/skills/$skillId",
      params: { skillId },
      search: { scope },
    });
  }

  return (
    <WorkspaceGate title="Context">
      {({ workspaceId, canManage }) => (
        <ContextHome
          workspaceId={workspaceId}
          canManage={canManage}
          onOpenSkill={openSkill}
        />
      )}
    </WorkspaceGate>
  );
}
