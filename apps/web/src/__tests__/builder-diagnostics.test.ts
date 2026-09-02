/**
 * Pipeline diagnostics mapping: local mirror checks + server-finding
 * distribution route each problem to the trigger card, the owning step card
 * (`steps.<index>…` paths resolved to step IDS through the live draft), or
 * the general bucket.
 */
import { expect, test } from "bun:test";
import {
  newStepId,
  type AgentSummaryDto,
  type PipelineStep,
  type WorkflowConfig,
  type WorkflowDiagnostics,
} from "@invisible-string/shared";

import {
  countIssues,
  hasBlockingIssue,
  localDiagnostics,
  mergeDiagnostics,
  serverDiagnostics,
  stepIssueCount,
  triggerIssueCount,
  type LocalCheckInputs,
} from "../lib/builder/diagnostics";

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "cn_aaaaaaaaaaaaaa";

function agent(overrides: Partial<AgentSummaryDto> = {}): AgentSummaryDto {
  return {
    id: AGENT_ID,
    name: "Executive assistant",
    description: null,
    runAsUserId: "user-1",
    publishedVersionId: "v-1",
    publishedAt: "2026-07-01T00:00:00.000Z",
    buildStatus: "succeeded",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as AgentSummaryDto;
}

function toolStep(overrides: Partial<Extract<PipelineStep, { kind: "tool" }>> = {}): PipelineStep {
  return {
    id: newStepId(),
    slug: "search",
    kind: "tool",
    connectionId: CONNECTION_ID,
    tool: "search_messages",
    args: {},
    sideEffect: "at_least_once",
    ...overrides,
  };
}

function agentStep(
  overrides: Partial<Extract<PipelineStep, { kind: "agent" }>> = {},
): PipelineStep {
  return {
    id: newStepId(),
    slug: "delegate",
    kind: "agent",
    agentId: AGENT_ID,
    instructions: { markdown: "Do the thing." },
    session: "fresh",
    ...overrides,
  };
}

function config(steps: PipelineStep[], overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    version: 2,
    trigger: { type: "manual" },
    steps,
    overlap: "skip",
    ...overrides,
  };
}

function inputs(
  definition: WorkflowConfig,
  overrides: Partial<LocalCheckInputs> = {},
): LocalCheckInputs {
  return {
    definition,
    connections:
      "connections" in overrides
        ? (overrides.connections ?? null)
        : [{ id: CONNECTION_ID, name: "Slack" }],
    agents: "agents" in overrides ? (overrides.agents ?? null) : [agent()],
  };
}

// ── local mirror ─────────────────────────────────────────────────────────────

test("a valid one-step draft produces no local diagnostics", () => {
  const diagnostics = localDiagnostics(inputs(config([toolStep()])));
  expect(countIssues(diagnostics)).toBe(0);
  expect(hasBlockingIssue(diagnostics)).toBe(false);
});

test("an empty pipeline warns in the general bucket (saveable draft)", () => {
  const diagnostics = localDiagnostics(inputs(config([])));
  expect(diagnostics.general).toHaveLength(1);
  expect(diagnostics.general[0]!.severity).toBe("warning");
  expect(hasBlockingIssue(diagnostics)).toBe(false);
});

test("a tool step with no connection errors on ITS card", () => {
  const step = toolStep({ connectionId: "" });
  const diagnostics = localDiagnostics(inputs(config([step])));
  expect(stepIssueCount(diagnostics, step.id)).toBe(1);
  expect(diagnostics.byStep[step.id]![0]!.severity).toBe("error");
  expect(hasBlockingIssue(diagnostics)).toBe(true);
});

test("a vanished connection errors; a loading inventory stays silent", () => {
  const step = toolStep();
  const vanished = localDiagnostics(
    inputs(config([step]), { connections: [{ id: "cn_bbbbbbbbbbbbbb", name: "Other" }] }),
  );
  expect(diagText(vanished, step.id)).toContain("no longer exists");

  const loading = localDiagnostics(
    inputs(config([step]), { connections: null }),
  );
  expect(stepIssueCount(loading, step.id)).toBe(0);
});

