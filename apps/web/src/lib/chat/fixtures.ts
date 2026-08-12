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
 *
 * Three 2026-08-11 surfaces are exercised here too, because a preview that
 * omits them cannot review them: qualified `<slug>__<tool>` tool calls against
 * {@link FIXTURE_TOOL_DIRECTORY} (D5), a COMPACTED session alongside the
 * cleared one (D4), and `step.completed` usage so the header's context meter
 * has a numerator (D6).
 */
import type {
  AgentSessionSummaryDto,
  AgentVersionToolDirectory,
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
  /**
   * The generated session title, or null to preview the FALLBACK (the
   * sidebar truncates the first message instead). Both states are real:
   * titling runs only for chat-origin sessions and fails silently, so a
   * fixture set where every row is titled would hide half the design —
   * which is why the default is the untitled one.
   */
  title: string | null = null,
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
    title,
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
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Draft a launch announcement.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "reasoning.appended", data: { reasoningDelta: "Considering the tone", reasoningSoFar: "Considering the tone and audience for the announcement…", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "reasoning.completed", data: { reasoning: "Considering the tone and audience for the announcement…", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(2) } },
    { type: "message.appended", data: { messageDelta: "Let me check", messageSoFar: "Let me check the product notes first.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(3) } },
    { type: "message.completed", data: { finishReason: "tool-calls", message: "Let me check the product notes first.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(3) } },
    { type: "actions.requested", data: { actions: [{ callId: "c_notes", kind: "tool-call", toolName: "search_notes", input: { q: "launch" } }], sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(4) } },
    // Deliberately UNQUALIFIED: one of eve's builtins, which has no connection
    // prefix and must still render as "Search notes" rather than blank.
    { type: "action.result", data: { result: { callId: "c_notes", kind: "tool-result", toolName: "search_notes", output: "3 notes" }, status: "completed", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(6) } },
    { type: "step.completed", data: { finishReason: "tool-calls", sequence: 0, stepIndex: 1, turnId: "t0", usage: { inputTokens: 96_500, outputTokens: 210 } }, meta: { at: iso(6) } },
    { type: "reasoning.appended", data: { reasoningDelta: "The notes", reasoningSoFar: "The notes emphasise reliability over novelty — I'll lead with that.", sequence: 0, stepIndex: 2, turnId: "t0" }, meta: { at: iso(7) } },
    { type: "message.appended", data: { messageDelta: "We're excited", messageSoFar: "We're excited to announce", sequence: 0, stepIndex: 2, turnId: "t0" }, meta: { at: iso(9) } },
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
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "moonshotai/kimi-k3" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Send the weekly report email to the team.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "actions.requested", data: { actions: [{ callId: "c9", kind: "tool-call", toolName: "gmail_send", input: { to: "team@acme.com", subject: "Weekly report" } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "input.requested", data: { requests: [{ requestId: "req1", kind: "tool-approval", prompt: "Approve tool call: gmail_send", action: { callId: "c9", kind: "tool-call", toolName: "gmail_send", input: { to: "team@acme.com", subject: "Weekly report" } }, options: [{ id: "approve", label: "Approve", style: "primary" }, { id: "deny", label: "Deny", style: "danger" }], display: "confirmation", allowFreeform: false }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(2) } },
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
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: "Summarize the latest issues in the tracker.", sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    // A QUALIFIED MCP tool call: the slug resolves through
    // FIXTURE_TOOL_DIRECTORY to "Linear · List issues" plus the connector's
    // own description, and the MCP envelope summarizes to its text part.
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "linear__list_issues", input: { limit: 5 } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "linear__list_issues", output: { content: [{ type: "text", text: "5 issues: 2 bugs, 3 features" }], isError: false } }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(3) } },
    { type: "message.appended", data: { messageDelta: "Here", messageSoFar: "Here", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(4) } },
    { type: "message.completed", data: { finishReason: "stop", message: "Here are the **latest issues**:\n\n- Fix login redirect loop (`bug`)\n- Slow dashboard load (`bug`)\n- Add CSV export (`feature`)\n\nWant me to open any of these?", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(5) } },
    // `usage.inputTokens` is the context meter's numerator (D6).
    { type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId: "t0", usage: { inputTokens: 184_320, outputTokens: 640 } }, meta: { at: iso(5) } },
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
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-1) } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "message.received", data: { message: webhookTaskMessage, sequence: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(0) } },
    { type: "step.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(1) } },
    { type: "turn.failed", data: { code: "provider_error", message: "Model provider returned 401 — credentials rejected.", sequence: 0, turnId: "t0" }, meta: { at: iso(1) } },
  ]),
};

