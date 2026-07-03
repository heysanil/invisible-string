/**
 * Canned event log for `/chat` fixture mode (VITE_FIXTURE_MODE=1). Renders
 * the full thread from a static event stream so designers and E2E can see
 * every working-block / reply / approval / error state without a backend.
 *
 * Each run's frames use the SAME frozen EveStreamEvent shapes the live
 * stream delivers, so the reducer path is identical to production.
 */
import type {
  AgentSessionSummaryDto,
  EveStreamEvent,
  RunDto,
  RunEventFrame,
  RunStatus,
  TriggerEvent,
} from "@invisible-string/shared";

const WS = "org_fixture";
const NOW = Date.now();

function iso(offsetSeconds: number): string {
  return new Date(NOW + offsetSeconds * 1000).toISOString();
}

function trigger(message: string): TriggerEvent {
  return {
    workflowId: "wf_fixture",
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
  run: Pick<RunDto, "id" | "status" | "triggerEvent" | "error">;
  frames: RunEventFrame[];
}

export interface FixtureSession {
  summary: AgentSessionSummaryDto;
  isChatOrigin: boolean;
  workflowId: string;
  workflowName: string;
  versionLabel: string | null;
  runs: FixtureRun[];
}

function sessionSummary(
  id: string,
  workflowName: string,
  status: AgentSessionSummaryDto["status"],
  lastRunStatus: RunStatus | null,
  ageSeconds: number,
): AgentSessionSummaryDto {
  return {
    id,
    workflowId: "wf_fixture",
    workflowVersionId: "wfv_fixture",
    origin: "chat",
    status,
    eveSessionId: "eve_fixture",
    createdAt: iso(-ageSeconds - 600),
    updatedAt: iso(-ageSeconds),
    workflowName,
    lastRunStatus,
    lastActivityAt: iso(-ageSeconds),
  };
}

// ── Session 1: a completed run with a working block + markdown reply ────────

const completedRun: FixtureRun = {
  run: {
    id: "run_done",
    status: "succeeded",
    triggerEvent: trigger("Summarize the latest issues in the tracker."),
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

// ── Session 2: a run parked on an approval (HITL) ───────────────────────────

const parkedRun: FixtureRun = {
  run: {
    id: "run_parked",
    status: "waiting",
    triggerEvent: trigger("Send the weekly report email to the team."),
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

// ── Session 3: a live streaming run ─────────────────────────────────────────

const streamingRun: FixtureRun = {
  run: {
    id: "run_live",
    status: "running",
    triggerEvent: trigger("Draft a launch announcement."),
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

// ── Session 4: a failed run ─────────────────────────────────────────────────

const failedRun: FixtureRun = {
  run: {
    id: "run_failed",
    status: "failed",
    triggerEvent: trigger("Deploy to production."),
    error: "Model provider returned 401 — credentials rejected.",
  },
  frames: framesFor("run_failed", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.19.0", modelId: "deepseek/deepseek-v4-flash" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Deploy to production.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "turn.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, turnId: "t0" }, meta: { at: iso(1) } },
  ]),
};

export const FIXTURE_SESSIONS: FixtureSession[] = [
  {
    summary: sessionSummary("s_live", "Marketing copilot", "active", "running", 30),
    isChatOrigin: true,
    workflowId: "wf_fixture",
    workflowName: "Marketing copilot",
    versionLabel: "v_a1b2c3",
    runs: [streamingRun],
  },
  {
    summary: sessionSummary("s_parked", "Ops assistant", "waiting", "waiting", 240),
    isChatOrigin: true,
    workflowId: "wf_fixture",
    workflowName: "Ops assistant",
    versionLabel: "v_d4e5f6",
    runs: [parkedRun],
  },
  {
    summary: sessionSummary("s_done", "Issue triage", "active", "succeeded", 7200),
    isChatOrigin: true,
    workflowId: "wf_fixture",
    workflowName: "Issue triage",
    versionLabel: "v_9a8b7c",
    runs: [completedRun],
  },
  {
    summary: sessionSummary("s_failed", "Release bot", "error", "failed", 172800),
    isChatOrigin: true,
    workflowId: "wf_fixture",
    workflowName: "Release bot",
    versionLabel: "v_0f1e2d",
    runs: [failedRun],
  },
];

export const FIXTURE_MODE: boolean =
  import.meta.env.VITE_FIXTURE_MODE === "1" ||
  import.meta.env.VITE_FIXTURE_MODE === "true";
