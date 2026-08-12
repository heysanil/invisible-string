import { describe, expect, test } from "bun:test";

import {
  AGENT_COPILOT_MUTATION_TOOLS,
  COPILOT_MAX_DESCRIPTION_CHARS,
  COPILOT_MUTATION_TOOLS,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  agentCopilotMutationParamSchemas,
  copilotClientFrameSchema,
  copilotMutationParamSchemas,
  copilotProposalSchema,
  copilotServerFrameSchema,
  parseCopilotClientFrame,
  parseCopilotServerFrame,
  type CopilotServerFrame,
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
  test("setName mirrors the agent PATCH route's name rules", () => {
    expect(
      agentCopilotMutationParamSchemas.setName.safeParse({ name: "Release manager" })
        .success,
    ).toBe(true);
    // Trimmed, so whitespace alone is not a name.
    expect(
      agentCopilotMutationParamSchemas.setName.safeParse({ name: "   " }).success,
    ).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setName.safeParse({
        name: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(agentCopilotMutationParamSchemas.setName.safeParse({}).success).toBe(false);
  });

  test("setDescription is one line and bounded well below the DTO's 2000", () => {
    expect(
      agentCopilotMutationParamSchemas.setDescription.safeParse({
        description: "Triages inbound support email and files Linear issues.",
      }).success,
    ).toBe(true);
    expect(
      agentCopilotMutationParamSchemas.setDescription.safeParse({
        description: "First line\nSecond line",
      }).success,
    ).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setDescription.safeParse({
        description: "x".repeat(COPILOT_MAX_DESCRIPTION_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      agentCopilotMutationParamSchemas.setDescription.safeParse({ description: "" })
        .success,
    ).toBe(false);
  });

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
      agentCopilotMutationParamSchemas.setModel.safeParse({ reasoning: "ultra" }).success,
    ).toBe(false);
  });

  test("setModel accepts the widened effort vocabulary", () => {
    for (const reasoning of [
      "provider-default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      expect(
        agentCopilotMutationParamSchemas.setModel.safeParse({ reasoning }).success,
      ).toBe(true);
    }
  });

  test("setModel treats reasoning: null as the explicit inherit edit", () => {
    // null !== undefined, so clearing the override still satisfies the
    // at-least-one-field refine — an empty {} does not.
    const parsed = agentCopilotMutationParamSchemas.setModel.parse({
      reasoning: null,
    });
    expect(parsed.reasoning).toBeNull();
    expect(agentCopilotMutationParamSchemas.setModel.safeParse({}).success).toBe(false);
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

  test("agent surface exposes exactly its six mutations", () => {
    expect([...AGENT_COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addContext",
      "removeContext",
      "setDescription",
      "setModel",
      "setName",
      "setPersona",
    ]);
  });

  test("the combined registry is the disjoint union of both surfaces", () => {
    expect([...COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addContext",
      "removeContext",
      "setAgent",
      "setDescription",
      "setInstructions",
      "setModel",
      "setName",
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

  test("allow-edits rides the user_message and defaults to the accept gate", () => {
    const gated = copilotClientFrameSchema.parse({
      type: "user_message",
      surface: "agent",
      entityId: UUID,
      draft: {},
      message: "rename it",
    });
    // Omitted → undefined, which the server must read as "gate the mutations".
    expect(gated).toMatchObject({ type: "user_message" });
    expect((gated as { allowEdits?: boolean }).allowEdits).toBeUndefined();

    const open = copilotClientFrameSchema.safeParse({
      type: "user_message",
      surface: "agent",
      entityId: UUID,
      draft: {},
      message: "rename it",
      allowEdits: true,
    });
    expect(open.success).toBe(true);
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: {},
        message: "rename it",
        allowEdits: "yes",
      }).success,
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

  test("thought frames carry cumulative text under a stable key", () => {
    expect(
      copilotServerFrameSchema.safeParse({
        type: "thought",
        key: "step:0",
        text: "The draft has no trigger yet",
        streaming: true,
      }).success,
    ).toBe(true);
    // A sealed block still parses; only the key is mandatory-non-empty.
    expect(
      copilotServerFrameSchema.safeParse({
        type: "thought",
        key: "step:0",
        text: "",
        streaming: false,
      }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({
        type: "thought",
        key: "",
        text: "x",
        streaming: true,
      }).success,
    ).toBe(false);
  });

  test("step frames use the chat rail's state vocabulary", () => {
    expect(
      copilotServerFrameSchema.safeParse({
        type: "step",
        key: "call_9",
        toolName: "listConnections",
        state: "pending",
        resultPreview: null,
      }).success,
    ).toBe(true);
    expect(
      copilotServerFrameSchema.safeParse({
        type: "step",
        key: "call_9",
        toolName: "listConnections",
        state: "ok",
        resultPreview: "4 connections",
      }).success,
    ).toBe(true);
    // `awaiting`/`rejected`/`canceled` have no copilot analogue on the wire.
    expect(
      copilotServerFrameSchema.safeParse({
        type: "step",
        key: "call_9",
        toolName: "listConnections",
        state: "awaiting",
        resultPreview: null,
      }).success,
    ).toBe(false);
  });

  test("a proposal frame marks the auto-applied (allow-edits) case", () => {
    const parsed = copilotServerFrameSchema.parse({
      type: "proposal",
      proposal: {
        id: "call_3",
        tool: "setDescription",
        params: { description: "Triages inbound support email." },
        rationale: "the agent had none",
      },
      autoApplied: true,
    });
    expect(parsed).toMatchObject({ type: "proposal", autoApplied: true });
    // Absent = the accept gate applied; the flag is opt-in, never inferred.
    const gated = copilotServerFrameSchema.parse({
      type: "proposal",
      proposal: {
        id: "call_4",
        tool: "setName",
        params: { name: "Support triage" },
        rationale: "clearer than Untitled agent",
      },
    });
    expect((gated as { autoApplied?: boolean }).autoApplied).toBeUndefined();
  });
});

describe("parse helpers", () => {
  test("parseCopilotServerFrame round-trips valid frames and nulls invalid ones", () => {
    expect(
      parseCopilotServerFrame(JSON.stringify({ type: "delta", text: "hi" })),
    ).toEqual({ type: "delta", text: "hi" });
    // Every arm of the union survives the helper — a frame the server can
    // emit but the helper drops would silently blank the dock's rail.
    const frames: CopilotServerFrame[] = [
      { type: "delta", text: "hi" },
      { type: "thought", key: "step:1", text: "thinking", streaming: true },
      {
        type: "step",
        key: "call_1",
        toolName: "listAgents",
        state: "ok",
        resultPreview: "2 items",
      },
      {
        type: "proposal",
        proposal: {
          id: "call_2",
          tool: "setName",
          params: { name: "Support triage" },
          rationale: "clearer",
        },
        autoApplied: true,
      },
      { type: "done", reason: "completed" },
      { type: "error", code: "llm_error", message: "upstream" },
    ];
    for (const frame of frames) {
      expect(parseCopilotServerFrame(JSON.stringify(frame))).toEqual(frame);
    }
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
