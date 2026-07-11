/**
 * Editor reducer round-trips: config → UI state → config is lossless, and
 * every action produces a shape-valid WorkflowConfig (parses against the
 * shared schema the API PATCH validates against).
 */
import { expect, test } from "bun:test";
import {
  workflowConfigSchema,
  type WorkflowConfig,
} from "@invisible-string/shared";

import {
  builderReducer,
  definitionOf,
  definitionsEqual,
  emptyDefinition,
  initBuilderState,
  type BuilderAction,
} from "../lib/builder/model";

const AGENT_A = "a1111111-1111-4111-8111-111111111111";
const AGENT_B = "b2222222-2222-4222-8222-222222222222";

function assertValid(definition: WorkflowConfig): void {
  const parsed = workflowConfigSchema.safeParse(definition);
  expect(parsed.success).toBe(true);
}

function apply(
  definition: WorkflowConfig,
  actions: BuilderAction[],
): WorkflowConfig {
  let state = initBuilderState(definition);
  for (const action of actions) state = builderReducer(state, action);
  return definitionOf(state);
}

test("initBuilderState → definitionOf round-trips a full config losslessly", () => {
  const definition: WorkflowConfig = {
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
    agentId: AGENT_A,
    instructions: { markdown: "Reply to @trigger.email using @skill.foo." },
  };

  const back = definitionOf(initBuilderState(definition));
  expect(back).toEqual(definition);
  expect(definitionsEqual(back, definition)).toBe(true);
});

test("emptyDefinition is shape-valid with and without an agent", () => {
  assertValid(emptyDefinition(AGENT_A));
  assertValid(emptyDefinition(null));
  expect(emptyDefinition(null).agentId).toBeNull();
  expect(emptyDefinition(AGENT_A).agentId).toBe(AGENT_A);
});

test("switching trigger type and back restores the original config", () => {
  const start = emptyDefinition(AGENT_A);
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

test("form field add / update / move / remove keep the config valid", () => {
  const result = apply(emptyDefinition(AGENT_A), [
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
  const toSelect = apply(emptyDefinition(AGENT_A), [
    { type: "setTriggerType", triggerType: "form" },
    { type: "updateFormField", index: 0, patch: { key: "k", label: "K" } },
    { type: "updateFormField", index: 0, patch: { type: "select" } },
  ]);
  if (toSelect.trigger.type !== "form") throw new Error("expected form");
  expect(toSelect.trigger.fields[0]!.options).toEqual([]);

  const backToText = apply(emptyDefinition(AGENT_A), [
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
  const withChannel = apply(emptyDefinition(AGENT_A), [
    { type: "setTriggerType", triggerType: "slack" },
    { type: "setSlackBinding", patch: { channelId: "C123" } },
  ]);
  if (withChannel.trigger.type !== "slack") throw new Error("expected slack");
  expect(withChannel.trigger.binding.channelId).toBe("C123");

  const cleared = apply(emptyDefinition(AGENT_A), [
    { type: "setTriggerType", triggerType: "slack" },
    { type: "setSlackBinding", patch: { channelId: "C123" } },
    { type: "setSlackBinding", patch: { channelId: undefined } },
  ]);
  if (cleared.trigger.type !== "slack") throw new Error("expected slack");
  expect("channelId" in cleared.trigger.binding).toBe(false);
  assertValid(cleared);
});

test("setAgentId repoints (and can clear) the delegation", () => {
  const repointed = apply(emptyDefinition(AGENT_A), [
    { type: "setAgentId", id: AGENT_B },
  ]);
  assertValid(repointed);
  expect(repointed.agentId).toBe(AGENT_B);

  const cleared = apply(emptyDefinition(AGENT_A), [
    { type: "setAgentId", id: null },
  ]);
  assertValid(cleared);
  expect(cleared.agentId).toBeNull();
});

test("setAgentId leaves trigger drafts and instructions untouched", () => {
  let state = initBuilderState(emptyDefinition(null));
  state = builderReducer(state, { type: "setTriggerType", triggerType: "form" });
  state = builderReducer(state, {
    type: "updateFormField",
    index: 0,
    patch: { key: "email", label: "Email" },
  });
  state = builderReducer(state, {
    type: "setInstructions",
    markdown: "Handle @trigger.email",
  });
  const before = definitionOf(state);
  state = builderReducer(state, { type: "setAgentId", id: AGENT_A });
  const after = definitionOf(state);
  expect(after.trigger).toEqual(before.trigger);
  expect(after.instructions).toEqual(before.instructions);
  expect(after.agentId).toBe(AGENT_A);
});

test("instructions edits persist verbatim", () => {
  const result = apply(emptyDefinition(AGENT_A), [
    { type: "setInstructions", markdown: "Line one\nLine two @trigger.x" },
  ]);
  expect(result.instructions.markdown).toBe("Line one\nLine two @trigger.x");
});
