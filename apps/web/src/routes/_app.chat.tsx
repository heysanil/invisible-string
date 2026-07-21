import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import { ChatShell } from "../components/chat/ChatShell";
import { FixtureChatShell } from "../components/chat/FixtureChatShell";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { FIXTURE_MODE } from "../lib/chat/fixtures";
import { useActiveWorkspaceId } from "../lib/workspace";

interface ChatSearch {
  /** Preselected agent to open a new chat for (from the agent editor's "Chat with agent"). */
  agent?: string;
  /** Session to open directly (from the workflow editor's test-run "View in Chat"). */
  session?: string;
}

export const Route = createFileRoute("/_app/chat")({
  component: ChatPage,
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    agent:
      typeof search.agent === "string" && search.agent.length > 0
        ? search.agent
        : undefined,
    session:
      typeof search.session === "string" && search.session.length > 0
        ? search.session
        : undefined,
  }),
});

function ChatPage() {
  const { workspaceId } = useActiveWorkspaceId();
  const { agent: initialAgentId, session: initialSessionId } = Route.useSearch();

  // Fixture mode still honors the agent deep link — the fixture agent
  // editor's "Chat with agent" capsule navigates with ?agent=<id> and must
  // open the new-chat composer, not silently drop the pick.
  if (FIXTURE_MODE) return <FixtureChatShell initialAgentId={initialAgentId} />;

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
            description="Start a chat with an agent and watch its replies stream here live."
          />
        </Panel>
        <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
          <EmptyState
            icon={MessageSquare}
            title="Pick up a conversation"
            description="Select a session on the left, or start a new chat with an agent."
          />
        </Panel>
      </div>
    );
  }

  return (
    <ChatShell
      workspaceId={workspaceId}
      initialAgentId={initialAgentId}
      initialSessionId={initialSessionId}
    />
  );
}
