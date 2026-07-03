import { createFileRoute } from "@tanstack/react-router";
import { Blocks, Plus } from "lucide-react";

import { SectionPage } from "../components/SectionPage";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export const Route = createFileRoute("/_app/context")({
  component: ContextPage,
});

function ContextPage() {
  return (
    <SectionPage
      title="Context"
      listHint="MCP servers and skills will appear here."
    >
      <EmptyState
        icon={Blocks}
        title="No context sources yet"
        description="Connect MCP servers and author skills your agents can draw on."
        action={
          <Button variant="ghost" size="sm">
            <Plus size={14} aria-hidden="true" />
            Add context
          </Button>
        }
      />
    </SectionPage>
  );
}
