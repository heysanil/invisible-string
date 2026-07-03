import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import { ChatShell } from "../components/chat/ChatShell";
import { FixtureChatShell } from "../components/chat/FixtureChatShell";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import { useActiveWorkspaceId } from "../lib/workspace";

interface ChatSearch {
  /** Preselected workflow to open a new chat for (from the builder's Run draft). */
  workflow?: string;
}

export const Route = createFileRoute("/_app/chat")({
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    workflow:
      typeof search.workflow === "string" && search.workflow.length > 0
        ? search.workflow
        : undefined,
  }),
});

function ChatPage() {
  const { workspaceId } = useActiveWorkspaceId();
  const { workflow: initialWorkflowId } = Route.useSearch();

  if (FIXTURE_MODE) return <FixtureChatShell />;

  // No active workspace yet (first load before the org resolves): keep the
  // section frame with a designed empty state rather than a blank pane.
  if (workspaceId === null) {
    return (
      <div className="flex h-full gap-5">
        <Panel
          aria-label="Chat sessions"
          className="panel-enter hidden w-80 shrink-0 flex-col overflow-hidden md:flex"
        >
          <header className="px-4 pb-3 pt-4">
            <h1 className="text-[17px]">Chat</h1>
          </header>
          <div className="mx-4 h-px bg-black/[0.06]" aria-hidden="true" />
          <EmptyState
            icon={MessageSquare}
            title="No conversations yet"
            description="Start a session with a workflow and watch its runs stream here live."
          />
        </Panel>
        <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
          <EmptyState
            icon={MessageSquare}
            title="Pick up a conversation"
            description="Select a session on the left, or start a new chat with a published workflow."
          />
        </Panel>
      </div>
    );
  }

  return (
    <ChatShell workspaceId={workspaceId} initialWorkflowId={initialWorkflowId} />
  );
}