test("an empty tool name warns (incomplete, not broken)", () => {
  const step = toolStep({ tool: "" });
  const diagnostics = localDiagnostics(inputs(config([step])));
  expect(stepIssueCount(diagnostics, step.id)).toBe(1);
  expect(diagnostics.byStep[step.id]![0]!.severity).toBe("warning");
});

test("agent step checks: none / vanished / unpublished, on the step card", () => {
  const none = agentStep({ agentId: null });
  expect(diagText(localDiagnostics(inputs(config([none]))), none.id)).toContain(
    "Choose an agent",
  );

  const vanished = agentStep();
  expect(
    diagText(
      localDiagnostics(
        inputs(config([vanished]), { agents: [agent({ id: "b2222222-2222-4222-8222-222222222222" })] }),
      ),
      vanished.id,
    ),
  ).toContain("no longer exists");

  const unpublished = agentStep();
  expect(
    diagText(
      localDiagnostics(
        inputs(config([unpublished]), {
          agents: [agent({ publishedVersionId: null, publishedAt: null, buildStatus: null })],
        }),
      ),
      unpublished.id,
    ),
  ).toContain("isn't published yet");

  // Loading inventory (null) skips agent existence checks.
  const waiting = agentStep();
  expect(
    stepIssueCount(
      localDiagnostics(inputs(config([waiting]), { agents: null })),
      waiting.id,
    ),
  ).toBe(0);
});

test("thread sessions require a slack trigger and forbid output schemas", () => {
  const thread = agentStep({ session: "thread" });
  const wrongTrigger = localDiagnostics(inputs(config([thread])));
  expect(diagText(wrongTrigger, thread.id)).toContain("Slack trigger");

  const withSchema = agentStep({
    session: "thread",
    output: { schema: { type: "object", properties: {} } },
  });
  const slackConfig = config([withSchema], {
    trigger: { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
  });
  expect(diagText(localDiagnostics(inputs(slackConfig)), withSchema.id)).toContain(
    "output schema",
  );
});

test("empty prompts and instructions warn per step", () => {
  const infer: PipelineStep = {
    id: newStepId(),
    slug: "summarize",
    kind: "infer",
    preset: "quick",
    prompt: { markdown: "  " },
  };
  const empty = agentStep({ slug: "delegate", instructions: { markdown: "" } });
  const diagnostics = localDiagnostics(inputs(config([infer, empty])));
  expect(stepIssueCount(diagnostics, infer.id)).toBe(1);
  expect(diagnostics.byStep[infer.id]![0]!.severity).toBe("warning");
  expect(diagText(diagnostics, empty.id)).toContain("Instructions are empty");
});

test("unresolved @refs in a prompt land on the step; connection refs are withheld", () => {
  const search = toolStep();
  const infer: PipelineStep = {
    id: newStepId(),
    slug: "summarize",
    kind: "infer",
    preset: "quick",
    // @steps.search resolves (prior step); @steps.later does not; @github is
    // a connection ref, unknowable locally (the bound agent's context is a
    // server-side concern) — never flagged here.
    prompt: { markdown: "Use @steps.search.text then @steps.later and @github." },
  };
  const diagnostics = localDiagnostics(inputs(config([search, infer])));
  const messages = diagnostics.byStep[infer.id]!.map((d) => d.message).join("\n");
  expect(messages).toContain("@steps.later");
  expect(messages).not.toContain("@github");
});

test("bad $ref scope paths in args / items / conditions warn on their step", () => {
  const search = toolStep({
    args: {
      query: { $tpl: "after @state.missing" },
      channel: { $ref: "secrets.token" },
    },
  });
  const loop: PipelineStep = {
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "steps.nope.result" },
    steps: [],
    maxItems: 100,
    onItemError: "halt",
  };
  const gate: PipelineStep = {
    id: newStepId(),
    slug: "gate",
    kind: "filter",
    where: { eq: [{ $ref: "steps.search.result" }, { $ref: "state.gone" }] },
  };
  const diagnostics = localDiagnostics(inputs(config([search, loop, gate])));
  expect(diagText(diagnostics, search.id)).toContain("not a scope root");
  expect(diagText(diagnostics, search.id)).toContain("@state.missing");
  expect(diagText(diagnostics, loop.id)).toContain('"nope"');
  expect(diagText(diagnostics, gate.id)).toContain('"gone"');
});

