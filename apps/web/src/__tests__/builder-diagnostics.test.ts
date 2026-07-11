/**
 * Section-card diagnostics mapping: local mirror checks + server-finding
 * distribution route each problem to the correct section (or general bucket).
 */
import { expect, test } from "bun:test";
import type {
  AgentSummaryDto,
  WorkflowConfig,
  WorkflowDiagnostics,
} from "@invisible-string/shared";

import {
  countIssues,
  localDiagnostics,
  sectionIssueCount,
  serverDiagnostics,
  type LocalCheckInputs,
} from "../lib/builder/diagnostics";
import type { ReferenceSources } from "../lib/builder/references";

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";

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
  };
}

function baseDefinition(): WorkflowConfig {
  return {
    trigger: { type: "manual" },
    agentId: AGENT_ID,
    instructions: { markdown: "Do the thing." },
  };
}

const sources: ReferenceSources = {
  trigger: { type: "manual" },
  connections: [],
  skills: [],
};

function inputs(
  definition: WorkflowConfig,
  overrides: Partial<LocalCheckInputs> = {},
): LocalCheckInputs {
  return {
    definition,
    sources: overrides.sources ?? { ...sources, trigger: definition.trigger },
    agents: "agents" in overrides ? (overrides.agents ?? null) : [agent()],
    contextResolved: overrides.contextResolved ?? true,
  };
}

// ── local mirror ─────────────────────────────────────────────────────────────

test("a valid draft produces no local diagnostics", () => {
  const diagnostics = localDiagnostics(inputs(baseDefinition()));
  expect(countIssues(diagnostics)).toBe(0);
});

test("empty instructions warn on the instructions section (saveable draft)", () => {
  const definition = { ...baseDefinition(), instructions: { markdown: "  " } };
  const diagnostics = localDiagnostics(inputs(definition));
  expect(sectionIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.sections.instructions[0]!.severity).toBe("warning");
});

test("no agent selected blocks publish with an agent-section error", () => {
  const definition = { ...baseDefinition(), agentId: null };
  const diagnostics = localDiagnostics(inputs(definition));
  expect(sectionIssueCount(diagnostics, "agent")).toBe(1);
  expect(diagnostics.sections.agent[0]!.severity).toBe("error");
});

test("a vanished agent flags the agent section", () => {
  const diagnostics = localDiagnostics(
    inputs(baseDefinition(), { agents: [agent({ id: "someone-else" })] }),
  );
  expect(sectionIssueCount(diagnostics, "agent")).toBe(1);
  expect(diagnostics.sections.agent[0]!.severity).toBe("error");
  expect(diagnostics.sections.agent[0]!.message).toContain("no longer exists");
});

test("an unpublished agent flags the agent section by name", () => {
  const diagnostics = localDiagnostics(
    inputs(baseDefinition(), {
      agents: [agent({ publishedVersionId: null, publishedAt: null, buildStatus: null })],
    }),
  );
  expect(sectionIssueCount(diagnostics, "agent")).toBe(1);
  expect(diagnostics.sections.agent[0]!.severity).toBe("error");
  expect(diagnostics.sections.agent[0]!.message).toContain("Executive assistant");
  expect(diagnostics.sections.agent[0]!.message).toContain("publish");
});

test("a loading agent inventory (null) skips agent existence checks", () => {
  const diagnostics = localDiagnostics(
    inputs(baseDefinition(), { agents: null }),
  );
  expect(sectionIssueCount(diagnostics, "agent")).toBe(0);
});

test("unresolved @connection reference warns on the instructions section", () => {
  const definition: WorkflowConfig = {
    ...baseDefinition(),
    instructions: { markdown: "Ping @github about it." },
  };
  const diagnostics = localDiagnostics(inputs(definition));
  expect(sectionIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.sections.instructions[0]!.message).toContain("@github");
});

test("connection/skill ref checks pause while the agent context loads; @trigger refs do not", () => {
  const definition: WorkflowConfig = {
    ...baseDefinition(),
    instructions: { markdown: "Ping @github with @trigger.email." },
  };
  const diagnostics = localDiagnostics(
    inputs(definition, { contextResolved: false }),
  );
  // The manual trigger carries no dispatch data → @trigger.email still warns;
  // @github is withheld until the selected agent's context resolves.
  expect(sectionIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.sections.instructions[0]!.message).toContain("@trigger.email");
});

test("a duplicate form field key flags the trigger section once", () => {
  const definition: WorkflowConfig = {
    ...baseDefinition(),
    trigger: {
      type: "form",
      fields: [
        { key: "dup", label: "A", type: "text", required: false },
        { key: "dup", label: "B", type: "text", required: false },
      ],
    },
  };
  const diagnostics = localDiagnostics(
    inputs(definition, {
      sources: { ...sources, trigger: definition.trigger },
    }),
  );
  expect(sectionIssueCount(diagnostics, "trigger")).toBeGreaterThanOrEqual(1);
});

// ── server-finding distribution ──────────────────────────────────────────────

test("server findings route by their config path head", () => {
  const findings: WorkflowDiagnostics = [
    { path: "agentId", message: "agent is not published", severity: "error" },
    {
      path: "instructions.markdown",
      message: "@linear is not in the agent's context",
      severity: "warning",
    },
    { path: "trigger.fields.0.key", message: "duplicate key", severity: "error" },
  ];
  const diagnostics = serverDiagnostics(findings);
  expect(sectionIssueCount(diagnostics, "agent")).toBe(1);
  expect(sectionIssueCount(diagnostics, "instructions")).toBe(1);
  expect(sectionIssueCount(diagnostics, "trigger")).toBe(1);
  expect(diagnostics.general.length).toBe(0);
  expect(diagnostics.sections.instructions[0]!.severity).toBe("warning");
});

test("an unrooted server finding falls into the general bucket", () => {
  const diagnostics = serverDiagnostics([
    { path: "", message: "draft is empty", severity: "error" },
    { path: "somethingElse", message: "??", severity: "warning" },
  ]);
  expect(diagnostics.general.length).toBe(2);
  expect(countIssues(diagnostics)).toBe(2);
});