// ── Session 5: a STOPPED run (Support triager) ──────────────────────────────
//
// The eve 0.31 cancellation shape, copied from a real capture
// (spike/tests/fixtures/mocked-cancelled-events.ndjson): cancellation is
// COOPERATIVE at durable step boundaries, so the tool call that was already
// in flight still lands its `action.result`; the turn then ends on
// `turn.cancelled` → `session.waiting` with NO turn.failed / session.failed.
// This one fixture proves all four required behaviors at once — no error
// banner, a frozen (non-blinking) partial reply, the unresolved second tool
// step demoted out of its spinner, and the neutral stopped notice.

const canceledRun: FixtureRun = {
  run: {
    id: "run_stopped",
    status: "canceled",
    triggerEvent: chatTrigger(
      FIXTURE_SUPPORT_TRIAGER,
      "Crawl every open issue and write a full triage report.",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_stopped", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-30), id: "evt_01KZFM7A0000000000000001" } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-29), id: "evt_01KZFM7A0000000000000002" } },
    { type: "message.received", data: { message: "Crawl every open issue and write a full triage report.", sequence: 0, turnId: "t0" }, meta: { at: iso(-29), id: "evt_01KZFM7A0000000000000003" } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-29), id: "evt_01KZFM7A0000000000000004" } },
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "linear__list_issues", input: { limit: 200 } }, { callId: "c2", kind: "tool-call", toolName: "linear__read_issue", input: { id: "ENG-1204" } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-28), id: "evt_01KZFM7A0000000000000005" } },
    // The in-flight call finishes even though the stop already landed.
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "linear__list_issues", output: { content: [{ type: "text", text: "142 issues" }] } }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-22), id: "evt_01KZFM7A0000000000000006" } },
    { type: "message.appended", data: { messageDelta: "I pulled 142", messageSoFar: "I pulled 142 open issues and started grouping them by area —", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(-20), id: "evt_01KZFM7A0000000000000007" } },
    { type: "turn.cancelled", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-19), id: "evt_01KZFM7A0000000000000008" } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(-19), id: "evt_01KZFM7A0000000000000009" } },
  ]),
};

// ── Session 6: a CLEARED session (Data analyst) ──────────────────────────────
//
// The user cleared the context while this run's tail was still attached, so
// `context.cleared` is persisted against it. The transcript stays fully
// readable — only the agent's memory of it is gone — which is exactly what
// the neutral divider says.

const clearedRun: FixtureRun = {
  run: {
    id: "run_cleared",
    status: "succeeded",
    triggerEvent: chatTrigger(
      FIXTURE_DATA_ANALYST,
      "What were last quarter's top three revenue drivers?",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_cleared", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-60), id: "evt_01KZFM7B0000000000000001" } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-59), id: "evt_01KZFM7B0000000000000002" } },
    { type: "message.received", data: { message: "What were last quarter's top three revenue drivers?", sequence: 0, turnId: "t0" }, meta: { at: iso(-59), id: "evt_01KZFM7B0000000000000003" } },
    { type: "message.completed", data: { finishReason: "stop", message: "Last quarter's top three drivers were **self-serve upgrades**, **seat expansion** in existing accounts, and **annual prepay**.", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-55), id: "evt_01KZFM7B0000000000000004" } },
    { type: "turn.completed", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-55), id: "evt_01KZFM7B0000000000000005" } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(-55), id: "evt_01KZFM7B0000000000000006" } },
    { type: "context.cleared", data: { sequence: 1, sessionId: "eve_fixture", turnId: "t0" }, meta: { at: iso(-10), id: "evt_01KZFM7B0000000000000007" } },
  ]),
};

