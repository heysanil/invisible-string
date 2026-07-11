/**
 * Agent-surface copilot adapter: proposal → agent-editor-action mapping,
 * card descriptions (DiffView-style persona previews), and the adapter
 * factory. Every proposal tool must land on the SAME reducer paths manual
 * edits take.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDefinition, CopilotProposal } from "@invisible-string/shared";

import type { AgentEditorAction } from "../lib/agents/model";
import type { ContextResources } from "../lib/builder/resources";
import {
  agentCopilotAdapter,
  agentProposalToActions,
  agentSectionOfProposal,
  describeAgentProposal,
  isAgentProposal,
} from "../lib/copilot/agent-mutations";

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";
const CONN_ID = "c3333333-3333-4333-8333-333333333333";
const SKILL_ID = "d5555555-5555-4555-8555-555555555555";

const definition: AgentDefinition = {
  persona: "You are a careful assistant.",
  model: { preset: "balanced", reasoning: "medium" },
  context: { mcpConnectionIds: [CONN_ID], skillIds: [] },
};

const resources = {
  connections: [],
  skills: [],
  connectionById: new Map([[CONN_ID, { id: CONN_ID, name: "linear" }]]),
  skillById: new Map([[SKILL_ID, { id: SKILL_ID, name: "triage" }]]),
  isPending: false,
  isError: false,
} as unknown as ContextResources;

function proposal<T extends CopilotProposal["tool"]>(
  tool: T,
  params: Extract<CopilotProposal, { tool: T }>["params"],
): CopilotProposal {
  return { id: "p-1", tool, params, rationale: "" } as CopilotProposal;
}

function asAgentProposal(p: CopilotProposal) {
  if (!isAgentProposal(p)) throw new Error("expected agent proposal");
  return p;
}

describe("agentProposalToActions", () => {
  test("setPersona maps onto the persona action", () => {
    expect(
      agentProposalToActions(
        asAgentProposal(proposal("setPersona", { markdown: "New persona" })),
      ),
    ).toEqual([{ type: "setPersona", markdown: "New persona" }]);
  });

  test("setModel fans out to one action per provided field", () => {
    expect(
      agentProposalToActions(
        asAgentProposal(proposal("setModel", { preset: "powerful" })),
      ),
    ).toEqual([{ type: "setModelPreset", preset: "powerful" }]);
    expect(
      agentProposalToActions(
        asAgentProposal(
          proposal("setModel", {
            preset: "quick",
            modelId: "anthropic/claude-sonnet-5",
            reasoning: "high",
          }),
        ),
      ),
    ).toEqual([
      { type: "setModelPreset", preset: "quick" },
      { type: "setModelId", modelId: "anthropic/claude-sonnet-5" },
      { type: "setReasoning", reasoning: "high" },
    ]);
  });

  test("addContext / removeContext map by kind", () => {
    expect(
      agentProposalToActions(
        asAgentProposal(proposal("addContext", { kind: "connection", id: CONN_ID })),
      ),
    ).toEqual([{ type: "addConnection", id: CONN_ID }]);
    expect(
      agentProposalToActions(
        asAgentProposal(proposal("addContext", { kind: "skill", id: SKILL_ID })),
      ),
    ).toEqual([{ type: "addSkill", id: SKILL_ID }]);
    expect(
      agentProposalToActions(
        asAgentProposal(
          proposal("removeContext", { kind: "connection", id: CONN_ID }),
        ),
      ),
    ).toEqual([{ type: "removeConnection", id: CONN_ID }]);
    expect(
      agentProposalToActions(
        asAgentProposal(proposal("removeContext", { kind: "skill", id: SKILL_ID })),
      ),
    ).toEqual([{ type: "removeSkill", id: SKILL_ID }]);
  });

  test("agentSectionOfProposal routes every tool to its editor section", () => {
    expect(
      agentSectionOfProposal(asAgentProposal(proposal("setPersona", { markdown: "x" }))),
    ).toBe("persona");
    expect(
      agentSectionOfProposal(asAgentProposal(proposal("setModel", { reasoning: "low" }))),
    ).toBe("model");
    expect(
      agentSectionOfProposal(
        asAgentProposal(proposal("addContext", { kind: "skill", id: SKILL_ID })),
      ),
    ).toBe("context");
    expect(
      agentSectionOfProposal(
        asAgentProposal(proposal("removeContext", { kind: "connection", id: CONN_ID })),
      ),
    ).toBe("context");
  });

  test("isAgentProposal rejects workflow-surface tools", () => {
    expect(
      isAgentProposal(proposal("setInstructions", { markdown: "x" })),
    ).toBe(false);
    expect(
      isAgentProposal(proposal("setAgent", { agentId: AGENT_ID })),
    ).toBe(false);
  });
});

describe("describeAgentProposal", () => {
  test("setPersona previews as a full diff (DiffView contract)", () => {
    const d = describeAgentProposal(
      asAgentProposal(proposal("setPersona", { markdown: "New persona" })),
      definition,
      resources,
    );
    expect(d.title).toBe("Rewrite persona");
    expect(d.before).toBeNull();
    expect(d.after).toBeNull();
    expect(d.diff).toEqual({
      before: "You are a careful assistant.",
      after: "New persona",
    });

    const empty = describeAgentProposal(
      asAgentProposal(proposal("setPersona", { markdown: "New persona" })),
      { ...definition, persona: "  " },
      resources,
    );
    expect(empty.title).toBe("Write persona");
  });

  test("setModel shows the resolved before-line and the changed parts", () => {
    const d = describeAgentProposal(
      asAgentProposal(proposal("setModel", { preset: "powerful", reasoning: "high" })),
      definition,
      resources,
    );
    expect(d.title).toBe("Set model: preset powerful · reasoning high");
    expect(d.before).toBe("balanced · reasoning medium");
    expect(d.after).toBe("preset powerful · reasoning high");
  });

  test("setModel before-line surfaces an existing override", () => {
    const withOverride: AgentDefinition = {
      ...definition,
      model: {
        preset: "balanced",
        modelId: "anthropic/claude-sonnet-5",
        reasoning: "medium",
      },
    };
    const d = describeAgentProposal(
      asAgentProposal(proposal("setModel", { reasoning: "low" })),
      withOverride,
      resources,
    );
    expect(d.before).toBe("override → claude-sonnet-5 · reasoning medium");
    expect(d.after).toBe("reasoning low");
  });

  test("addContext resolves the resource name and grows the count", () => {
    const d = describeAgentProposal(
      asAgentProposal(proposal("addContext", { kind: "skill", id: SKILL_ID })),
      definition,
      resources,
    );
    expect(d.title).toBe("Add skill: triage");
    expect(d.before).toBe("1 source");
    expect(d.after).toContain("2 sources");
    expect(d.after).toContain("triage");
  });

  test("removeContext shows the shrinking count", () => {
    const d = describeAgentProposal(
      asAgentProposal(
        proposal("removeContext", { kind: "connection", id: CONN_ID }),
      ),
      definition,
      resources,
    );
    expect(d.title).toBe("Remove connection: linear");
    expect(d.after).toContain("0 sources");
  });
});

describe("agentCopilotAdapter", () => {
  function makeAdapter(draft: AgentDefinition = definition) {
    const dispatched: AgentEditorAction[] = [];
    const applied: string[] = [];
    const adapter = agentCopilotAdapter({
      agentId: AGENT_ID,
      getDraft: () => draft,
      dispatch: (action) => dispatched.push(action),
      resources,
      onApplied: (section) => applied.push(section),
    });
    return { adapter, dispatched, applied };
  }

  test("entityRef names the agent surface", () => {
    const { adapter } = makeAdapter();
    expect(adapter.entityRef).toEqual({ surface: "agent", entityId: AGENT_ID });
  });

  test("applyProposal dispatches reducer actions and reports the section", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(
      proposal("setModel", { preset: "quick", reasoning: "low" }),
    );
    expect(dispatched).toEqual([
      { type: "setModelPreset", preset: "quick" },
      { type: "setReasoning", reasoning: "low" },
    ]);
    expect(applied).toEqual(["model"]);
  });

  test("applyProposal ignores off-surface proposals (server bug)", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(proposal("setInstructions", { markdown: "x" }));
    expect(dispatched).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("promptChips scaffold on an untouched agent, refine once equipped", () => {
    const fresh = makeAdapter({
      persona: "",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });
    const equipped = makeAdapter();
    expect(fresh.adapter.promptChips().length).toBeGreaterThan(0);
    expect(equipped.adapter.promptChips()).not.toEqual(
      fresh.adapter.promptChips(),
    );
  });

  test("describeProposal falls back for off-surface tools", () => {
    const { adapter } = makeAdapter();
    const d = adapter.describeProposal(
      proposal("setTrigger", { trigger: { type: "manual" } }),
    );
    expect(d.title).toContain("setTrigger");
  });
});
