/**
 * Copilot proposal → builder-action mapping and card descriptions. Every
 * proposal tool must land on the SAME reducer paths manual edits use.
 */
import { describe, expect, test } from "bun:test";
import type { CopilotProposal, WorkflowDefinition } from "@invisible-string/shared";

import { builderReducer, initBuilderState } from "../lib/builder/model";
import type { ContextResources } from "../lib/builder/resources";
import {
  describeProposal,
  pillarOfProposal,
  proposalToActions,
} from "../lib/copilot/mutations";

const PRESET_ID = "a1111111-1111-4111-8111-111111111111";
const OTHER_PRESET_ID = "a2222222-2222-4222-8222-222222222222";

const definition: WorkflowDefinition = {
  trigger: { type: "manual" },
  context: { mcpConnectionIds: ["conn-1"], skillIds: [] },
  agent: { agentPresetId: PRESET_ID },
  instructions: { markdown: "Old instructions" },
};

const resources = {
  connections: [],
  skills: [],
  connectionById: new Map([["conn-1", { id: "conn-1", name: "zendesk" }]]),
  skillById: new Map([["skill-1", { id: "skill-1", name: "triage" }]]),
  isPending: false,
  isError: false,
} as unknown as ContextResources;

const agentPresets = [
  { id: PRESET_ID, name: "General" },
  { id: OTHER_PRESET_ID, name: "Support Agent" },
] as never[];

function proposal<T extends CopilotProposal["tool"]>(
  tool: T,
  params: Extract<CopilotProposal, { tool: T }>["params"],
): CopilotProposal {
  return { id: "p-1", tool, params, rationale: "" } as CopilotProposal;
}

describe("proposalToActions", () => {
  test("setTrigger replaces the whole trigger through the reducer", () => {
    const [action] = proposalToActions(
      proposal("setTrigger", {
        trigger: {
          type: "slack",
          binding: { mentionOnly: true, includeDirectMessages: false },
        },
      }),
    );
    const next = builderReducer(initBuilderState(definition), action!);
    expect(next.definition.trigger.type).toBe("slack");
    // Draft-preserving: previous manual trigger survives in triggerDrafts.
    expect(next.triggerDrafts.manual).toEqual({ type: "manual" });
  });

  test("addContext maps by kind", () => {
    expect(
      proposalToActions(proposal("addContext", { kind: "connection", id: "c" })),
    ).toEqual([{ type: "addConnection", id: "c" }]);
    expect(
      proposalToActions(proposal("addContext", { kind: "skill", id: "s" })),
    ).toEqual([{ type: "addSkill", id: "s" }]);
  });

  test("removeContext maps by kind", () => {
    expect(
      proposalToActions(
        proposal("removeContext", { kind: "connection", id: "conn-1" }),
      ),
    ).toEqual([{ type: "removeConnection", id: "conn-1" }]);
    expect(
      proposalToActions(proposal("removeContext", { kind: "skill", id: "s" })),
    ).toEqual([{ type: "removeSkill", id: "s" }]);
  });

  test("setAgent fans out to one action per provided field", () => {
    expect(proposalToActions(proposal("setAgent", { agentPresetId: "x" }))).toEqual([
      { type: "setAgentPreset", id: "x" },
    ]);
    expect(
      proposalToActions(
        proposal("setAgent", {
          agentPresetId: "x",
          reasoning: "high",
          modelId: "anthropic/claude-sonnet-5",
        }),
      ),
    ).toEqual([
      { type: "setAgentPreset", id: "x" },
      { type: "setReasoning", reasoning: "high" },
      { type: "setModelId", modelId: "anthropic/claude-sonnet-5" },
    ]);
  });

  test("setModelPreset / setInstructions map onto existing actions", () => {
    expect(proposalToActions(proposal("setModelPreset", { slug: "quick" }))).toEqual([
      { type: "setModelPreset", preset: "quick" },
    ]);
    expect(
      proposalToActions(proposal("setInstructions", { markdown: "New" })),
    ).toEqual([{ type: "setInstructions", markdown: "New" }]);
  });

  test("pillarOfProposal routes every tool to its pillar", () => {
    expect(pillarOfProposal(proposal("setTrigger", { trigger: { type: "manual" } }))).toBe(
      "trigger",
    );
    expect(
      pillarOfProposal(proposal("addContext", { kind: "skill", id: "s" })),
    ).toBe("context");
    expect(pillarOfProposal(proposal("setAgent", { reasoning: "low" }))).toBe("agent");
    expect(pillarOfProposal(proposal("setModelPreset", { slug: "quick" }))).toBe(
      "agent",
    );
    expect(
      pillarOfProposal(proposal("setInstructions", { markdown: "x" })),
    ).toBe("instructions");
  });
});

describe("describeProposal", () => {
  test("setTrigger names the new trigger and shows before→after", () => {
    const d = describeProposal(
      proposal("setTrigger", {
        trigger: {
          type: "slack",
          binding: {
            mentionOnly: true,
            includeDirectMessages: false,
            channelId: "support",
          },
        },
      }),
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.pillar).toBe("trigger");
    expect(d.title).toContain("Slack");
    expect(d.title).toContain("#support");
    expect(d.before).toContain("Manual");
  });

  test("addContext resolves the resource name", () => {
    const d = describeProposal(
      proposal("addContext", { kind: "skill", id: "skill-1" }),
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toBe("Add skill: triage");
    expect(d.after).toContain("triage");
  });

  test("removeContext shows the shrinking count", () => {
    const d = describeProposal(
      proposal("removeContext", { kind: "connection", id: "conn-1" }),
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toBe("Remove connection: zendesk");
    expect(d.after).toContain("0 sources");
  });

  test("setAgent resolves the preset name and includes extra fields", () => {
    const d = describeProposal(
      proposal("setAgent", { agentPresetId: OTHER_PRESET_ID, reasoning: "high" }),
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toContain("Set agent: Support Agent");
    expect(d.title).toContain("reasoning high");
    expect(d.before).toContain("General");
  });

  test("setInstructions defers preview to the diff view", () => {
    const d = describeProposal(
      proposal("setInstructions", { markdown: "New" }),
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.pillar).toBe("instructions");
    expect(d.title).toBe("Rewrite instructions");
    expect(d.before).toBeNull();
  });
});