// ── Session 8: a COMPACTED session (Support triager) ─────────────────────────
//
// The non-empty compaction sequence, exactly as eve documents it and the spike
// recorded it: `compaction.requested → compaction.completed → session.waiting`.
// The divider is derived from the COMPLETED event alone (spec D4) — an empty
// context emits neither event and a failed summarization emits only the
// request, and in both of those nothing was summarized, so nothing may claim a
// memory boundary.
//
// It runs to TWO runs on purpose, because that is what the falling meter needs:
// the first measures 903k against a 1M window and is then compacted, the second
// measures the SUMMARIZED context at 41k. A boundary retires every measurement
// taken before it (`contextTokensUsed`), so a session that stopped at the first
// run would show no meter at all — correct, but not the thing this fixture is
// here to preview.

const compactedRun: FixtureRun = {
  run: {
    id: "run_compacted",
    status: "succeeded",
    triggerEvent: chatTrigger(
      FIXTURE_SUPPORT_TRIAGER,
      "Keep going — what's left in the backlog?",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_compacted", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "~deepseek/deepseek-v4-flash-latest" } }, meta: { at: iso(-300), id: "evt_01KZFM7D0000000000000001" } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-299), id: "evt_01KZFM7D0000000000000002" } },
    { type: "message.received", data: { message: "Keep going — what's left in the backlog?", sequence: 0, turnId: "t0" }, meta: { at: iso(-299), id: "evt_01KZFM7D0000000000000003" } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-299), id: "evt_01KZFM7D0000000000000004" } },
    { type: "actions.requested", data: { actions: [{ callId: "cb1", kind: "tool-call", toolName: "linear__search_issues", input: { query: "state:backlog" } }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-298), id: "evt_01KZFM7D0000000000000005" } },
    { type: "action.result", data: { result: { callId: "cb1", kind: "tool-result", toolName: "linear__search_issues", output: { content: [{ type: "text", text: "31 issues in Backlog across 4 teams" }] } }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-296), id: "evt_01KZFM7D0000000000000006" } },
    { type: "message.completed", data: { finishReason: "stop", message: "There are **31 issues** left in the backlog, spread across 4 teams.", sequence: 0, stepIndex: 1, turnId: "t0" }, meta: { at: iso(-294), id: "evt_01KZFM7D0000000000000007" } },
    { type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId: "t0", usage: { inputTokens: 903_000, outputTokens: 380 } }, meta: { at: iso(-294), id: "evt_01KZFM7D0000000000000008" } },
    { type: "turn.completed", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-293), id: "evt_01KZFM7D0000000000000009" } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(-293), id: "evt_01KZFM7D0000000000000010" } },
    { type: "compaction.requested", data: { modelId: "~deepseek/deepseek-v4-flash-latest", sequence: 1, sessionId: "eve_fixture", turnId: "t0", usageInputTokens: 903_000 }, meta: { at: iso(-120), id: "evt_01KZFM7D0000000000000011" } },
    { type: "compaction.completed", data: { modelId: "~deepseek/deepseek-v4-flash-latest", sequence: 2, sessionId: "eve_fixture", turnId: "t0" }, meta: { at: iso(-118), id: "evt_01KZFM7D0000000000000012" } },
  ]),
};

