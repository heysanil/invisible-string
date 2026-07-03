import { describe, expect, test } from "bun:test";

import {
  COPILOT_MUTATION_TOOLS,
  copilotClientFrameSchema,
  copilotMutationParamSchemas,
  copilotProposalSchema,
  copilotServerFrameSchema,
  parseCopilotClientFrame,
  parseCopilotServerFrame,
} from "./copilot";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("copilot mutation param schemas", () => {
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

  test("setAgent requires at least one field", () => {
    expect(copilotMutationParamSchemas.setAgent.safeParse({}).success).toBe(false);
    expect(
      copilotMutationParamSchemas.setAgent.safeParse({ reasoning: "high" }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.setAgent.safeParse({ agentPresetId: UUID })
        .success,
    ).toBe(true);
  });

  test("setModelPreset only accepts the three preset slugs", () => {
    expect(
      copilotMutationParamSchemas.setModelPreset.safeParse({ slug: "balanced" })
        .success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.setModelPreset.safeParse({ slug: "fastest" })
        .success,
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

describe("copilot proposal schema", () => {
  test("valid proposal round-trips; params validated per tool", () => {
    const ok = copilotProposalSchema.safeParse({
      id: "call_1",
      tool: "setModelPreset",
      params: { slug: "quick" },
      rationale: "Cheap triage",
    });
    expect(ok.success).toBe(true);

    const wrongParams = copilotProposalSchema.safeParse({
      id: "call_1",
      tool: "setModelPreset",
      params: { slug: 42 },
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

  test("tool list covers exactly the six mutations", () => {
    expect([...COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addContext",
      "removeContext",
      "setAgent",
      "setInstructions",
      "setModelPreset",
      "setTrigger",
    ]);
  });
});

describe("copilot frames", () => {
  test("client frames parse", () => {
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        workflowId: UUID,
        draft: { trigger: { type: "manual" } },
        message: "make it triage emails",
      }).success,
    ).toBe(true);
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
