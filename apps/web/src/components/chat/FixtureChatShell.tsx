/**
 * Fixture-mode chat shell (VITE_FIXTURE_MODE=1): renders the full session
 * list + thread from a canned event log with NO backend — every working
 * block / reply / approval / error state is visible for design + E2E review,
 * plus the agent picker → new-chat composer flow. It reuses the exact
 * production reducer and components; only the data source differs.
 *
 * Two 2026-08-11 surfaces are previewed here because they are otherwise
 * invisible without a control plane: TITLED session rows alongside untitled
 * ones falling back to their first message (D9), and the OPTIMISTIC send
 * (D8) — submitting the first message lands in a thread immediately instead
 * of parking on the composer. The create round-trip is simulated with a
 * timer, in the same spirit as the stop and context-control simulations
 * below: the fixture exists to show shipped behaviour, and a preview that
 * skipped the transition would show none of it.
 */
import { useEffect, useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";

import type { AgentSummaryDto } from "@invisible-string/shared";

import { indexToolDirectory } from "@invisible-string/shared";

import { FIXTURE_AGENTS } from "../../lib/agents/fixtures";
import { reduceRunView } from "../../lib/chat/run-view";
import {
  FIXTURE_SESSIONS,
  FIXTURE_TOOL_DIRECTORY,
  type FixtureSession,
} from "../../lib/chat/fixtures";
import { sessionRowTitle } from "../../lib/chat/time";
import { useMessageQueue } from "../../lib/chat/use-message-queue";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { AgentPicker, agentModelLabel } from "./AgentPicker";
import { NewChatComposer, StartingThread } from "./ChatShell";
import type { ContextMarkerKind } from "./ContextDivider";
import { SessionList, type SessionListItem } from "./SessionList";
import { ThreadView } from "./ThreadView";
import type { ThreadHeaderProps } from "./ThreadHeader";

const FIXTURE_AGENT_SUMMARIES: AgentSummaryDto[] = FIXTURE_AGENTS.map(
  (entry) => entry.summary,
);

/**
 * Header stand-ins for the two workspace queries fixture mode cannot make: the
 * preset the resolved model maps to, and the catalog's context window for it
 * (1M — the same figure the fixture model capabilities carry).
 */
const FIXTURE_MODEL_PRESET_LABEL = "Balanced";
const FIXTURE_CONTEXT_WINDOW_TOKENS = 1_048_576;

/** The canned tool directory, indexed once for every fixture thread. */
const FIXTURE_TOOL_INDEX = indexToolDirectory(FIXTURE_TOOL_DIRECTORY);

/**
 * Simulated create-session latency for the optimistic-send preview. Long
 * enough that the starting pane is genuinely on screen (that IS the state
 * under review), short enough that nobody waits on it.
 */
const FIXTURE_START_LATENCY_MS = 700;

/** Model chip labels from the fixture drafts (no queries in fixture mode). */
const FIXTURE_MODEL_LABELS: ReadonlyMap<string, string> = new Map(
  FIXTURE_AGENTS.flatMap((entry) => {
    const label = agentModelLabel(entry.definition);
    return label === null ? [] : [[entry.agent.id, label] as const];
  }),
);

export function FixtureChatShell({
  initialAgentId,
}: {
  /** ?agent= deep link (the fixture agent editor's "Chat with agent"). */
  initialAgentId?: string;
}) {
  const [activeId, setActiveId] = useState<string>(
    FIXTURE_SESSIONS[0]?.summary.id ?? "",
  );
  // Fixed "now" so recency grouping + relative times are deterministic.
  const now = useMemo(() => new Date(), []);
  // Locally answered approvals (fixture interactivity).
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Agent picked for a new chat — shows the real first-message composer.
   *  Seeded from the deep link so ?agent= opens the composer, same as prod. */
  const [draftAgent, setDraftAgent] = useState<AgentSummaryDto | null>(
    () =>
      FIXTURE_AGENT_SUMMARIES.find((agent) => agent.id === initialAgentId) ??
      null,
  );
  /** The optimistic thread (D8): a sent message with no session behind it. */
  const [pendingChat, setPendingChat] = useState<{
    agent: AgentSummaryDto;
    message: string;
  } | null>(null);

  // The simulated round-trip: land on one of the agent's canned sessions (or,
  // for an agent with none, just fall back to whatever was open). Cancelled on
  // unmount and whenever the user walks away, so a switch made mid-flight can
  // never yank them back — the same rule the live shell enforces with its
  // pending token.
  useEffect(() => {
    if (pendingChat === null) return;
    const { id: agentId } = pendingChat.agent;
    const timer = setTimeout(() => {
      const landing = FIXTURE_SESSIONS.find(
        (session) => session.summary.agentId === agentId,
      );
      if (landing !== undefined) setActiveId(landing.summary.id);
      setPendingChat(null);
    }, FIXTURE_START_LATENCY_MS);
    return () => clearTimeout(timer);
  }, [pendingChat]);

  const sessions: SessionListItem[] = FIXTURE_SESSIONS.map((session) => ({
    ...session.summary,
    // Untitled fixtures fall back to their first message, exactly as the live
    // sidebar does for a session the titler has not answered for.
    displayTitle: sessionRowTitle(
      session.summary,
      session.runs[0]?.run.triggerEvent.message,
    ),
  }));

  const active: FixtureSession | undefined = FIXTURE_SESSIONS.find(
    (session) => session.summary.id === activeId,
  );

  return (
    <div className="flex h-full gap-5">
      <Panel
        aria-label="Chat sessions"
        className="panel-enter hidden w-80 shrink-0 flex-col overflow-hidden md:flex"
      >
        <SessionList
          sessions={sessions}
          isLoading={false}
          activeSessionId={
            draftAgent !== null || pendingChat !== null ? null : activeId
          }
          onSelect={(id) => {
            setDraftAgent(null);
            setPendingChat(null);
            setActiveId(id);
          }}
          onNewChat={() => setPickerOpen(true)}
          now={now}
        />
      </Panel>

      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        {draftAgent !== null ? (
          <NewChatComposer
            agent={draftAgent}
            modelLabel={FIXTURE_MODEL_LABELS.get(draftAgent.id) ?? null}
            onSend={(message) => {
              setPendingChat({ agent: draftAgent, message });
              setDraftAgent(null);
            }}
            onCancel={() => setDraftAgent(null)}
          />
        ) : pendingChat !== null ? (
          <StartingThread
            agent={pendingChat.agent}
            modelLabel={FIXTURE_MODEL_LABELS.get(pendingChat.agent.id) ?? null}
            message={pendingChat.message}
          />
        ) : active === undefined ? (
          <EmptyState
            icon={MessageSquare}
            title="Pick up a conversation"
            description="Select a session on the left."
          />
        ) : (
          <FixtureThread
            key={active.summary.id}
            session={active}
            answered={answered}
            onAnswer={(requestId) =>
              setAnswered((prev) => new Set(prev).add(requestId))
            }
          />
        )}
      </Panel>

      {pickerOpen ? (
        <AgentPicker
          agents={FIXTURE_AGENT_SUMMARIES}
          modelLabels={FIXTURE_MODEL_LABELS}
          onPick={(agent) => {
            setDraftAgent(agent);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function FixtureThread({
  session,
  answered,
  onAnswer,
}: {
  session: FixtureSession;
  answered: Set<string>;
  onAnswer: (requestId: string) => void;
}) {
  // Locally stopped runs + locally applied context controls. Same pattern as
  // `answered`: fixture mode has no backend, so the transitions the Stop
  // button and the session-actions menu produce are simulated in component
  // state — otherwise neither would be reachable for design or E2E review.
  const [stopped, setStopped] = useState<Set<string>>(new Set());
  const [contextMarker, setContextMarker] = useState<ContextMarkerKind | null>(null);

  const runViews = session.runs.map((fixtureRun) => {
    const view = reduceRunView(fixtureRun.run, {
      frames: fixtureRun.frames,
      maxSeq: fixtureRun.frames.length - 1,
    });
    const isStopped = stopped.has(view.runId);
    return {
      ...view,
      // A stop lands as `canceled`, NEVER `failed` — the fixture must not
      // model it as an error or the preview would teach the wrong thing.
      status: isStopped ? ("canceled" as const) : view.status,
      canceled: view.canceled || isStopped,
      // Drop locally-answered approvals to show the resolved state; a stopped
      // turn retires every unanswered request outright.
      pendingInputs: isStopped
        ? []
        : view.pendingInputs.filter((input) => !answered.has(input.requestId)),
    };
  });

  const lastRun = runViews[runViews.length - 1];
  const modelId =
    [...runViews].reverse().find((run) => run.modelId !== null)?.modelId ?? null;
  // The context meter's numerator, exactly as ThreadContainer derives it: the
  // newest run that reported `usage.inputTokens` on a `step.completed`.
  const contextTokens =
    [...runViews].reverse().find((run) => run.inputTokens !== null)
      ?.inputTokens ?? null;
  const { summary } = session;

  // The session's one run slot, as the control plane counts it — `waiting`
  // included, because a parked run still owns the turn.
  const slotHeld =
    lastRun !== undefined &&
    !lastRun.canceled &&
    (lastRun.status === "queued" ||
      lastRun.status === "running" ||
      lastRun.status === "waiting");

  // The REAL queue hook, not a lookalike: fixture mode exists to preview the
  // shipped behavior, so a hand-rolled array here could drift from production
  // and quietly teach the wrong thing. `send` resolves without a backend, so
  // stopping the run frees the slot and the queue flushes and empties exactly
  // as it does against the control plane.
  const queue = useMessageQueue({
    canFlush: !slotHeld,
    send: async () => {},
    onGiveUp: () => {},
    onRetired: () => {},
  });
  const queueing = slotHeld || queue.queued.length > 0;

  const header: ThreadHeaderProps = {
    // Same resolution as the sidebar row, so the header and the list never
    // disagree about what a conversation is called (D9).
    title: sessionRowTitle(summary, session.runs[0]?.run.triggerEvent.message),
    agentName: summary.agentName,
    agentId: summary.agentId,
    // The header shows a friendly model label + a context meter now, not the
    // build identity it used to (2026-08-11 spec D6). Fixture mode has no
    // preset/capability queries, so it fills both from canned values — a
    // preview that dropped them could not review the surface at all.
    modelLabel: modelId !== null ? FIXTURE_MODEL_PRESET_LABEL : null,
    modelId,
    contextUsage:
      contextTokens !== null
        ? {
            usedTokens: contextTokens,
            windowTokens: FIXTURE_CONTEXT_WINDOW_TOKENS,
          }
        : null,
    workflowName: summary.workflowName,
    sessionStatus: summary.status,
    lastRunStatus: lastRun?.status ?? null,
    onContextAction: (action) => {
      if (action === "reset") return; // ConfirmDialog lives in ThreadContainer
      setContextMarker(action === "clear" ? "cleared" : "compacted");
    },
    contextActionPending: null,
    contextActionsBlockedReason:
      lastRun?.status === "queued" || lastRun?.status === "running"
        ? "Wait for the current run to finish, or stop it first."
        : null,
  };

  return (
    <ThreadView
      header={header}
      runs={runViews}
      isChatOrigin={summary.origin === "chat"}
      onRespond={(_runId, response) => onAnswer(response.requestId)}
      onStop={
        slotHeld && lastRun !== undefined
          ? () => setStopped((prev) => new Set(prev).add(lastRun.runId))
          : undefined
      }
      contextMarker={contextMarker}
      toolDirectory={FIXTURE_TOOL_INDEX}
      // Enter queues while the slot is held — the same routing ThreadContainer
      // does. With no backend there is nothing to send when the slot is free,
      // so that branch stays a no-op.
      onSend={(message) => {
        if (queueing) queue.enqueue(message);
      }}
      queued={queue.queued}
      onRemoveQueued={queue.remove}
      queueing={queueing}
      // NEVER a disabledReason for a live run. This used to read "Working…
      // (fixture mode)", which froze the box and previewed the exact behavior
      // this feature removed — a preview that lies is worse than no preview.
      // Only a retired session disables, and fixture sessions never retire.
      composerDisabledReason={null}
      composerHint={
        queue.notice ??
        (lastRun?.status === "waiting"
          ? "Waiting for your response above — anything you send now is queued."
          : null)
      }
    />
  );
}