// The exchange AFTER that compaction: same thread, same window, a context that
// now measures 41k because the summary replaced the history.
const postCompactionRun: FixtureRun = {
  run: {
    id: "run_post_compaction",
    status: "succeeded",
    triggerEvent: chatTrigger(
      FIXTURE_SUPPORT_TRIAGER,
      "Which team owns the most of them?",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_post_compaction", [
    { type: "turn.started", data: { sequence: 3, turnId: "t1" }, meta: { at: iso(-110), id: "evt_01KZFM7E0000000000000001" } },
    { type: "message.received", data: { message: "Which team owns the most of them?", sequence: 3, turnId: "t1" }, meta: { at: iso(-110), id: "evt_01KZFM7E0000000000000002" } },
    { type: "message.completed", data: { finishReason: "stop", message: "**Billing** owns 14 of the 31 — nearly half the backlog.", sequence: 3, stepIndex: 0, turnId: "t1" }, meta: { at: iso(-108), id: "evt_01KZFM7E0000000000000003" } },
    { type: "step.completed", data: { finishReason: "stop", sequence: 3, stepIndex: 0, turnId: "t1", usage: { inputTokens: 41_000, outputTokens: 120 } }, meta: { at: iso(-108), id: "evt_01KZFM7E0000000000000004" } },
    { type: "turn.completed", data: { sequence: 3, turnId: "t1" }, meta: { at: iso(-107), id: "evt_01KZFM7E0000000000000005" } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(-107), id: "evt_01KZFM7E0000000000000006" } },
  ]),
};

// ── Session 7: a SESSION-LIMIT continuation prompt (Executive assistant) ─────
//
// eve 0.31's 40M input-token guardrail, shaped exactly as
// `session-limit-continuation.js` builds it: kind "session-limit", a synthetic
// `session_limit_continuation` "tool" (which the card must NOT render as a
// tool approval), and the deterministic Approve/Stop options with eve's own
// per-option descriptions. Answering Stop cancels the turn through the same
// `turn.cancelled` path as the Stop button.

const sessionLimitRun: FixtureRun = {
  run: {
    id: "run_limit",
    status: "waiting",
    triggerEvent: chatTrigger(
      FIXTURE_EXEC_ASSISTANT,
      "Keep going through the rest of the inbox.",
    ),
    taskMessage: null,
    error: null,
  },
  frames: framesFor("run_limit", [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "moonshotai/kimi-k3" } }, meta: { at: iso(-120), id: "evt_01KZFM7C0000000000000001" } },
    { type: "turn.started", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-119), id: "evt_01KZFM7C0000000000000002" } },
    { type: "message.received", data: { message: "Keep going through the rest of the inbox.", sequence: 0, turnId: "t0" }, meta: { at: iso(-119), id: "evt_01KZFM7C0000000000000003" } },
    { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-119), id: "evt_01KZFM7C0000000000000004" } },
    { type: "input.requested", data: { requests: [{ requestId: "eve_fixture:limit:input:40120433", kind: "session-limit", prompt: "This session has hit the input-token limit (40M) per session. This is a guardrail against defective long-running sessions. If session activity looks fine, just approve to keep going.", action: { callId: "eve_fixture:limit:input:40120433", kind: "tool-call", toolName: "session_limit_continuation", input: { kind: "input", limit: 40000000, usedTokens: 40120433 } }, options: [{ id: "continue", label: "Approve", description: "Grant a fresh token budget", style: "primary" }, { id: "stop", label: "Stop", description: "Stop now", style: "danger" }], display: "confirmation", allowFreeform: false }], sequence: 0, stepIndex: 0, turnId: "t0" }, meta: { at: iso(-118), id: "evt_01KZFM7C0000000000000005" } },
    { type: "turn.completed", data: { sequence: 0, turnId: "t0" }, meta: { at: iso(-118), id: "evt_01KZFM7C0000000000000006" } },
    { type: "session.waiting", data: { wait: "next-user-message" }, meta: { at: iso(-118), id: "evt_01KZFM7C0000000000000007" } },
  ]),
};