test("duplicate slugs (schema superRefine) route to the offending step card", () => {
  const first = toolStep({ slug: "dup" });
  const second = toolStep({ slug: "dup", id: newStepId() });
  const diagnostics = localDiagnostics(inputs(config([first, second])));
  expect(diagText(diagnostics, second.id)).toContain("duplicate step slug");
  expect(hasBlockingIssue(diagnostics)).toBe(true);
});

test("a broken trigger flags the trigger card", () => {
  const definition = config([toolStep()], {
    trigger: { type: "schedule", cron: "not-a-cron" },
  });
  const diagnostics = localDiagnostics(inputs(definition));
  expect(triggerIssueCount(diagnostics)).toBeGreaterThanOrEqual(1);
  expect(diagnostics.trigger[0]!.severity).toBe("error");
});

// ── server-finding distribution ──────────────────────────────────────────────

test("server findings route trigger / step-index / unrooted paths", () => {
  const search = toolStep();
  const inner = toolStep({ slug: "create", id: newStepId() });
  const loop: PipelineStep = {
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "steps.search.result" },
    steps: [inner],
    maxItems: 100,
    onItemError: "halt",
  };
  const findings: WorkflowDiagnostics = [
    { path: "trigger.cron", message: "bad cron", severity: "error" },
    { path: "steps.0.tool", message: "unknown tool", severity: "error" },
    { path: "steps.1.steps.0.args.title", message: "bad arg", severity: "warning" },
    { path: "", message: "draft is empty", severity: "error" },
    { path: "steps.9.tool", message: "stale index", severity: "error" },
  ];
  const diagnostics = serverDiagnostics(findings, [search, loop]);
  expect(triggerIssueCount(diagnostics)).toBe(1);
  expect(stepIssueCount(diagnostics, search.id)).toBe(1);
  expect(stepIssueCount(diagnostics, inner.id)).toBe(1);
  expect(diagnostics.byStep[inner.id]![0]!.severity).toBe("warning");
  // The empty path and the stale index both degrade to general.
  expect(diagnostics.general).toHaveLength(2);
  expect(countIssues(diagnostics)).toBe(5);
});

test("branch lane and else paths resolve to the nested step", () => {
  const laneStep = toolStep({ slug: "lane", id: newStepId() });
  const elseStep = toolStep({ slug: "fallback", id: newStepId() });
  const fork: PipelineStep = {
    id: newStepId(),
    slug: "fork",
    kind: "branch",
    branches: [{ when: { truthy: { $ref: "steps.lane.result" } }, steps: [laneStep] }],
    else: [elseStep],
  };
  const diagnostics = serverDiagnostics(
    [
      { path: "steps.0.branches.0.steps.0.tool", message: "a", severity: "error" },
      { path: "steps.0.else.0.tool", message: "b", severity: "error" },
      { path: "steps.0.branches.0.when", message: "c", severity: "warning" },
    ],
    [fork],
  );
  expect(stepIssueCount(diagnostics, laneStep.id)).toBe(1);
  expect(stepIssueCount(diagnostics, elseStep.id)).toBe(1);
  // A path into the branch's own fields stays on the branch card.
  expect(stepIssueCount(diagnostics, fork.id)).toBe(1);
});

test("mergeDiagnostics concatenates per card", () => {
  const step = toolStep();
  const a = serverDiagnostics(
    [{ path: "steps.0.tool", message: "a", severity: "error" }],
    [step],
  );
  const b = serverDiagnostics(
    [
      { path: "steps.0.tool", message: "b", severity: "warning" },
      { path: "trigger", message: "t", severity: "warning" },
    ],
    [step],
  );
  const merged = mergeDiagnostics(a, b);
  expect(stepIssueCount(merged, step.id)).toBe(2);
  expect(triggerIssueCount(merged)).toBe(1);
  expect(countIssues(merged)).toBe(3);
});

function diagText(
  diagnostics: ReturnType<typeof localDiagnostics>,
  stepId: string,
): string {
  return (diagnostics.byStep[stepId] ?? []).map((d) => d.message).join("\n");
}
