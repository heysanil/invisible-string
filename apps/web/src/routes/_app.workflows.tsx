import { createFileRoute } from "@tanstack/react-router";
import { Plus, Zap } from "lucide-react";

import { SectionPage } from "../components/SectionPage";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export const Route = createFileRoute("/_app/workflows")({
  component: WorkflowsPage,
});

function WorkflowsPage() {
  return (
    <SectionPage title="Workflows" listHint="Workflows you build will appear here.">
      <EmptyState
        icon={Zap}
        title="No workflows yet"
        description="Assemble a trigger, context, agent, and instructions into an agent that runs in the cloud."
        action={
          <Button variant="ghost" size="sm">
            <Plus size={14} aria-hidden="true" />
            New workflow
          </Button>
        }
      />
    </SectionPage>
  );
}
