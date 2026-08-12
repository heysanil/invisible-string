/**
 * Chat section shell: floating glass session-list panel + floating glass
 * thread pane. Owns session selection, the "New chat" agent picker, the
 * create-session round-trip, and how a session is TITLED in the sidebar. Live
 * thread rendering lives in {@link ThreadContainer}; this component is the
 * two-panel frame + list.
 *
 * SENDING ENTERS THE THREAD IMMEDIATELY (2026-08-11 spec, D8). Creating a
 * session is a real round-trip — rows are written and eve is handed the first
 * message — and waiting it out on the composer made Send look like it had
 * done nothing. The pane switches to an optimistic thread the instant the
 * user submits, and ROLLS BACK TO THE COMPOSER WITH THE TEXT if creation
 * fails: losing a typed message to a network error is the one regression this
 * must not introduce, so the message is held in this component until a
 * session id exists to hold it instead.
 *
 * SIDEBAR TITLES (D9). `agent_sessions.title` is generated server-side after
 * the first user message; until it lands (and forever, for sessions that
 * predate it or whose titling failed silently) the row falls back to a
 * truncation of that first message. That fallback comes off the LIST DTO's
 * `firstMessagePreview`, so it holds on a cold load with nothing opened —
 * this component keeps no message store of its own, because a second source
 * would only be able to name the one thread the tab happened to visit.
 * Resolution order lives in `sessionRowTitle`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Cpu, MessageSquare } from "lucide-react";

import type { AgentSummaryDto } from "@invisible-string/shared";

import { sessionRowTitle } from "../../lib/chat/time";
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
import { Spinner } from "../ui/Spinner";
import { AgentPicker, agentModelLabel } from "./AgentPicker";
import { Chip } from "./Chip";
import { Composer } from "./Composer";
import { DiscardQueueDialog } from "./DiscardQueueDialog";
import { Markdown } from "./Markdown";
import { SessionList, type SessionListItem } from "./SessionList";
import { ThreadContainer } from "./ThreadContainer";

/** Where a session switch wants to land: another thread, or the new-chat picker. */
type SwitchTarget = { kind: "session"; sessionId: string } | { kind: "new" };

