/**
 * Chat section shell: floating glass session-list panel + floating glass
 * thread pane. Owns session selection, the "New chat" workflow picker, and
 * the create-session round-trip. Live thread rendering lives in
 * {@link ThreadContainer}; this component is the two-panel frame + list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Workflow } from "lucide-react";

import type { WorkflowSummaryDto } from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import {
  useCreateSession,
  useSessions,
  useWorkflows,
} from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { Composer } from "./Composer";
import { SessionList, type SessionListItem } from "./SessionList";
import { ThreadContainer } from "./ThreadContainer";
import { WorkflowPicker } from "./WorkflowPicker";

export function ChatShell({
  workspaceId,
  initialWorkflowId,
}: {
  workspaceId: string;
  /** When set (from the builder's Run draft), open a new chat for this workflow. */
  initialWorkflowId?: string;
}) {
  const toast = useToast();
  const sessionsQuery = useSessions(workspaceId);
  const workflowsQuery = useWorkflows(workspaceId);
  const createSession = useCreateSession(workspaceId);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Workflow chosen in the picker → the composer collects the first message. */
  const [draftWorkflow, setDraftWorkflow] = useState<WorkflowSummaryDto | null>(
    null,
  );

  // Deep-link from the builder: once workflows load, open the new-chat composer
  // for the requested workflow. Honored once so the user can freely navigate
  // away without it re-triggering.
  const deepLinkHandled = useRef<string | null>(null);
  const workflows = workflowsQuery.data;
  useEffect(() => {
    if (!initialWorkflowId || deepLinkHandled.current === initialWorkflowId) {
      return;
    }
    if (!workflows) return;
    const match = workflows.find((w) => w.id === initialWorkflowId);
    deepLinkHandled.current = initialWorkflowId;
    if (match) {
      setDraftWorkflow(match);
      setActiveSessionId(null);
    }
  }, [initialWorkflowId, workflows]);

  const sessions: SessionListItem[] = useMemo(
    () =>
      (sessionsQuery.data ?? []).map((session) => ({
        ...session,
        title: session.workflowName,
      })),
    [sessionsQuery.data],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  function startSession(workflow: WorkflowSummaryDto, message: string) {
    createSession.mutate(
      { workflowId: workflow.id, message },
      {
        onSuccess: (data) => {
          setActiveSessionId(data.session.id);
          setDraftWorkflow(null);
        },
        onError: (error) => {
          toast.toast({ variant: "error", message: errorMessage(error) });
        },
      },
    );
  }

  return (
    <div className="flex h-full gap-5">
      <Panel
        aria-label="Chat sessions"
        className="panel-enter hidden w-80 shrink-0 flex-col overflow-hidden md:flex"
      >
        <SessionList
          sessions={sessions}
          isLoading={sessionsQuery.isLoading}
          activeSessionId={draftWorkflow !== null ? null : activeSessionId}
          onSelect={(id) => {
            setDraftWorkflow(null);
            setActiveSessionId(id);
          }}
          onNewChat={() => setPickerOpen(true)}
        />
      </Panel>

      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        {draftWorkflow !== null ? (
          <NewChatComposer
            workflow={draftWorkflow}
            sending={createSession.isPending}
            onSend={(message) => startSession(draftWorkflow, message)}
            onCancel={() => setDraftWorkflow(null)}
          />
        ) : activeSession !== null ? (
          <ThreadContainer
            key={activeSession.id}
            workspaceId={workspaceId}
            sessionId={activeSession.id}
            workflowName={activeSession.workflowName}
          />
        ) : (
          <EmptyState
            icon={MessageSquare}
            title="Pick up a conversation"
            description="Select a session on the left, or start a new chat with a published workflow."
          />
        )}
      </Panel>

      {pickerOpen ? (
        <WorkflowPicker
          workflows={workflowsQuery.data ?? []}
          onPick={(workflow) => {
            setDraftWorkflow(workflow);
            setActiveSessionId(null);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** First-message composer shown after a workflow is chosen for a new chat. */
function NewChatComposer({
  workflow,
  sending,
  onSend,
  onCancel,
}: {
  workflow: WorkflowSummaryDto;
  sending: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {workflow.name}
          </h1>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="lift h-8 rounded-capsule px-3 text-[12.5px] font-medium text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          Cancel
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={MessageSquare}
          title={`New chat with ${workflow.name}`}
          description="Send the first message to start this workflow. Its runs will stream here live."
        />
      </div>
      <div className="mx-auto w-full max-w-3xl">
        <Composer
          autoFocus
          onSend={onSend}
          sending={sending}
          placeholder={`Message ${workflow.name}…`}
        />
      </div>
    </div>
  );
}
