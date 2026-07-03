/**
 * Copilot mutation → builder-action mapping and card descriptions. Every
 * mutation kind must land on the SAME reducer path manual edits use.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@invisible-string/shared";

import { builderReducer, initBuilderState } from "../lib/builder/model";
import type { ContextResources } from "../lib/builder/resources";
import { describeMutation, mutationToAction } from "../lib/copilot/mutations";

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

describe("mutationToAction", () => {
  test("setTrigger replaces the whole trigger through the reducer", () => {
    const action = mutationToAction({
      kind: "setTrigger",
      trigger: {
        type: "slack",
        binding: { mentionOnly: true, includeDirectMessages: false },
      },
    });
    const next = builderReducer(initBuilderState(definition), action);
    expect(next.definition.trigger.type).toBe("slack");
    // Draft-preserving: previous manual trigger survives in triggerDrafts.
    expect(next.triggerDrafts.manual).toEqual({ type: "manual" });
  });

  test("addContext maps by kind", () => {
    expect(
      mutationToAction({ kind: "addContext", contextKind: "connection", id: "c" }),
    ).toEqual({ type: "addConnection", id: "c" });
    expect(
      mutationToAction({ kind: "addContext", contextKind: "skill", id: "s" }),
    ).toEqual({ type: "addSkill", id: "s" });
  });

  test("removeContext maps by kind", () => {
    expect(
      mutationToAction({
        kind: "removeContext",
        contextKind: "connection",
        id: "conn-1",
      }),
    ).toEqual({ type: "removeConnection", id: "conn-1" });
    expect(
      mutationToAction({ kind: "removeContext", contextKind: "skill", id: "s" }),
    ).toEqual({ type: "removeSkill", id: "s" });
  });

  test("setAgent / setModelPreset / setInstructions map onto existing actions", () => {
    expect(mutationToAction({ kind: "setAgent", agentPresetId: "x" })).toEqual({
      type: "setAgentPreset",
      id: "x",
    });
    expect(mutationToAction({ kind: "setModelPreset", preset: "quick" })).toEqual({
      type: "setModelPreset",
      preset: "quick",
    });
    expect(mutationToAction({ kind: "setModelPreset", preset: null })).toEqual({
      type: "setModelPreset",
      preset: undefined,
    });
    expect(
      mutationToAction({ kind: "setInstructions", markdown: "New" }),
    ).toEqual({ type: "setInstructions", markdown: "New" });
  });
});

describe("describeMutation", () => {
  test("setTrigger names the new trigger and shows before→after", () => {
    const d = describeMutation(
      {
        kind: "setTrigger",
        trigger: {
          type: "slack",
          binding: {
            mentionOnly: true,
            includeDirectMessages: false,
            channelId: "support",
          },
        },
      },
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
    const d = describeMutation(
      { kind: "addContext", contextKind: "skill", id: "skill-1" },
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toBe("Add skill: triage");
    expect(d.after).toContain("triage");
  });

  test("removeContext shows the shrinking count", () => {
    const d = describeMutation(
      { kind: "removeContext", contextKind: "connection", id: "conn-1" },
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toBe("Remove connection: zendesk");
    expect(d.after).toContain("0 sources");
  });

  test("setAgent resolves the preset name", () => {
    const d = describeMutation(
      { kind: "setAgent", agentPresetId: OTHER_PRESET_ID },
      definition,
      resources,
      agentPresets,
      [],
    );
    expect(d.title).toBe("Set agent: Support Agent");
    expect(d.before).toBe("General");
  });

  test("setInstructions defers preview to the diff view", () => {
    const d = describeMutation(
      { kind: "setInstructions", markdown: "New" },
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
