/**
 * Chat section shell: floating glass session-list panel + floating glass
 * thread pane. Owns session selection, the "New chat" agent picker, and the
 * create-session round-trip. Live thread rendering lives in
 * {@link ThreadContainer}; this component is the two-panel frame + list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Cpu, MessageSquare } from "lucide-react";

import type { AgentSummaryDto } from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import {
  fetchAgent,
  queryKeys,
  useAgents,
  useCreateSession,
  useSessions,
} from "../../lib/queries";
import { AgentMonogram } from "../agents/AgentMonogram";
import { useToast } from "../ui/Toast";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { AgentPicker, agentModelLabel } from "./AgentPicker";
import { Chip } from "./Chip";
import { Composer } from "./Composer";
import { DiscardQueueDialog } from "./DiscardQueueDialog";
import { SessionList, type SessionListItem } from "./SessionList";
import { ThreadContainer } from "./ThreadContainer";

/** Where a session switch wants to land: another thread, or the new-chat picker. */
type SwitchTarget = { kind: "session"; sessionId: string } | { kind: "new" };

export function ChatShell({
  workspaceId,
  initialAgentId,
  initialSessionId,
}: {
  workspaceId: string;
  /** When set (from the agent editor's "Chat with agent"), open a new chat for this agent. */
  initialAgentId?: string;
  /** When set (from the workflow editor's test-run "View in Chat"), open this session. */
  initialSessionId?: string;
}) {
  const toast = useToast();
  const sessionsQuery = useSessions(workspaceId);
  const agentsQuery = useAgents(workspaceId);
  const createSession = useCreateSession(workspaceId);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Agent chosen in the picker → the composer collects the first message. */
  const [draftAgent, setDraftAgent] = useState<AgentSummaryDto | null>(null);
  /**
   * Queue depth reported by the live thread. The queue is per-thread state
   * inside a KEYED ThreadContainer, so any switch remounts it and drops the
   * messages — this shell has to ask before that happens.
   */
  const [queuedCount, setQueuedCount] = useState(0);
  /** A switch the user asked for, held until they resolve the discard prompt. */
  const [pendingSwitch, setPendingSwitch] = useState<SwitchTarget | null>(null);

  function applySwitch(target: SwitchTarget) {
    setQueuedCount(0);
    if (target.kind === "new") {
      setPickerOpen(true);
      return;
    }
    setDraftAgent(null);
    setActiveSessionId(target.sessionId);
  }

  function requestSwitch(target: SwitchTarget) {
    if (queuedCount > 0) {
      setPendingSwitch(target);
      return;
    }
    applySwitch(target);
  }

  // Deep-link from the agent editor: once agents load, open the new-chat
  // composer for the requested agent. Honored once so the user can freely
  // navigate away without it re-triggering.
  const deepLinkHandled = useRef<string | null>(null);
  const agents = agentsQuery.data;
  useEffect(() => {
    if (!initialAgentId || deepLinkHandled.current === initialAgentId) {
      return;
    }
    if (!agents) return;
    const match = agents.find((agent) => agent.id === initialAgentId);
    deepLinkHandled.current = initialAgentId;
    if (match) {
      setDraftAgent(match);
      setActiveSessionId(null);
    }
  }, [initialAgentId, agents]);

  // Model chips (picker rows + new-chat header) derive from each agent's
  // PUBLISHED definition — a new session pins the agent's published version,
  // so a draft-only model change must not show up here. The list DTO carries
  // no model; details are fetched lazily (picker open / agent drafted) into
  // the same cache `useAgent` reads, so the editor route reuses them.
  const publishedAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.publishedVersionId !== null),
    [agents],
  );
  const detailsEnabled = pickerOpen || draftAgent !== null;
  const agentDetails = useQueries({
    queries: publishedAgents.map((agent) => ({
      queryKey: queryKeys.agents.detail(workspaceId, agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAgent(workspaceId, agent.id, signal),
      staleTime: 30_000,
      enabled: detailsEnabled,
    })),
  });
  const modelLabels = useMemo(() => {
    const labels = new Map<string, string>();
    agentDetails.forEach((query, index) => {
      const agent = publishedAgents[index];
      const label =
        query.data === undefined
          ? null
          : agentModelLabel(query.data.agent.publishedDefinition);
      if (agent !== undefined && label !== null) labels.set(agent.id, label);
    });
    return labels;
  }, [agentDetails, publishedAgents]);

  const sessions: SessionListItem[] = useMemo(
    () =>
      (sessionsQuery.data ?? []).map((session) => ({
        ...session,
        title: session.agentName,
      })),
    [sessionsQuery.data],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  function startSession(agent: AgentSummaryDto, message: string) {
    createSession.mutate(
      { agentId: agent.id, message },
      {
        onSuccess: (data) => {
          setActiveSessionId(data.session.id);
          setDraftAgent(null);
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
          isError={sessionsQuery.isError}
          error={sessionsQuery.error}
          onRetry={() => void sessionsQuery.refetch()}
          activeSessionId={draftAgent !== null ? null : activeSessionId}
          onSelect={(id) => requestSwitch({ kind: "session", sessionId: id })}
          onNewChat={() => requestSwitch({ kind: "new" })}
        />
      </Panel>

      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        {draftAgent !== null ? (
          <NewChatComposer
            agent={draftAgent}
            modelLabel={modelLabels.get(draftAgent.id) ?? null}
            sending={createSession.isPending}
            onSend={(message) => startSession(draftAgent, message)}
            onCancel={() => setDraftAgent(null)}
          />
        ) : activeSessionId !== null ? (
          // Keyed on the ID, not the list row: a session RESET mints a
          // replacement whose summary has not reached the list query yet, and
          // gating on `activeSession` would flash the empty state at the user
          // in the middle of a deliberate action.
          <ThreadContainer
            key={activeSessionId}
            workspaceId={workspaceId}
            sessionId={activeSessionId}
            agentName={activeSession?.agentName}
            workflowName={activeSession?.workflowName ?? null}
            onSessionReplaced={setActiveSessionId}
            onQueuedCountChange={setQueuedCount}
          />
        ) : (
          <EmptyState
            icon={MessageSquare}
            title="Pick up a conversation"
            description="Select a session on the left, or start a new chat with an agent."
          />
        )}
      </Panel>

      {pickerOpen ? (
        <AgentPicker
          agents={agents ?? []}
          modelLabels={modelLabels}
          onPick={(agent) => {
            setDraftAgent(agent);
            setActiveSessionId(null);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      <DiscardQueueDialog
        open={pendingSwitch !== null}
        count={queuedCount}
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          const target = pendingSwitch;
          setPendingSwitch(null);
          if (target !== null) applySwitch(target);
        }}
      />
    </div>
  );
}

/** First-message composer shown after an agent is chosen for a new chat. */
export function NewChatComposer({
  agent,
  modelLabel,
  sending,
  onSend,
  onCancel,
}: {
  agent: AgentSummaryDto;
  /** Resolved model / preset slug chip; null while the detail loads. */
  modelLabel: string | null;
  sending: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <AgentMonogram name={agent.name} size="sm" />
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {agent.name}
          </h1>
          {modelLabel !== null ? (
            <Chip icon={Cpu} mono title="Resolved model">
              {modelLabel}
            </Chip>
          ) : null}
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
          title={`New chat with ${agent.name}`}
          description="Send the first message — replies stream here live."
        />
      </div>
      <div className="mx-auto w-full max-w-3xl">
        <Composer
          autoFocus
          onSend={onSend}
          sending={sending}
          placeholder={`Message ${agent.name}…`}
        />
      </div>
    </div>
  );
}
