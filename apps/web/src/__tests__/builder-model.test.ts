/**
 * Editor reducer round-trips: config → UI state → config is lossless, every
 * action produces a shape-valid v2 WorkflowConfig (parses against the shared
 * schema the API PATCH validates against), and the step actions accept the
 * copilot mutation param shapes VERBATIM (an accepted proposal dispatches
 * with no translation).
 */
import { expect, test } from "bun:test";
import {
  newStepId,
  workflowConfigSchema,
  type AddStepParams,
  type MoveStepParams,
  type PipelineStep,
  type WorkflowConfig,
} from "@invisible-string/shared";

import {
  builderReducer,
  definitionOf,
  definitionsEqual,
  defaultStepSlug,
  emptyDefinition,
  initBuilderState,
  insertStepAt,
  newStep,
  removeStepFromTree,
  type BuilderAction,
} from "../lib/builder/model";

const AGENT_A = "a1111111-1111-4111-8111-111111111111";

function assertValid(definition: WorkflowConfig): void {
  const parsed = workflowConfigSchema.safeParse(definition);
  if (!parsed.success) {
    throw new Error(`expected a valid config: ${parsed.error.message}`);
  }
}

function apply(
  definition: WorkflowConfig,
  actions: BuilderAction[],
): WorkflowConfig {
  let state = initBuilderState(definition);
  for (const action of actions) state = builderReducer(state, action);
  return definitionOf(state);
}

function toolStep(slug: string): PipelineStep {
  return {
    id: newStepId(),
    slug,
    kind: "tool",
    connectionId: "cn_aaaaaaaaaaaaaa",
    tool: "search",
    args: { query: { $tpl: "@trigger.topic" } },
    sideEffect: "at_least_once",
  };
}

function inferStep(slug: string): PipelineStep {
  return {
    id: newStepId(),
    slug,
    kind: "infer",
    preset: "quick",
    prompt: { markdown: "Summarize @steps.search.text" },
  };
}

function forEachStep(slug: string, body: PipelineStep[]): PipelineStep {
  return {
    id: newStepId(),
    slug,
    kind: "for_each",
    items: { $ref: "steps.search.result.messages" },
    steps: body,
    maxItems: 100,
    onItemError: "halt",
  };
}

function branchStep(
  slug: string,
  lanes: PipelineStep[][],
  elseSteps?: PipelineStep[],
): PipelineStep {
  return {
    id: newStepId(),
    slug,
    kind: "branch",
    branches: lanes.map((steps) => ({
      when: { truthy: { $ref: "steps.search.result" } },
      steps,
    })),
    ...(elseSteps ? { else: elseSteps } : {}),
  };
}

function ids(steps: readonly PipelineStep[]): string[] {
  return steps.map((step) => step.id);
}

// ── round trips ─────────────────────────────────────────────────────────────

test("initBuilderState → definitionOf round-trips a full v2 config losslessly", () => {
  const search = toolStep("search");
  const loop = forEachStep("per-message", [inferStep("summarize")]);
  const definition: WorkflowConfig = {
    version: 2,
    trigger: { type: "schedule", cron: "*/20 * * * *" },
    steps: [search, loop],
    onComplete: { slackReply: { template: { markdown: "Done: @steps.search.text" } } },
    overlap: "skip",
  };

  const back = definitionOf(initBuilderState(definition));
  expect(back).toEqual(definition);
  expect(definitionsEqual(back, definition)).toBe(true);
  assertValid(definition);
});

test("emptyDefinition is a shape-valid stepless v2 draft", () => {
  const definition = emptyDefinition();
  assertValid(definition);
  expect(definition.version).toBe(2);
  expect(definition.steps).toEqual([]);
  expect(definition.overlap).toBe("skip");
});

