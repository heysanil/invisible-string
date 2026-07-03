/**
 * Editor reducer round-trips: definition → UI state → definition is lossless,
 * and every action produces a shape-valid WorkflowDefinition (parses against
 * the shared schema the API PATCH validates against).
 */
import { expect, test } from "bun:test";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import {
  builderReducer,
  definitionOf,
  definitionsEqual,
  emptyDefinition,
  initBuilderState,
  type BuilderAction,
} from "../lib/builder/model";

const PRESET_A = "a1111111-1111-4111-8111-111111111111";
const PRESET_B = "b2222222-2222-4222-8222-222222222222";
const CONN_A = "c3333333-3333-4333-8333-333333333333";
const CONN_B = "c4444444-4444-4444-8444-444444444444";
const SKILL_A = "d5555555-5555-4555-8555-555555555555";

function assertValid(definition: WorkflowDefinition): void {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  expect(parsed.success).toBe(true);
}

function apply(
  definition: WorkflowDefinition,
  actions: BuilderAction[],
): WorkflowDefinition {
  let state = initBuilderState(definition);
  for (const action of actions) state = builderReducer(state, action);
  return definitionOf(state);
}

test("initBuilderState → definitionOf round-trips a full definition losslessly", () => {
  const definition: WorkflowDefinition = {
    trigger: {
      type: "form",
      fields: [
        { key: "email", label: "Email", type: "text", required: true },
        {
          key: "topic",
          label: "Topic",
          type: "select",
          required: false,
          options: ["bug", "idea"],
        },
      ],
    },
    context: { mcpConnectionIds: [CONN_A], skillIds: [SKILL_A] },
    agent: {
      agentPresetId: PRESET_A,
      modelPreset: "powerful",
      modelId: "anthropic/claude-sonnet-5",
      reasoning: "high",
    },
    instructions: { markdown: "Reply to @trigger.email using @skill.foo." },
  };

  const back = definitionOf(initBuilderState(definition));
  expect(back).toEqual(definition);
  expect(definitionsEqual(back, definition)).toBe(true);
});

test("switching trigger type and back restores the original config", () => {
  const start = emptyDefinition(PRESET_A);
  let state = initBuilderState(start);
  state = builderReducer(state, { type: "setTriggerType", triggerType: "form" });
  state = builderReducer(state, { type: "addFormField" });
  state = builderReducer(state, {
    type: "updateFormField",
    index: 0,
    patch: { key: "name", label: "Name" },
  });
  const formDefinition = definitionOf(state);
  expect(formDefinition.trigger.type).toBe("form");

  // Peek at webhook, then return to form: the designed fields survive.
  state = builderReducer(state, {
    type: "setTriggerType",
    triggerType: "webhook",
  });
  expect(definitionOf(state).trigger.type).toBe("webhook");
  state = builderReducer(state, { type: "setTriggerType", triggerType: "form" });
  expect(definitionOf(state).trigger).toEqual(formDefinition.trigger);
});

test("form field add / update / move / remove keep the definition valid", () => {
  const result = apply(emptyDefinition(PRESET_A), [
    { type: "setTriggerType", triggerType: "form" },
    { type: "addFormField" },
    { type: "updateFormField", index: 0, patch: { key: "a", label: "A" } },
    { type: "updateFormField", index: 1, patch: { key: "b", label: "B" } },
    { type: "moveFormField", index: 1, direction: -1 },
    { type: "removeFormField", index: 1 },
  ]);
  assertValid(result);
  if (result.trigger.type !== "form") throw new Error("expected form");
  expect(result.trigger.fields.map((f) => f.key)).toEqual(["b"]);
});

