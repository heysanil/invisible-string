/**
 * Canned event log for `/chat` fixture mode (VITE_FIXTURE_MODE=1). Renders
 * the full thread from a static event stream so designers and E2E can see
 * every working-block / reply / approval / error state without a backend.
 *
 * Each run's frames use the SAME frozen EveStreamEvent shapes the live
 * stream delivers, so the reducer path is identical to production. Sessions
 * bind to the fixture agents (lib/agents/fixtures.ts); one session is
 * webhook-origin with workflow provenance so the origin + workflow chips
 * render.
 */
import type {
  AgentSessionSummaryDto,
  EveStreamEvent,
  RunDto,
  RunEventFrame,
  RunStatus,
  TriggerEvent,
} from "@invisible-string/shared";

import {
  FIXTURE_DATA_ANALYST,
  FIXTURE_EXEC_ASSISTANT,
  FIXTURE_SUPPORT_TRIAGER,
  type FixtureAgent,
} from "../agents/fixtures";

const WS = "org_fixture";
const NOW = Date.now();

/** The one webhook-origin session's workflow provenance. */
export const FIXTURE_WORKFLOW_ID = "cccccccc-0001-4000-8000-000000000001";
export const FIXTURE_WORKFLOW_NAME = "Nightly metrics digest";

function iso(offsetSeconds: number): string {
  return new Date(NOW + offsetSeconds * 1000).toISOString();
}

/** Direct-chat trigger envelope (no workflow provenance). */
function chatTrigger(agent: FixtureAgent, message: string): TriggerEvent {
  return {
    agentId: agent.agent.id,
    workflowId: null,
    triggerType: "manual",
    message,
    data: {},
    principal: { workspaceId: WS, source: "chat" },
  };
}

let seqCounter = 0;
function framesFor(runId: string, events: EveStreamEvent[]): RunEventFrame[] {
  return events.map((event) => ({
    runId,
    seq: seqCounter++,
    event,
    at: (event.meta?.at ?? iso(0)),
  }));
}

export interface FixtureRun {
  run: Pick<RunDto, "id" | "status" | "triggerEvent" | "taskMessage" | "error">;
  frames: RunEventFrame[];
}

export interface FixtureSession {
  /** Carries agent identity + origin + workflow provenance (or null). */
  summary: AgentSessionSummaryDto;
  /** Pinned agent version chip label. */
  versionLabel: string | null;
  runs: FixtureRun[];
}

function sessionSummary(
  id: string,
  agent: FixtureAgent,
  status: AgentSessionSummaryDto["status"],
  lastRunStatus: RunStatus | null,
  ageSeconds: number,
  provenance?: {
    origin: AgentSessionSummaryDto["origin"];
    workflowId: string;
    workflowName: string;
  },
): AgentSessionSummaryDto {
  return {
    id,
    agentId: agent.agent.id,
    agentVersionId:
      agent.summary.publishedVersionId ?? agent.agent.id,
    workflowId: provenance?.workflowId ?? null,
    origin: provenance?.origin ?? "chat",
    status,
    eveSessionId: "eve_fixture",
    createdAt: iso(-ageSeconds - 600),
    updatedAt: iso(-ageSeconds),
    agentName: agent.agent.name,
    workflowName: provenance?.workflowName ?? null,
    lastRunStatus,
    lastActivityAt: iso(-ageSeconds),
  };
}

// ── Session 1: a live streaming run (Executive assistant) ───────────────────

const streamingRun: FixtureRun = {
  run: {
    id: "run_live",
    status: "running",
    triggerEvent: chatTrigger(FIXTURE_EXEC_ASSISTANT, "Draft a launch announcement."),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_live", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.19.0", modelId: "deepseek/deepseek-v4-pro" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Draft a launch announcement.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "reasoning.appended", data: { reasoningDelta: "Considering the tone", reasoningSoFar: "Considering the tone and audience for the announcement…", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "message.appended", data: { messageDelta: "We're excited", messageSoFar: "We're excited to announce", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(2) } },
  ]),
};

// ── Session 2: a run parked on an approval (HITL, Executive assistant) ──────

