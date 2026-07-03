/**
 * Pillar-card diagnostics mapping: local mirror checks + dry-run error
 * distribution route each problem to the correct pillar (or general bucket).
 */
import { expect, test } from "bun:test";
import type { ApiErrorInfo, WorkflowDefinition } from "@invisible-string/shared";

import {
  countIssues,
  dryRunDiagnostics,
  localDiagnostics,
  pillarIssueCount,
  type LocalCheckInputs,
} from "../lib/builder/diagnostics";
import type { ReferenceSources } from "../lib/builder/references";

const PRESET = "a1111111-1111-4111-8111-111111111111";

function baseDefinition(): WorkflowDefinition {
  return {
    trigger: { type: "manual" },
    context: { mcpConnectionIds: [], skillIds: [] },
    agent: { agentPresetId: PRESET },
    instructions: { markdown: "Do the thing." },
  };
}

const sources: ReferenceSources = {
  trigger: { type: "manual" },
  connections: [],
  skills: [],
};

function inputs(
  definition: WorkflowDefinition,
  overrides: Partial<LocalCheckInputs> = {},
): LocalCheckInputs {
  return {
    definition,
    sources: overrides.sources ?? { ...sources, trigger: definition.trigger },
    agentPresetIds: overrides.agentPresetIds ?? [PRESET],
    allowedModelIds: overrides.allowedModelIds ?? [],
  };
}

// ── local mirror ─────────────────────────────────────────────────────────────

test("a valid draft produces no local diagnostics", () => {
  const diagnostics = localDiagnostics(inputs(baseDefinition()));
  expect(countIssues(diagnostics)).toBe(0);
});

test("empty instructions warn on the instructions pillar (saveable draft)", () => {
  const definition = { ...baseDefinition(), instructions: { markdown: "  " } };
  const diagnostics = localDiagnostics(inputs(definition));
  expect(pillarIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.pillars.instructions[0]!.severity).toBe("warning");
});

test("unknown agent preset flags the agent pillar", () => {
  const diagnostics = localDiagnostics(
    inputs(baseDefinition(), { agentPresetIds: ["someone-else"] }),
  );
  expect(pillarIssueCount(diagnostics, "agent")).toBe(1);
  expect(diagnostics.pillars.agent[0]!.severity).toBe("error");
});

test("a non-allowlisted model override flags the agent pillar", () => {
  const definition: WorkflowDefinition = {
    ...baseDefinition(),
    agent: { agentPresetId: PRESET, modelId: "anthropic/claude-sonnet-5" },
  };
  const diagnostics = localDiagnostics(
    inputs(definition, { allowedModelIds: ["z-ai/glm-5.2"] }),
  );
  expect(
    diagnostics.pillars.agent.some((d) => d.message.includes("allowlist")),
  ).toBe(true);
});

test("unresolved @reference warns on the instructions pillar", () => {
  const definition: WorkflowDefinition = {
    ...baseDefinition(),
    instructions: { markdown: "Ping @github about it." },
  };
  const diagnostics = localDiagnostics(inputs(definition));
  expect(pillarIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.pillars.instructions[0]!.message).toContain("@github");
});

test("a duplicate form field key flags the trigger pillar once", () => {
  const definition: WorkflowDefinition = {
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
  expect(pillarIssueCount(diagnostics, "trigger")).toBeGreaterThanOrEqual(1);
});

test("loading resources (null lists) skips existence checks", () => {
  const diagnostics = localDiagnostics(
    inputs(baseDefinition(), {
      agentPresetIds: null,
      allowedModelIds: null,
    }),
  );
  expect(pillarIssueCount(diagnostics, "agent")).toBe(0);
});

// ── dry-run distribution ─────────────────────────────────────────────────────

test("draft_invalid zod issues route by their pillar path head", () => {
  const error: ApiErrorInfo = {
    code: "draft_invalid",
    message: "invalid",
    details: [
      { message: "Required", path: ["trigger", "fields"] },
      { message: "too small", path: ["instructions", "markdown"] },
    ],
  };
  const diagnostics = dryRunDiagnostics(error);
  expect(pillarIssueCount(diagnostics, "trigger")).toBe(1);
  expect(pillarIssueCount(diagnostics, "instructions")).toBe(1);
  expect(diagnostics.general.length).toBe(0);
});

test("compile_failed connection-path issues route to context", () => {
  const error: ApiErrorInfo = {
    code: "compile_failed",
    message: "workflow failed to compile",
    details: [
      { path: "connections.linear.url", message: "no resolved URL" },
      { message: "UNRESOLVED_REFERENCE: @github does not match" },
    ],
  };
  const diagnostics = dryRunDiagnostics(error);
  expect(pillarIssueCount(diagnostics, "context")).toBe(1);
  expect(pillarIssueCount(diagnostics, "instructions")).toBe(1);
});

test("compile_failed EMPTY_INSTRUCTIONS routes to instructions", () => {
  const error: ApiErrorInfo = {
    code: "compile_failed",
    message: "failed",
    details: [{ message: "EMPTY_INSTRUCTIONS: instructions are empty" }],
  };
  const diagnostics = dryRunDiagnostics(error);
  expect(pillarIssueCount(diagnostics, "instructions")).toBe(1);
});

test("model_not_allowlisted routes to agent", () => {
  const error: ApiErrorInfo = {
    code: "model_not_allowlisted",
    message: 'model "x" is not on this workspace\'s model allowlist',
  };
  const diagnostics = dryRunDiagnostics(error);
  expect(pillarIssueCount(diagnostics, "agent")).toBe(1);
});

test("an unknown error code falls into the general bucket", () => {
  const error: ApiErrorInfo = { code: "teapot", message: "no coffee" };
  const diagnostics = dryRunDiagnostics(error);
  expect(diagnostics.general.length).toBe(1);
  expect(countIssues(diagnostics)).toBe(1);
});
