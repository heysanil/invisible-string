import { describe, expect, test } from "bun:test";

import {
  AGENT_COPILOT_MUTATION_TOOLS,
  COPILOT_MAX_DESCRIPTION_CHARS,
  COPILOT_MAX_IDENTITY_NAME_CHARS,
  COPILOT_MUTATION_TOOLS,
  WORKFLOW_COPILOT_MUTATION_TOOLS,
  WORKFLOW_COPILOT_READ_TOOLS,
  agentCopilotMutationParamSchemas,
  copilotClientFrameSchema,
  copilotMutationParamSchemas,
  copilotProposalSchema,
  copilotServerFrameSchema,
  mintStepIds,
  parseCopilotClientFrame,
  parseCopilotServerFrame,
  stepPositionSchema,
  workflowCopilotReadParamSchemas,
  type CopilotAgentIdentity,
  type CopilotServerFrame,
} from "./copilot";
import { STEP_ID_PATTERN } from "./pipeline-config";

const UUID = "11111111-2222-4333-8444-555555555555";
const STEP_ID = "st_0000000000000001";
const STEP_ID_2 = "st_0000000000000002";

const toolStep = {
  id: STEP_ID,
  slug: "search",
  kind: "tool",
  connectionId: "cn_a1b2c3d4e5f6a7b8",
  tool: "slack_search",
  args: { query: { $tpl: "@team-exec after:@state.cursor" } },
} as const;

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

  test("addStep takes a full step + position and validates the step per kind", () => {
    expect(
      copilotMutationParamSchemas.addStep.safeParse({
        step: toolStep,
        position: { after: null },
      }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.addStep.safeParse({
        step: toolStep,
        position: {
          after: STEP_ID_2,
          parent: { stepId: STEP_ID_2, slot: "body" },
        },
      }).success,
    ).toBe(true);
    // Position is required — "wherever" is not a proposal a client can apply.
    expect(
      copilotMutationParamSchemas.addStep.safeParse({ step: toolStep }).success,
    ).toBe(false);
    // The step union still guards per-kind shape (unknown kind, malformed id).
    expect(
      copilotMutationParamSchemas.addStep.safeParse({
        step: { ...toolStep, kind: "shell" },
        position: { after: null },
      }).success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.addStep.safeParse({
        step: { ...toolStep, id: "step-1" },
        position: { after: null },
      }).success,
    ).toBe(false);
  });

  test("updateStep is whole-step replacement addressed by stepId", () => {
    expect(
      copilotMutationParamSchemas.updateStep.safeParse({
        stepId: STEP_ID,
        step: { ...toolStep, tool: "slack_search_messages" },
      }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.updateStep.safeParse({
        stepId: STEP_ID,
        step: { patch: { tool: "x" } },
      }).success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.updateStep.safeParse({ step: toolStep }).success,
    ).toBe(false);
  });

  test("removeStep/moveStep address existing steps by minted id", () => {
    expect(
      copilotMutationParamSchemas.removeStep.safeParse({ stepId: STEP_ID }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.removeStep.safeParse({ stepId: "search" }).success,
    ).toBe(false);
    expect(
      copilotMutationParamSchemas.moveStep.safeParse({
        stepId: STEP_ID,
        position: { after: STEP_ID_2 },
      }).success,
    ).toBe(true);
    expect(
      copilotMutationParamSchemas.moveStep.safeParse({ stepId: STEP_ID }).success,
    ).toBe(false);
  });

  test("stepPosition: after is nullable, parent slots are the walk vocabulary", () => {
    expect(stepPositionSchema.safeParse({ after: null }).success).toBe(true);
    expect(
      stepPositionSchema.safeParse({
        after: null,
        parent: { stepId: STEP_ID, slot: "then" },
      }).success,
    ).toBe(true);
    expect(
      stepPositionSchema.safeParse({
        after: STEP_ID,
        parent: { stepId: STEP_ID_2, slot: "else" },
      }).success,
    ).toBe(true);
    // No free-form slots, and `after` may not be omitted (null is explicit).
    expect(
      stepPositionSchema.safeParse({
        after: null,
        parent: { stepId: STEP_ID, slot: "lane-2" },
      }).success,
    ).toBe(false);
    expect(stepPositionSchema.safeParse({}).success).toBe(false);
  });
});

describe("workflow-surface read tools", () => {
  test("registry exposes exactly the two lookups", () => {
    expect([...WORKFLOW_COPILOT_READ_TOOLS].sort()).toEqual([
      "getConnectionTool",
      "searchConnectionTools",
    ]);
  });

  test("searchConnectionTools: query bounded; empty query browses a connection", () => {
    expect(
      workflowCopilotReadParamSchemas.searchConnectionTools.safeParse({
        query: "create issue",
      }).success,
    ).toBe(true);
    expect(
      workflowCopilotReadParamSchemas.searchConnectionTools.safeParse({
        query: "",
        connectionId: "cn_a1b2c3d4e5f6a7b8",
      }).success,
    ).toBe(true);
    expect(
      workflowCopilotReadParamSchemas.searchConnectionTools.safeParse({
        query: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      workflowCopilotReadParamSchemas.searchConnectionTools.safeParse({}).success,
    ).toBe(false);
  });

  test("getConnectionTool requires both coordinates", () => {
    expect(
      workflowCopilotReadParamSchemas.getConnectionTool.safeParse({
        connectionId: UUID,
        toolName: "create_issue",
      }).success,
    ).toBe(true);
    expect(
      workflowCopilotReadParamSchemas.getConnectionTool.safeParse({
        connectionId: "cn_a1b2c3d4e5f6a7b8",
        toolName: "",
      }).success,
    ).toBe(false);
    expect(
      workflowCopilotReadParamSchemas.getConnectionTool.safeParse({
        toolName: "create_issue",
      }).success,
    ).toBe(false);
  });

  test("read tools never collide with mutation tool names", () => {
    for (const tool of WORKFLOW_COPILOT_READ_TOOLS) {
      expect(COPILOT_MUTATION_TOOLS).not.toContain(tool);
    }
  });
});

describe("mintStepIds", () => {
  test("mints missing/malformed ids and preserves valid ones", () => {
    const minted = mintStepIds({
      slug: "search",
      kind: "tool",
    }) as Record<string, unknown>;
    expect(minted.id).toMatch(STEP_ID_PATTERN);

    const kept = mintStepIds(toolStep) as Record<string, unknown>;
    expect(kept.id).toBe(STEP_ID);

    const repaired = mintStepIds({ ...toolStep, id: "step-1" }) as Record<
      string,
      unknown
    >;
    expect(repaired.id).toMatch(STEP_ID_PATTERN);
    expect(repaired.id).not.toBe("step-1");
  });

  test("walks for_each bodies and branch lanes, and re-mints duplicates", () => {
    const minted = mintStepIds({
      slug: "per-message",
      kind: "for_each",
      items: { $ref: "steps.search.result.messages" },
      steps: [
        { slug: "summarize", kind: "infer", prompt: { markdown: "x" } },
        // Duplicate of the OUTER id — must be re-minted, not kept.
        { ...toolStep, slug: "file" },
      ],
      id: STEP_ID,
    }) as {
      id: string;
      steps: { id: string }[];
    };
    expect(minted.id).toBe(STEP_ID);
    expect(minted.steps[0]?.id).toMatch(STEP_ID_PATTERN);
    expect(minted.steps[1]?.id).toMatch(STEP_ID_PATTERN);
    expect(minted.steps[1]?.id).not.toBe(STEP_ID);

    const branch = mintStepIds({
      slug: "route",
      kind: "branch",
      branches: [
        {
          when: { truthy: { $ref: "trigger.urgent" } },
          steps: [{ slug: "page", kind: "tool" }],
        },
      ],
      else: [{ slug: "log", kind: "state", set: {} }],
    }) as {
      id: string;
      branches: { steps: { id: string }[] }[];
      else: { id: string }[];
    };
    expect(branch.id).toMatch(STEP_ID_PATTERN);
    expect(branch.branches[0]?.steps[0]?.id).toMatch(STEP_ID_PATTERN);
    expect(branch.else[0]?.id).toMatch(STEP_ID_PATTERN);
  });

  test("re-mints ids already taken by the caller's seen set", () => {
    const minted = mintStepIds(toolStep, new Set([STEP_ID])) as Record<
      string,
      unknown
    >;
    expect(minted.id).toMatch(STEP_ID_PATTERN);
    expect(minted.id).not.toBe(STEP_ID);
  });

  test("does not touch non-step values or unknown keys", () => {
    expect(mintStepIds("hello")).toBe("hello");
    expect(mintStepIds(null)).toBeNull();
    const minted = mintStepIds({
      ...toolStep,
      args: { nested: { $ref: "steps.search.result" } },
    }) as { args: Record<string, unknown> };
    // args objects are NOT step nodes — no ids sprout inside them.
    expect(minted.args).toEqual({ nested: { $ref: "steps.search.result" } });
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
  test("workflow surface exposes setTrigger + the four granular step mutations", () => {
    expect([...WORKFLOW_COPILOT_MUTATION_TOOLS].sort()).toEqual([
      "addStep",
      "moveStep",
      "removeStep",
      "setTrigger",
      "updateStep",
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
      "addStep",
      "moveStep",
      "removeContext",
      "removeStep",
      "setDescription",
      "setModel",
      "setName",
      "setPersona",
      "setTrigger",
      "updateStep",
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

  test("step mutations ride the proposal union (recursive params included)", () => {
    expect(
      copilotProposalSchema.safeParse({
        id: "call_5",
        tool: "addStep",
        params: {
          step: {
            id: STEP_ID_2,
            slug: "per-message",
            kind: "for_each",
            items: { $ref: "steps.search.result.messages" },
            steps: [toolStep],
          },
          position: { after: null },
        },
        rationale: "loop over the search hits",
      }).success,
    ).toBe(true);
    // The memo-era tools are GONE — a stale server proposing one is a bug.
    expect(
      copilotProposalSchema.safeParse({
        id: "call_6",
        tool: "setInstructions",
        params: { markdown: "do the thing" },
        rationale: "",
      }).success,
    ).toBe(false);
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

  test("agent identity rides BESIDE the draft, typed and optional", () => {
    // The draft is an `AgentDefinition` and has no name/description, so the
    // frame carries the row's identity in its own field — without it the
    // server has no baseline for the agent it is editing.
    const withIdentity = copilotClientFrameSchema.safeParse({
      type: "user_message",
      surface: "agent",
      entityId: UUID,
      draft: { persona: "You are helpful." },
      identity: { name: "Support Agent", description: "Triages support." },
      message: "rename it",
    });
    expect(withIdentity.success).toBe(true);
    expect(
      withIdentity.success &&
        (withIdentity.data as { identity?: CopilotAgentIdentity }).identity,
    ).toEqual({ name: "Support Agent", description: "Triages support." });

    // No description is a real state, not missing data.
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: {},
        identity: { name: "Untitled agent", description: null },
        message: "describe it",
      }).success,
    ).toBe(true);

    // Optional: omitted → undefined (the server falls back to the row).
    const omitted = copilotClientFrameSchema.parse({
      type: "user_message",
      surface: "agent",
      entityId: UUID,
      draft: {},
      message: "hi",
    });
    expect((omitted as { identity?: unknown }).identity).toBeUndefined();

    // An EMPTY name is a legal mid-edit state — it must not fail the frame.
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: {},
        identity: { name: "", description: null },
        message: "hi",
      }).success,
    ).toBe(true);

    // Bounded (it is interpolated into the system prompt) and complete.
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: {},
        identity: {
          name: "x".repeat(COPILOT_MAX_IDENTITY_NAME_CHARS + 1),
          description: null,
        },
        message: "hi",
      }).success,
    ).toBe(false);
    expect(
      copilotClientFrameSchema.safeParse({
        type: "user_message",
        surface: "agent",
        entityId: UUID,
        draft: {},
        identity: { name: "Support Agent" },
        message: "hi",
      }).success,
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
    // The key is turn-scoped by convention (`turn:<n>:step:<i>`) because the
    // dock upserts by key globally — but the wire treats it as opaque.
    expect(
      copilotServerFrameSchema.safeParse({
        type: "thought",
        key: "turn:0:step:0",
        text: "The draft has no trigger yet",
        streaming: true,
      }).success,
    ).toBe(true);
    // A sealed block still parses; only the key is mandatory-non-empty.
    expect(
      copilotServerFrameSchema.safeParse({
        type: "thought",
        key: "turn:1:step:0",
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
