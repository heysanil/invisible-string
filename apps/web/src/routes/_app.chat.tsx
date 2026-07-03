import { createFileRoute } from "@tanstack/react-router";
import { MessageCircle, Plus } from "lucide-react";

import { SectionPage } from "../components/SectionPage";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export const Route = createFileRoute("/_app/chat")({ component: ChatPage });

function ChatPage() {
  return (
    <SectionPage title="Chat" listHint="Your sessions will appear here.">
      <EmptyState
        icon={MessageCircle}
        title="No conversations yet"
        description="Start a session with a workflow and watch its runs stream here live."
        action={
          <Button variant="ghost" size="sm">
            <Plus size={14} aria-hidden="true" />
            New chat
          </Button>
        }
      />
    </SectionPage>
  );
}
