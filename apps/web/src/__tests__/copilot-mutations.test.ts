/**
 * Workflow-surface copilot adapter: proposal → builder-action mapping, card
 * descriptions, and the adapter factory. Every proposal tool must land on
 * the SAME reducer paths manual edits use.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentSummaryDto,
  CopilotProposal,
  WorkflowConfig,
} from "@invisible-string/shared";

import { builderReducer, initBuilderState, type BuilderAction } from "../lib/builder/model";
import {
  describeWorkflowProposal,
  isWorkflowProposal,
  proposalToActions,
  sectionOfProposal,
  unsupportedProposalDescription,
  workflowCopilotAdapter,
} from "../lib/copilot/mutations";

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "a2222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "wf-1";

const definition: WorkflowConfig = {
  trigger: { type: "manual" },
  agentId: AGENT_ID,
  instructions: { markdown: "Old instructions" },
};

function agentSummary(id: string, name: string): AgentSummaryDto {
  return {
    id,
    name,
    description: null,
    runAsUserId: "user-1",
    publishedVersionId: "v-1",
    publishedAt: "2026-07-01T00:00:00.000Z",
    buildStatus: "succeeded",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const agents = [
  agentSummary(AGENT_ID, "General assistant"),
  agentSummary(OTHER_AGENT_ID, "Support triager"),
];

function proposal<T extends CopilotProposal["tool"]>(
  tool: T,
  params: Extract<CopilotProposal, { tool: T }>["params"],
): CopilotProposal {
  return { id: "p-1", tool, params, rationale: "" } as CopilotProposal;
}

describe("proposalToActions", () => {
  test("setTrigger replaces the whole trigger through the reducer", () => {
    const p = proposal("setTrigger", {
      trigger: {
        type: "slack",
        binding: { mentionOnly: true, includeDirectMessages: false },
      },
    });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    const [action] = proposalToActions(p);
    const next = builderReducer(initBuilderState(definition), action!);
    expect(next.definition.trigger.type).toBe("slack");
    // Draft-preserving: previous manual trigger survives in triggerDrafts.
    expect(next.triggerDrafts.manual).toEqual({ type: "manual" });
  });

  test("setAgent maps onto setAgentId", () => {
    const p = proposal("setAgent", { agentId: OTHER_AGENT_ID });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    expect(proposalToActions(p)).toEqual([
      { type: "setAgentId", id: OTHER_AGENT_ID },
    ]);
    const next = builderReducer(
      initBuilderState(definition),
      proposalToActions(p)[0]!,
    );
    expect(next.definition.agentId).toBe(OTHER_AGENT_ID);
  });

  test("setInstructions maps onto the existing action", () => {
    const p = proposal("setInstructions", { markdown: "New" });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    expect(proposalToActions(p)).toEqual([
      { type: "setInstructions", markdown: "New" },
    ]);
  });

  test("sectionOfProposal routes every tool to its section", () => {
    const cases = [
      [proposal("setTrigger", { trigger: { type: "manual" } }), "trigger"],
      [proposal("setAgent", { agentId: AGENT_ID }), "agent"],
      [proposal("setInstructions", { markdown: "x" }), "instructions"],
    ] as const;
    for (const [p, section] of cases) {
      if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
      expect(sectionOfProposal(p)).toBe(section);
    }
  });

  test("isWorkflowProposal rejects agent-surface tools", () => {
    expect(isWorkflowProposal(proposal("setPersona", { markdown: "x" }))).toBe(
      false,
    );
    expect(
      isWorkflowProposal(
        proposal("addContext", { kind: "skill", id: AGENT_ID }),
      ),
    ).toBe(false);
  });
});

describe("describeWorkflowProposal", () => {
  test("setTrigger names the new trigger and shows before→after", () => {
    const p = proposal("setTrigger", {
      trigger: {
        type: "slack",
        binding: {
          mentionOnly: true,
          includeDirectMessages: false,
          channelId: "support",
        },
      },
    });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    const d = describeWorkflowProposal(p, definition, agents);
    expect(d.title).toContain("Slack");
    expect(d.title).toContain("#support");
    expect(d.before).toContain("Manual");
    expect(d.diff).toBeUndefined();
  });

  test("setAgent resolves names from the inventory", () => {
    const p = proposal("setAgent", { agentId: OTHER_AGENT_ID });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    const d = describeWorkflowProposal(p, definition, agents);
    expect(d.title).toBe("Set agent: Support triager");
    expect(d.before).toBe("General assistant");
    expect(d.after).toBe("Support triager");
  });

  test("setAgent falls back to the raw id when the inventory misses", () => {
    const p = proposal("setAgent", { agentId: OTHER_AGENT_ID });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    const d = describeWorkflowProposal(p, { ...definition, agentId: null }, []);
    expect(d.title).toBe(`Set agent: ${OTHER_AGENT_ID}`);
    expect(d.before).toBe("No agent");
  });

  test("setInstructions defers preview to the diff", () => {
    const p = proposal("setInstructions", { markdown: "New" });
    if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
    const d = describeWorkflowProposal(p, definition, agents);
    expect(d.title).toBe("Rewrite instructions");
    expect(d.before).toBeNull();
    expect(d.diff).toEqual({ before: "Old instructions", after: "New" });

    const empty = describeWorkflowProposal(
      p,
      { ...definition, instructions: { markdown: "  " } },
      agents,
    );
    expect(empty.title).toBe("Write instructions");
  });

  test("off-surface proposals get the unsupported fallback", () => {
    const d = unsupportedProposalDescription(
      proposal("setPersona", { markdown: "x" }),
    );
    expect(d.title).toContain("setPersona");
    expect(d.before).toBeNull();
  });
});

describe("workflowCopilotAdapter", () => {
  function makeAdapter(draft: WorkflowConfig = definition) {
    const dispatched: BuilderAction[] = [];
    const applied: string[] = [];
    const adapter = workflowCopilotAdapter({
      workflowId: WORKFLOW_ID,
      getDraft: () => draft,
      dispatch: (action) => dispatched.push(action),
      agents,
      onApplied: (section) => applied.push(section),
    });
    return { adapter, dispatched, applied };
  }

  test("entityRef names the workflow surface", () => {
    const { adapter } = makeAdapter();
    expect(adapter.entityRef).toEqual({
      surface: "workflow",
      entityId: WORKFLOW_ID,
    });
  });

  test("applyProposal dispatches reducer actions and reports the section", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(proposal("setAgent", { agentId: OTHER_AGENT_ID }));
    expect(dispatched).toEqual([{ type: "setAgentId", id: OTHER_AGENT_ID }]);
    expect(applied).toEqual(["agent"]);
  });

  test("applyProposal ignores off-surface proposals (server bug)", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(proposal("setPersona", { markdown: "x" }));
    expect(dispatched).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("promptChips scaffold on an empty draft, refine once instructions exist", () => {
    const empty = makeAdapter({ ...definition, instructions: { markdown: "" } });
    expect(empty.adapter.promptChips().length).toBeGreaterThan(0);
    const refine = makeAdapter();
    expect(refine.adapter.promptChips()).not.toEqual(
      empty.adapter.promptChips(),
    );
  });

  test("describeProposal reads the LIVE draft via getDraft", () => {
    const { adapter } = makeAdapter();
    const d = adapter.describeProposal(
      proposal("setInstructions", { markdown: "New" }),
    );
    expect(d.diff?.before).toBe("Old instructions");
  });
});
