/**
 * Fixture-mode chat shell (VITE_FIXTURE_MODE=1): renders the full session
 * list + thread from a canned event log with NO backend — every working
 * block / reply / approval / error state is visible for design + E2E review,
 * plus the agent picker → new-chat composer flow. It reuses the exact
 * production reducer and components; only the data source differs.
 */
import { useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";

import type { AgentSummaryDto } from "@invisible-string/shared";

import { FIXTURE_AGENTS } from "../../lib/agents/fixtures";
import { reduceRunView } from "../../lib/chat/run-view";
import {
  FIXTURE_SESSIONS,
  type FixtureSession,
} from "../../lib/chat/fixtures";
import { titleFromMessage } from "../../lib/chat/time";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { AgentPicker, agentModelLabel } from "./AgentPicker";
import { NewChatComposer } from "./ChatShell";
import { SessionList, type SessionListItem } from "./SessionList";
import { ThreadView } from "./ThreadView";
import type { ThreadHeaderProps } from "./ThreadHeader";

const FIXTURE_AGENT_SUMMARIES: AgentSummaryDto[] = FIXTURE_AGENTS.map(
  (entry) => entry.summary,
);

/** Model chip labels from the fixture drafts (no queries in fixture mode). */
const FIXTURE_MODEL_LABELS: ReadonlyMap<string, string> = new Map(
  FIXTURE_AGENTS.flatMap((entry) => {
    const label = agentModelLabel(entry.definition);
    return label === null ? [] : [[entry.agent.id, label] as const];
  }),
);

export function FixtureChatShell() {
  const [activeId, setActiveId] = useState<string>(
    FIXTURE_SESSIONS[0]?.summary.id ?? "",
  );
  // Fixed "now" so recency grouping + relative times are deterministic.
  const now = useMemo(() => new Date(), []);
  // Locally answered approvals (fixture interactivity).
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Agent picked for a new chat — shows the real first-message composer. */
  const [draftAgent, setDraftAgent] = useState<AgentSummaryDto | null>(null);

  const sessions: SessionListItem[] = FIXTURE_SESSIONS.map((session) => ({
    ...session.summary,
    title: session.summary.agentName,
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
          activeSessionId={draftAgent !== null ? null : activeId}
          onSelect={(id) => {
            setDraftAgent(null);
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
            sending={false}
            onSend={() => undefined}
            onCancel={() => setDraftAgent(null)}
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
  const runViews = session.runs.map((fixtureRun) => {
    const view = reduceRunView(fixtureRun.run, {
      frames: fixtureRun.frames,
      maxSeq: fixtureRun.frames.length - 1,
    });
    // Drop locally-answered approvals to show the resolved state.
    return {
      ...view,
      pendingInputs: view.pendingInputs.filter(
        (input) => !answered.has(input.requestId),
      ),
    };
  });

  const lastRun = runViews[runViews.length - 1];
  const modelId =
    [...runViews].reverse().find((run) => run.modelId !== null)?.modelId ?? null;
  const { summary } = session;

  const header: ThreadHeaderProps = {
    title: titleFromMessage(session.runs[0]?.run.triggerEvent.message ?? ""),
    agentName: summary.agentName,
    agentId: summary.agentId,
    versionLabel: session.versionLabel,
    modelId,
    workflowName: summary.workflowName,
    sessionStatus: summary.status,
    lastRunStatus: lastRun?.status ?? null,
  };

  return (
    <ThreadView
      header={header}
      runs={runViews}
      isChatOrigin={summary.origin === "chat"}
      onRespond={(_runId, response) => onAnswer(response.requestId)}
      onSend={() => undefined}
      composerDisabledReason={
        lastRun?.status === "running"
          ? "Working… (fixture mode)"
          : lastRun?.status === "waiting"
            ? "Waiting for your approval above."
            : null
      }
    />
  );
}