test("changing a field to select adds options; changing away drops them", () => {
  const toSelect = apply(emptyDefinition(PRESET_A), [
    { type: "setTriggerType", triggerType: "form" },
    { type: "updateFormField", index: 0, patch: { key: "k", label: "K" } },
    { type: "updateFormField", index: 0, patch: { type: "select" } },
  ]);
  if (toSelect.trigger.type !== "form") throw new Error("expected form");
  expect(toSelect.trigger.fields[0]!.options).toEqual([]);

  const backToText = apply(emptyDefinition(PRESET_A), [
    { type: "setTriggerType", triggerType: "form" },
    { type: "updateFormField", index: 0, patch: { key: "k", label: "K" } },
    { type: "updateFormField", index: 0, patch: { type: "select" } },
    {
      type: "updateFormField",
      index: 0,
      patch: { options: ["x", "y"] },
    },
    { type: "updateFormField", index: 0, patch: { type: "text" } },
  ]);
  if (backToText.trigger.type !== "form") throw new Error("expected form");
  expect("options" in backToText.trigger.fields[0]!).toBe(false);
});

test("slack binding: clearing the channel drops the key (any channel)", () => {
  const withChannel = apply(emptyDefinition(PRESET_A), [
    { type: "setTriggerType", triggerType: "slack" },
    { type: "setSlackBinding", patch: { channelId: "C123" } },
  ]);
  if (withChannel.trigger.type !== "slack") throw new Error("expected slack");
  expect(withChannel.trigger.binding.channelId).toBe("C123");

  const cleared = apply(emptyDefinition(PRESET_A), [
    { type: "setTriggerType", triggerType: "slack" },
    { type: "setSlackBinding", patch: { channelId: "C123" } },
    { type: "setSlackBinding", patch: { channelId: undefined } },
  ]);
  if (cleared.trigger.type !== "slack") throw new Error("expected slack");
  expect("channelId" in cleared.trigger.binding).toBe(false);
  assertValid(cleared);
});

test("context add/remove dedupes and preserves order; valid throughout", () => {
  const result = apply(emptyDefinition(PRESET_A), [
    { type: "addConnection", id: CONN_A },
    { type: "addConnection", id: CONN_B },
    { type: "addConnection", id: CONN_A }, // dupe ignored
    { type: "addSkill", id: SKILL_A },
    { type: "removeConnection", id: CONN_A },
  ]);
  assertValid(result);
  expect(result.context.mcpConnectionIds).toEqual([CONN_B]);
  expect(result.context.skillIds).toEqual([SKILL_A]);
});

test("agent overrides set then clear leave no undefined keys (round-trip clean)", () => {
  const set = apply(emptyDefinition(PRESET_A), [
    { type: "setAgentPreset", id: PRESET_B },
    { type: "setModelPreset", preset: "quick" },
    { type: "setModelId", modelId: "anthropic/claude-sonnet-5" },
    { type: "setReasoning", reasoning: "low" },
  ]);
  assertValid(set);
  expect(set.agent).toEqual({
    agentPresetId: PRESET_B,
    modelPreset: "quick",
    modelId: "anthropic/claude-sonnet-5",
    reasoning: "low",
  });

  const cleared = apply(emptyDefinition(PRESET_A), [
    { type: "setModelPreset", preset: "quick" },
    { type: "setModelId", modelId: "anthropic/claude-sonnet-5" },
    { type: "setReasoning", reasoning: "low" },
    { type: "setModelPreset", preset: undefined },
    { type: "setModelId", modelId: undefined },
    { type: "setReasoning", reasoning: undefined },
  ]);
  // Cleared overrides must be ABSENT, not `undefined` — round-trips through
  // JSON identically to a fresh definition.
  expect(cleared.agent).toEqual({ agentPresetId: PRESET_A });
  expect(JSON.stringify(cleared.agent)).toBe(
    JSON.stringify({ agentPresetId: PRESET_A }),
  );
});

test("instructions edits persist verbatim", () => {
  const result = apply(emptyDefinition(PRESET_A), [
    { type: "setInstructions", markdown: "Line one\nLine two @trigger.x" },
  ]);
  expect(result.instructions.markdown).toBe("Line one\nLine two @trigger.x");
});