export const FIXTURE_SESSIONS: FixtureSession[] = [
  {
    summary: sessionSummary(
      "s_live",
      FIXTURE_EXEC_ASSISTANT,
      "active",
      "running",
      30,
      "Launch announcement draft",
    ),
    versionLabel: "v_a1b2c3",
    runs: [streamingRun],
  },
  {
    // Untitled on purpose: the sidebar falls back to the first message.
    summary: sessionSummary(
      "s_parked",
      FIXTURE_EXEC_ASSISTANT,
      "waiting",
      "waiting",
      240,
      null,
    ),
    versionLabel: "v_a1b2c3",
    runs: [parkedRun],
  },
  {
    summary: sessionSummary(
      "s_done",
      FIXTURE_SUPPORT_TRIAGER,
      "active",
      "succeeded",
      7200,
      "Issue tracker summary",
    ),
    versionLabel: "v_9a8b7c",
    runs: [completedRun],
  },
  {
    // Workflow-dispatched sessions are never titled — the titler runs off the
    // first USER message, and a dispatch has a rendered task message instead.
    summary: sessionSummary(
      "s_failed",
      FIXTURE_DATA_ANALYST,
      "error",
      "failed",
      172800,
      null,
      {
        origin: "webhook",
        workflowId: FIXTURE_WORKFLOW_ID,
        workflowName: FIXTURE_WORKFLOW_NAME,
      },
    ),
    versionLabel: "v_0f1e2d",
    runs: [failedRun],
  },
  // APPENDED, never spliced: fixture-chat.test.tsx addresses the Executive
  // assistant sessions by list index, so new sessions go on the end.
  {
    summary: sessionSummary(
      "s_stopped",
      FIXTURE_SUPPORT_TRIAGER,
      "active",
      "canceled",
      900,
      "Full open-issue triage report",
    ),
    versionLabel: "v_9a8b7c",
    runs: [canceledRun],
  },
  {
    summary: sessionSummary(
      "s_cleared",
      FIXTURE_DATA_ANALYST,
      "active",
      "succeeded",
      3600,
      "Top revenue drivers last quarter",
    ),
    versionLabel: "v_0f1e2d",
    runs: [clearedRun],
  },
  {
    summary: sessionSummary(
      "s_limit",
      FIXTURE_EXEC_ASSISTANT,
      "waiting",
      "waiting",
      5400,
      null,
    ),
    versionLabel: "v_a1b2c3",
    runs: [sessionLimitRun],
  },
  // Older than every other Support triager session ON PURPOSE: the sidebar
  // buckets by recency, so this lands below `s_done` and the specs that address
  // "the idle Support triager row" keep finding the one they mean.
  {
    summary: sessionSummary(
      "s_compacted",
      FIXTURE_SUPPORT_TRIAGER,
      "active",
      "succeeded",
      90_000,
      "Backlog check-in",
    ),
    versionLabel: "v_9a8b7c",
    runs: [compactedRun, postCompactionRun],
  },
];

/**
 * The tool directory the live thread fetches per pinned agent version
 * (`GET …/agents/:id/versions/:id/tools`), canned so fixture mode renders tool
 * steps as English (D5) with no backend.
 *
 * `linear__read_issue` is deliberately ABSENT from the tools list even though a
 * fixture run calls it: a connection probed before a server added a tool is the
 * ordinary case, and the step must still read "Linear · Read issue" — just
 * without a description.
 */
export const FIXTURE_TOOL_DIRECTORY: AgentVersionToolDirectory = {
  agentVersionId: "dddddddd-0001-4000-8000-000000000001",
  connections: [
    {
      slug: "linear",
      connectionId: "cn_fixturelinear001",
      connectionName: "Linear",
      tools: [
        {
          name: "list_issues",
          description: "List issues in a team, newest first.",
          params: ["teamId", "limit"],
        },
        {
          name: "search_issues",
          description: "Search issues by full-text query or filter expression.",
          params: ["query"],
        },
      ],
    },
  ],
};

export const FIXTURE_MODE: boolean =
  import.meta.env.VITE_FIXTURE_MODE === "1" ||
  import.meta.env.VITE_FIXTURE_MODE === "true";
