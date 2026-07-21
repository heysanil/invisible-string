import { describe, expect, test } from "bun:test";

import {
  AGENT_COPILOT_MUTATION_TOOLS,
  COPILOT_MUTATION_TOOLS,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  agentCopilotMutationParamSchemas,
  copilotClientFrameSchema,
  copilotMutationParamSchemas,
  copilotProposalSchema,
  copilotServerFrameSchema,
  parseCopilotClientFrame,
  parseCopilotServerFrame,
} from "./copilot";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("workflow-surface mutation param schemas", () => {
  test("setTrigger accepts a full trigger config and rejects malformed ones", () => {
    expect(
      copilotMutationParamSchemas.setTrigger.safeParse({
        trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.setTrigger.safeParse({
        trigger: { type: "schedule", cron: "not a cron" },
      }).success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.setTrigger.safeParse({
        trigger: { type: "form", fields: [] },
      }).success,
    ).toBe(false);
  });

  test("setAgent requires an agent uuid", () => {
    expect(copilotMutationParamSchemas.setAgent.safeParse({ agentId: UUID }).success).toBe(
      true,
    );
    expect(copilotMutationParamSchemas.setAgent.safeParse({}).success).toBe(false);
    expect(
      copilotMutationParamSchemas.setAgent.safeParse({ agentId: "general" }).success,
    ).toBe(false);
  });

  test("setInstructions requires non-empty markdown", () => {
    expect(
      copilotMutationParamSchemas.setInstructions.safeParse({ markdown: "" })
        .success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.setInstructions.safeParse({
        markdown: "Triage @trigger.subject",
      }).success,
    ).toBe(true);
  });
});

describe("agent-surface mutation param schemas", () => {
  test("setPersona requires non-empty markdown", () => {
    expect(
      agentCopilotMutationParamSchemas.setPersona.safeParse({ markdown: "" }).success,
    ).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setPersona.safeParse({
        markdown: "You are a release manager.",
      }).success,
    ).toBe(true);
  });

  test("setModel requires at least one field and validates enums", () => {
    expect(agentCopilotMutationParamSchemas.setModel.safeParse({}).success).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setModel.safeParse({ reasoning: "high" }).success,
    ).toBe(true);
    expect(
      agentCopilotMutationParamSchemas.setModel.safeParse({ preset: "quick" }).success,
    ).toBe(true);
    expect(
      agentCopilotMutationParamSchemas.setModel.safeParse({
        modelId: "deepseek/deepseek-v4-flash",
      }).success,
    ).toBe(true);
    expect(
      agentCopilotMutationParamSchemas.setModel.safeParse({ preset: "turbo" }).success,
    ).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setModel.safeParse({ reasoning: "max" }).success,
    ).toBe(false);
  });

  test("addContext/removeContext require a kind and uuid", () => {
    expect(
      copilotMutationParamSchemas.addContext.safeParse({
        kind: "connection",
        id: UUID,
      }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.removeContext.safeParse({
        kind: "skill",
        id: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.addContext.safeParse({
        kind: "workflow",
        id: UUID,
      }).success,
    ).toBe(false);
  });
});

describe("tool registries", () => {
  test("workflow surface exposes exactly its three mutations", () => {
    expect([...WORKFLOW_COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "setAgent",
      "setInstructions",
      "setTrigger",
    ]);
  });

  test("agent surface exposes exactly its four mutations", () => {
    expect([...AGENT_COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addContext",
      "removeContext",
      "setModel",
      "setPersona",
    ]);
  });

  test("the combined registry is the disjoint union of both surfaces", () => {
    expect([...COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addContext",
      "removeContext",
      "setAgent",
      "setInstructions",
      "setModel",
      "setPersona",
      "setTrigger",
    ]);
  });
});

describe("copilot proposal schema", () => {
  test("valid proposal round-trips; params validated per tool", () => {
    const ok = copilotProposalSchema.safeParse({
      id: "call_1",
      tool: "setModel",
      params: { preset: "quick" },
      rationale: "Cheap triage",
    });
    expect(ok.success).toBe(true);

    const wrongParams = copilotProposalSchema.safeParse({
      id: "call_1",
      tool: "setModel",
      params: { preset: 42 },
      rationale: "",
    });
    expect(wrongParams.success).toBe(false);

    const unknownTool = copilotProposalSchema.safeParse({
      id: "call_1",
      tool: "dropTables",
      params: {},
      rationale: "",
    });
    expect(unknownTool.success).toBe(false);
  });
});

describe("copilot frames", () => {
  test("client frames parse (surface is required on user_message)", () => {
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "workflow",
        entityId: UUID,
        draft: { trigger: { type: "manual" } },
        message: "make it triage emails",
      }).success,
    ).toBe(true);
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: { persona: "You are helpful." },
        message: "equip it with linear",
      }).success,
    ).toBe(true);
    // No surface, unknown surface → invalid.
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        entityId: UUID,
        draft: {},
        message: "hi",
      }).success,
    ).toBe(false);
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "pillar",
        entityId: UUID,
        draft: {},
        message: "hi",
      }).success,
    ).toBe(false);
    expect(
      copilotClientFrameSchema.safeParse({
        type: "mutation_result",
        proposalId: "call_1",
        outcome: "rejected",
        reason: "wrong trigger",
      }).success,
    ).toBe(true);
    expect(copilotClientFrameSchema.safeParse({ type: "abort" }).success).toBe(true);
    expect(
      copilotClientFrameSchema.safeParse({ type: "user_message", message: "" })
        .success,
    ).toBe(false);
  });

  test("server frames parse", () => {
    expect(
      copilotServerFrameSchema.safeParse({ type: "delta", text: "hi" }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({
        type: "proposal",
        proposal: {
          id: "call_2",
          tool: "addContext",
          params: { kind: "skill", id: UUID },
          rationale: "attach triage skill",
        },
      }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({
        type: "done",
        reason: "completed",
        outputTokens: 12,
      }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({
        type: "error",
        code: "over_budget",
        message: "turn exceeded output budget",
      }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({ type: "error", code: "nope", message: "" })
        .success,
    ).toBe(false);
  });
});

describe("parse helpers", () => {
  test("parseCopilotServerFrame round-trips valid frames and nulls invalid ones", () => {
    expect(
      parseCopilotServerFrame(JSON.stringify({ type: "delta", text: "hi" })),
    ).toEqual({ type: "delta", text: "hi" });
    expect(parseCopilotServerFrame(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseCopilotServerFrame("not json")).toBeNull();
    expect(parseCopilotServerFrame(42)).toBeNull();
  });

  test("parseCopilotClientFrame round-trips valid frames and nulls invalid ones", () => {
    expect(
      parseCopilotClientFrame(
        JSON.stringify({
          type: "mutation_result",
          proposalId: "p1",
          outcome: "accepted",
        }),
      ),
    ).toEqual({ type: "mutation_result", proposalId: "p1", outcome: "accepted" });
    expect(parseCopilotClientFrame(JSON.stringify({ type: "abort" }))).toEqual({
      type: "abort",
    });
    expect(
      parseCopilotClientFrame(JSON.stringify({ type: "user_message" })),
    ).toBeNull();
  });
});