/** A first message on screen with no session id behind it yet (D8). */
interface PendingChat {
  agent: AgentSummaryDto;
  message: string;
}

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
  /** The optimistic thread: shown from submit until the session id lands. */
  const [pendingChat, setPendingChat] = useState<PendingChat | null>(null);
  /**
   * The message handed back to the composer after a failed create. Set only
   * on the rollback path, so a fresh new-chat composer never opens pre-filled.
   */
  const [rolledBackMessage, setRolledBackMessage] = useState<string | null>(null);
  /**
   * Queue depth reported by the live thread. The queue is per-thread state
   * inside a KEYED ThreadContainer, so any switch remounts it and drops the
   * messages — this shell has to ask before that happens.
   */
  const [queuedCount, setQueuedCount] = useState(0);
  /** A switch the user asked for, held until they resolve the discard prompt. */
  const [pendingSwitch, setPendingSwitch] = useState<SwitchTarget | null>(null);

  /**
   * Monotonic id for the in-flight create. The user can walk away from a
   * pending chat while its POST is still out (pick another session, hit New
   * chat); its callbacks must then NOT yank the pane back to a thread the
   * user has already left, nor re-open a composer over the one they moved to.
   * Every switch and every send bumps it, so a stale callback compares
   * unequal and only does the work that is safe out of context.
   */
  const pendingTokenRef = useRef(0);

  function abandonPendingChat() {
    pendingTokenRef.current += 1;
    setPendingChat(null);
  }

  function applySwitch(target: SwitchTarget) {
    setQueuedCount(0);
    // Whatever the target, the user is no longer watching the optimistic
    // thread — release it so a create landing later cannot pull them back.
    abandonPendingChat();
    if (target.kind === "new") {
      setPickerOpen(true);
      return;
    }
    setDraftAgent(null);
    setRolledBackMessage(null);
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
  const detailsEnabled = pickerOpen || draftAgent !== null || pendingChat !== null;
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

  // Rows are named entirely from the list row itself — generated title, else
  // the DTO's opener preview, else the agent. Nothing here depends on which
  // threads this tab has opened, which is what makes an untitled row legible
  // on a cold load and on a second device.
  const sessions: SessionListItem[] = useMemo(
    () =>
      (sessionsQuery.data ?? []).map((session) => ({
        ...session,
        displayTitle: sessionRowTitle(session),
      })),
    [sessionsQuery.data],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  /**
   * Submit from the new-chat composer. The pane switches FIRST and the POST
   * follows; nothing here awaits the round-trip.
   *
   * There is no unsaved-queue guard to honor on this path: the composer only
   * renders when `draftAgent` is set, which unmounts the keyed
   * ThreadContainer and its queue with it — `requestSwitch` already asked
   * before that happened.
   */
  function startSession(agent: AgentSummaryDto, message: string) {
    const token = ++pendingTokenRef.current;
    setPendingChat({ agent, message });
    setDraftAgent(null);
    setRolledBackMessage(null);
    setActiveSessionId(null);
    createSession.mutate(
      { agentId: agent.id, message },
      {
        onSuccess: (data) => {
          // No title bookkeeping to do here: `useCreateSession` refetches the
          // session list before this fires, and the new row arrives carrying
          // its own `firstMessagePreview`.
          if (pendingTokenRef.current !== token) return;
          setPendingChat(null);
          setActiveSessionId(data.session.id);
        },
        onError: (error) => {
          // Always tell them, even if they moved on — the chat they started
          // does not exist and nothing else would say so. Out of context the
          // toast has to name the agent, because the pane they are looking at
          // is some other conversation entirely; the typed text is genuinely
          // gone in that case, which is the price of not yanking a user back
          // to a composer they deliberately left.
          const movedOn = pendingTokenRef.current !== token;
          toast.toast({
            variant: "error",
            message: movedOn
              ? `Couldn’t start the chat with ${agent.name}. ${errorMessage(error)}`
              : errorMessage(error),
          });
          if (movedOn) return;
          setPendingChat(null);
          // Back to the composer WITH the text. This is the whole reason the
          // message lives in this component rather than only in the editor
          // that was just unmounted.
          setRolledBackMessage(message);
          setDraftAgent(agent);
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
          activeSessionId={
            draftAgent !== null || pendingChat !== null ? null : activeSessionId
          }
          onSelect={(id) => requestSwitch({ kind: "session", sessionId: id })}
          onNewChat={() => requestSwitch({ kind: "new" })}
        />
      </Panel>

      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        {draftAgent !== null ? (
          <NewChatComposer
            agent={draftAgent}
            modelLabel={modelLabels.get(draftAgent.id) ?? null}
            initialMessage={rolledBackMessage}
            onSend={(message) => startSession(draftAgent, message)}
            onCancel={() => {
              setRolledBackMessage(null);
              setDraftAgent(null);
            }}
          />
        ) : pendingChat !== null ? (
          <StartingThread
            agent={pendingChat.agent}
            modelLabel={modelLabels.get(pendingChat.agent.id) ?? null}
            message={pendingChat.message}
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
            setRolledBackMessage(null);
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

/**
 * Thread-pane header for the two states that have an agent but no session:
 * the new-chat composer and the optimistic thread. Same anatomy as
 * {@link ThreadHeader} minus everything a session id would be needed for
 * (version, context menu, edit link).
 */
function ChatPaneHeader({
  agent,
  modelLabel,
  status,
  onCancel,
}: {
  agent: AgentSummaryDto;
  modelLabel: string | null;
  /** Liveness line shown beside the name (the optimistic thread's "Starting"). */
  status?: string;
  onCancel?: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentMonogram name={agent.name} size="sm" />
        <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
          {agent.name}
        </h1>
        {/* Plain text, not a StatusDot: the dot's accessible name is one of
            five session liveness states, and "starting" is not among them —
            a session that does not exist yet has no liveness to report. */}
        {status !== undefined ? (
          <span className="shrink-0 text-[11px] text-ink-4">{status}</span>
        ) : null}
        {modelLabel !== null ? (
          <Chip icon={Cpu} mono title="Resolved model">
            {modelLabel}
          </Chip>
        ) : null}
      </div>
      {onCancel !== undefined ? (
        <button
          type="button"
          onClick={onCancel}
          className="lift h-8 shrink-0 rounded-capsule px-3 text-[12.5px] font-medium text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          Cancel
        </button>
      ) : null}
    </header>
  );
}

/** First-message composer shown after an agent is chosen for a new chat. */
export function NewChatComposer({
  agent,
  modelLabel,
  initialMessage,
  onSend,
  onCancel,
}: {
  agent: AgentSummaryDto;
  /** Resolved model / preset slug chip; null while the detail loads. */
  modelLabel: string | null;
  /**
   * Text recovered from a failed create (D8). Non-null ONLY on the rollback
   * path — the composer is remounted by then, so it seeds the editor on
   * creation rather than fighting the reconcile effect.
   */
  initialMessage?: string | null;
  onSend: (message: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <ChatPaneHeader agent={agent} modelLabel={modelLabel} onCancel={onCancel} />
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
          initialValue={initialMessage ?? undefined}
          placeholder={`Message ${agent.name}…`}
        />
      </div>
    </div>
  );
}

/**
 * The optimistic thread (D8): the user's message is already on screen, the
 * agent is being started, and neither a session id nor a run exists yet.
 *
 * Deliberately NOT a {@link ThreadView}: there is no run row and no frame
 * store to reduce, and synthesizing one would mean teaching the run reducer
 * about rows the server has never heard of. It borrows the anatomy instead —
 * the same ink bubble, the same max-width column — so the swap to the real
 * thread a moment later is a continuation rather than a cut.
 *
 * The composer is DISABLED here, which is the one place that is honest:
 * elsewhere a live box queues into an existing session, but there is no
 * session behind this pane yet, so anything typed would have nowhere to go
 * and would be eaten by the swap. It reappears live the instant the real
 * thread mounts.
 */
export function StartingThread({
  agent,
  modelLabel,
  message,
}: {
  agent: AgentSummaryDto;
  modelLabel: string | null;
  message: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <ChatPaneHeader agent={agent} modelLabel={modelLabel} status="Starting" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3.5 px-10 py-9">
          <div className="flex justify-end">
            {/* Same bubble as RunMessage's inbound message, down to the
                markdown treatment: the author's own formatting has to survive
                the hand-off, or the message would visibly change shape when
                the real run replaces this one. */}
            <div className="max-w-[80%] break-words rounded-[16px] rounded-br-md bg-ink px-3.5 py-2 text-white [overflow-wrap:anywhere]">
              <Markdown
                text={message}
                className="md-on-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              />
            </div>
          </div>
          <p
            aria-live="polite"
            className="flex items-center gap-2 text-[13px] text-ink-3"
          >
            <Spinner size={14} />
            Starting {agent.name}…
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl">
        <Composer
          onSend={() => undefined}
          disabledReason="Starting the conversation — you can reply as soon as it opens."
          placeholder={`Message ${agent.name}…`}
        />
      </div>
    </div>
  );
}