test("newStep mints every kind shape-valid with a unique default slug", () => {
  let steps: PipelineStep[] = [];
  for (const kind of [
    "tool",
    "infer",
    "agent",
    "for_each",
    "branch",
    "filter",
    "state",
  ] as const) {
    steps = [...steps, newStep(kind, steps)];
    steps = [...steps, newStep(kind, steps)];
  }
  assertValid({ ...emptyDefinition(), steps });
  const slugs = steps.map((step) => step.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  // Second tool slug avoided the first's.
  expect(defaultStepSlug("tool", steps)).toBe("tool-3");
});

// ── trigger editing (unchanged semantics) ───────────────────────────────────

test("switching trigger type and back restores the original config", () => {
  let state = initBuilderState(emptyDefinition());
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
  const result = apply(emptyDefinition(), [
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

test("slack binding: clearing the channel drops the key (any channel)", () => {
  const cleared = apply(emptyDefinition(), [
    { type: "setTriggerType", triggerType: "slack" },
    { type: "setSlackBinding", patch: { channelId: "C123" } },
    { type: "setSlackBinding", patch: { channelId: undefined } },
  ]);
  if (cleared.trigger.type !== "slack") throw new Error("expected slack");
  expect("channelId" in cleared.trigger.binding).toBe(false);
  assertValid(cleared);
});

// ── step actions (copilot param shapes verbatim) ────────────────────────────

test("addStep at the head, after a sibling, and the payload IS AddStepParams", () => {
  const first = toolStep("search");
  const second = inferStep("summarize");

  // The exact copilot param shape spreads into the action — no translation.
  const params: AddStepParams = { step: first, position: { after: null } };
  let state = initBuilderState(emptyDefinition());
  state = builderReducer(state, { type: "addStep", ...params });
  state = builderReducer(state, {
    type: "addStep",
    step: second,
    position: { after: first.id },
  });

  const definition = definitionOf(state);
  assertValid(definition);
  expect(ids(definition.steps)).toEqual([first.id, second.id]);
});

test("addStep into a for_each body and a branch lane/else", () => {
  const loop = forEachStep("loop", []);
  const fork = branchStep("fork", [[]]);
  const intoBody = inferStep("summarize");
  const intoLane = toolStep("create");
  const intoElse = toolStep("fallback");

  const definition = apply(emptyDefinition(), [
    { type: "addStep", step: loop, position: { after: null } },
    { type: "addStep", step: fork, position: { after: loop.id } },
    {
      type: "addStep",
      step: intoBody,
      position: { after: null, parent: { stepId: loop.id, slot: "body" } },
    },
    {
      type: "addStep",
      step: intoLane,
      position: { after: null, parent: { stepId: fork.id, slot: "then" } },
    },
    {
      type: "addStep",
      step: intoElse,
      position: { after: null, parent: { stepId: fork.id, slot: "else" } },
    },
  ]);

  assertValid(definition);
  const loopAfter = definition.steps[0];
  const forkAfter = definition.steps[1];
  if (loopAfter?.kind !== "for_each" || forkAfter?.kind !== "branch") {
    throw new Error("expected loop then branch");
  }
  expect(ids(loopAfter.steps)).toEqual([intoBody.id]);
  expect(ids(forkAfter.branches[0]!.steps)).toEqual([intoLane.id]);
  // Targeting a missing else CREATES the list.
  expect(ids(forkAfter.else ?? [])).toEqual([intoElse.id]);
});

test("addStep no-ops (draft untouched) on an unresolvable position", () => {
  const search = toolStep("search");
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: search, position: { after: null } },
  ]);

  const ghost = inferStep("ghost");
  for (const position of [
    { after: newStepId() }, // unknown anchor
    { after: null, parent: { stepId: newStepId(), slot: "body" as const } }, // unknown parent
    { after: null, parent: { stepId: search.id, slot: "body" as const } }, // slot the kind lacks
  ]) {
    const next = apply(seeded, [{ type: "addStep", step: ghost, position }]);
    expect(next).toEqual(seeded);
  }
});

test("updateStep replaces in place and can never re-identify the step", () => {
  const search = toolStep("search");
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: search, position: { after: null } },
  ]);

  const base = toolStep("search-v2");
  if (base.kind !== "tool") throw new Error("expected tool");
  const replacement: PipelineStep = {
    ...base,
    id: newStepId(), // hostile: a replacement carrying a DIFFERENT id
    tool: "search_messages",
  };
  const next = apply(seeded, [
    { type: "updateStep", stepId: search.id, step: replacement },
  ]);
  assertValid(next);
  expect(next.steps).toHaveLength(1);
  expect(next.steps[0]!.id).toBe(search.id); // identity pinned
  expect(next.steps[0]!.slug).toBe("search-v2"); // slug rename allowed
});

test("removeStep deletes a nested subtree", () => {
  const inner = inferStep("summarize");
  const loop = forEachStep("loop", [inner]);
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: loop, position: { after: null } },
  ]);

  const withoutInner = apply(seeded, [{ type: "removeStep", stepId: inner.id }]);
  const loopAfter = withoutInner.steps[0];
  if (loopAfter?.kind !== "for_each") throw new Error("expected for_each");
  expect(loopAfter.steps).toEqual([]);

  const withoutLoop = apply(seeded, [{ type: "removeStep", stepId: loop.id }]);
  expect(withoutLoop.steps).toEqual([]);

  // Unknown id → untouched.
  expect(apply(seeded, [{ type: "removeStep", stepId: newStepId() }])).toEqual(
    seeded,
  );
});

