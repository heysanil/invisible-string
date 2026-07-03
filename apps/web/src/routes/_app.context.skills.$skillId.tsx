import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SkillEditor } from "../components/context/SkillEditor";
import { WorkspaceGate } from "../components/WorkspaceGate";
import type { ScopeRef } from "../lib/queries/keys";

type SkillScope = "workspace" | "personal";

export const Route = createFileRoute("/_app/context/skills/$skillId")({
  validateSearch: (search): { scope: SkillScope } => ({
    scope: search["scope"] === "personal" ? "personal" : "workspace",
  }),
  component: SkillEditorRoute,
});

function SkillEditorRoute() {
  const { skillId } = Route.useParams();
  const { scope } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <WorkspaceGate title="Skill">
      {({ workspaceId, canManage }) => {
        const scopeRef: ScopeRef =
          scope === "personal"
            ? { scope: "user" }
            : { scope: "workspace", workspaceId };
        const readOnly = scope === "workspace" ? !canManage : false;
        return (
          <SkillEditor
            scope={scopeRef}
            skillId={skillId}
            readOnly={readOnly}
            onBack={() => void navigate({ to: "/context" })}
          />
        );
      }}
    </WorkspaceGate>
  );
}
