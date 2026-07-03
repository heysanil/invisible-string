import { createFileRoute } from "@tanstack/react-router";
import { Settings, UserPlus } from "lucide-react";

import { SectionPage } from "../components/SectionPage";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <SectionPage
      title="Settings"
      listHint="Workspace and account settings will appear here."
    >
      <EmptyState
        icon={Settings}
        title="Workspace settings"
        description="Members, model presets, allowlists, and integrations will live here."
        action={
          <Button variant="ghost" size="sm">
            <UserPlus size={14} aria-hidden="true" />
            Invite teammates
          </Button>
        }
      />
    </SectionPage>
  );
}