test("moveStep relocates a subtree; the payload IS MoveStepParams", () => {
  const search = toolStep("search");
  const loop = forEachStep("loop", []);
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: search, position: { after: null } },
    { type: "addStep", step: loop, position: { after: search.id } },
  ]);

  const params: MoveStepParams = {
    stepId: search.id,
    position: { after: null, parent: { stepId: loop.id, slot: "body" } },
  };
  const next = apply(seeded, [{ type: "moveStep", ...params }]);
  assertValid(next);
  expect(ids(next.steps)).toEqual([loop.id]);
  const loopAfter = next.steps[0];
  if (loopAfter?.kind !== "for_each") throw new Error("expected for_each");
  expect(ids(loopAfter.steps)).toEqual([search.id]);
});

test("moveStep into its own subtree no-ops rather than orphaning the step", () => {
  const loop = forEachStep("loop", [inferStep("inner")]);
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: loop, position: { after: null } },
  ]);

  const next = apply(seeded, [
    {
      type: "moveStep",
      stepId: loop.id,
      position: { after: null, parent: { stepId: loop.id, slot: "body" } },
    },
  ]);
  expect(next).toEqual(seeded);
});

test("patchStepParams merges fields but pins id and kind", () => {
  const search = toolStep("search");
  const seeded = apply(emptyDefinition(), [
    { type: "addStep", step: search, position: { after: null } },
  ]);

  const next = apply(seeded, [
    { type: "patchStepParams", stepId: search.id, patch: { tool: "search_messages" } },
    { type: "patchStepParams", stepId: search.id, patch: { slug: "find" } },
  ]);
  assertValid(next);
  const step = next.steps[0];
  if (step?.kind !== "tool") throw new Error("expected tool");
  expect(step.id).toBe(search.id);
  expect(step.tool).toBe("search_messages");
  expect(step.slug).toBe("find");
  expect(step.args).toEqual(search.kind === "tool" ? search.args : {});

  // Unknown id → untouched.
  expect(
    apply(seeded, [
      { type: "patchStepParams", stepId: newStepId(), patch: { slug: "x" } },
    ]),
  ).toEqual(seeded);
});

test("setOverlap and setOnComplete edit run policy and delivery", () => {
  const withBoth = apply(emptyDefinition(), [
    { type: "setOverlap", overlap: "allow" },
    {
      type: "setOnComplete",
      onComplete: { slackReply: { template: { markdown: "Done @now" } } },
    },
  ]);
  assertValid(withBoth);
  expect(withBoth.overlap).toBe("allow");
  expect(withBoth.onComplete?.slackReply?.template.markdown).toBe("Done @now");

  const cleared = apply(withBoth, [
    { type: "setOnComplete", onComplete: undefined },
  ]);
  assertValid(cleared);
  expect("onComplete" in cleared).toBe(false);
});

// ── tree primitives (exported for the strip's drag/drop) ────────────────────

test("removeStepFromTree and insertStepAt are pure and total", () => {
  const search = toolStep("search");
  const loop = forEachStep("loop", [inferStep("inner")]);
  const steps = [search, loop];

  const { steps: pruned, removed } = removeStepFromTree(steps, search.id);
  expect(removed?.id).toBe(search.id);
  expect(ids(pruned)).toEqual([loop.id]);
  // Original untouched.
  expect(ids(steps)).toEqual([search.id, loop.id]);

  expect(insertStepAt(pruned, search, { after: newStepId() })).toBeNull();
  const back = insertStepAt(pruned, search, { after: loop.id });
  expect(back === null ? [] : ids(back)).toEqual([loop.id, search.id]);
});

// ── misc ────────────────────────────────────────────────────────────────────

test("agent steps carry agent ids the schema accepts", () => {
  const step = newStep("agent", []);
  if (step.kind !== "agent") throw new Error("expected agent");
  const definition = apply(emptyDefinition(), [
    { type: "addStep", step, position: { after: null } },
    { type: "patchStepParams", stepId: step.id, patch: { agentId: AGENT_A } },
  ]);
  assertValid(definition);
  const after = definition.steps[0];
  if (after?.kind !== "agent") throw new Error("expected agent");
  expect(after.agentId).toBe(AGENT_A);
});