const parkedRun: FixtureRun = {
  run: {
    id: "run_parked",
    status: "waiting",
    triggerEvent: chatTrigger(
      FIXTURE_EXEC_ASSISTANT,
      "Send the weekly report email to the team.",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_parked", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.19.0", modelId: "z-ai/glm-5.2" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Send the weekly report email to the team.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "actions.requested", data: { actions: [{ callId: "c9", kind: "tool-call", toolName: "gmail_send", input: { to: "team@acme.com", subject: "Weekly report" } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "input.requested", data: { requests: [{ requestId: "req1", prompt: "Approve tool call: gmail_send", action: { callId: "c9", kind: "tool-call", toolName: "gmail_send", input: { to: "team@acme.com", subject: "Weekly report" } }, options: [{ id: "approve", label: "Approve", style: "primary" }, { id: "deny", label: "Deny", style: "danger" }], display: "confirmation", allowFreeform: false }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(2) } },
    { type: "turn.completed", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(2) } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(2) } },
  ]),
};

// ── Session 3: a completed run with a working block (Support triager) ───────

const completedRun: FixtureRun = {
  run: {
    id: "run_done",
    status: "succeeded",
    triggerEvent: chatTrigger(
      FIXTURE_SUPPORT_TRIAGER,
      "Summarize the latest issues in the tracker.",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_done", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.19.0", modelId: "deepseek/deepseek-v4-pro" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Summarize the latest issues in the tracker.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "linear_list_issues", input: { limit: 5 } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "linear_list_issues", output: "5 issues: 2 bugs, 3 features" }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(3) } },
    { type: "message.appended", data: { messageDelta: "Here", messageSoFar: "Here", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(4) } },
    { type: "message.completed", data: { finishReason: "stop", message: "Here are the **latest issues**:\n\n- Fix login redirect loop (`bug`)\n- Slow dashboard load (`bug`)\n- Add CSV export (`feature`)\n\nWant me to open any of these?", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(5) } },
    { type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(5) } },
    { type: "turn.completed", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(6) } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(6) } },
  ]),
};

// ── Session 4: a failed WEBHOOK run (Data analyst via a workflow) ────────────

const webhookTaskMessage = [
  "<workflow-task>",
  "Investigate last night's metrics export and report what changed and why.",
  "</workflow-task>",
  "",
  "<trigger-context>",
  "trigger.report_date: 2026-07-09",
  "</trigger-context>",
].join("\n");

const failedRun: FixtureRun = {
  run: {
    id: "run_failed",
    status: "failed",
    triggerEvent: {
      agentId: FIXTURE_DATA_ANALYST.agent.id,
      workflowId: FIXTURE_WORKFLOW_ID,
      triggerType: "webhook",
      message: "Investigate last night's metrics export.",
      data: { report_date: "2026-07-09" },
      principal: { workspaceId: WS, source: "webhook" },
    },
    taskMessage: webhookTaskMessage,
    error: "Model provider returned 401 — credentials rejected.",
  },
  frames: framesFor("run_failed", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.19.0", modelId: "deepseek/deepseek-v4-flash" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: webhookTaskMessage, sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "turn.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, turnId: "t0" }, meta: { at: iso(1) } },
  ]),
};

export const FIXTURE_SESSIONS: FixtureSession[] = [
  {
    summary: sessionSummary("s_live", FIXTURE_EXEC_ASSISTANT, "active", "running", 30),
    versionLabel: "v_a1b2c3",
    runs: [streamingRun],
  },
  {
    summary: sessionSummary("s_parked", FIXTURE_EXEC_ASSISTANT, "waiting", "waiting", 240),
    versionLabel: "v_a1b2c3",
    runs: [parkedRun],
  },
  {
    summary: sessionSummary("s_done", FIXTURE_SUPPORT_TRIAGER, "active", "succeeded", 7200),
    versionLabel: "v_9a8b7c",
    runs: [completedRun],
  },
  {
    summary: sessionSummary("s_failed", FIXTURE_DATA_ANALYST, "error", "failed", 172800, {
      origin: "webhook",
      workflowId: FIXTURE_WORKFLOW_ID,
      workflowName: FIXTURE_WORKFLOW_NAME,
    }),
    versionLabel: "v_0f1e2d",
    runs: [failedRun],
  },
];

export const FIXTURE_MODE: boolean =
  import.meta.env.VITE_FIXTURE_MODE === "1" ||
  import.meta.env.VITE_FIXTURE_MODE === "true";
