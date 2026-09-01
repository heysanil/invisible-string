/**
 * DOM tests for the step inspectors (components/pipeline/inspector): the
 * shared frame (name/slug/remove), the tool form's connection → tool → args
 * flow (schema-aware fields, template parsing to `$ref`), the control-verb
 * forms, the state rows, the agent picker, and the infer form's preset +
 * structured-output toggles. Every edit must land as ONE `patchStepParams`
 * (or `removeStep`) through the dispatch mock.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import {
  WORKFLOW_CONFIG_VERSION,
  type AgentSummaryDto,
  type BranchStep,
  type ConnectionDto,
  type ForEachStep,
  type InferStep,
  type ModelPresetDto,
  type PipelineStep,
  type StateStep,
  type ToolStep,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { StepInspector } from "../components/pipeline/inspector/StepInspector";
import type { BuilderAction } from "../lib/builder/model";
import type { ContextResources, ScopedConnection } from "../lib/builder/resources";
import { referenceSourcesForStep } from "../lib/builder/references";
import type { StepReferenceContext } from "../lib/builder/useBuilderController";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
afterEach(cleanup);

let n = 0;
function id(): string {
  n += 1;
  return `st_${String(n).padStart(16, "0")}`;
}

function connection(
  overrides: Partial<ConnectionDto> & { id: string; name: string },
): ScopedConnection {
  return {
    scope: "workspace",
    description: null,
    source: "catalog",
    catalogSlug: null,
    registryName: null,
    url: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    authType: "none",
    hasCredentials: false,
    oauthStatus: null,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: null,
    enabled: true,
    health: "ok",
    lastCheckedAt: null,
    lastError: null,
    tools: null,
    toolsCachedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    resourceScope: "workspace",
    ...overrides,
  };
}

function resourcesOf(connections: ScopedConnection[]): ContextResources {
  return {
    connections,
    skills: [],
    connectionById: new Map(connections.map((c) => [c.id, c])),
    skillById: new Map(),
    isPending: false,
    isError: false,
  };
}

function definitionOf(steps: PipelineStep[]): WorkflowConfig {
  return {
    version: WORKFLOW_CONFIG_VERSION,
    trigger: { type: "manual" },
    steps,
    overlap: "skip",
  };
}

const SLACK = connection({
  id: "cn_slack",
  name: "Slack",
  tools: [
    {
      name: "search_messages",
      description: "Search channel history.",
      params: ["query", "limit"],
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text." },
          limit: { type: "integer" },
        },
        required: ["query"],
      },
    },
    { name: "post_message", description: "Post to a channel.", params: ["text"] },
  ],
  toolsCachedAt: "2026-08-20T00:00:00.000Z",
});

const LINEAR = connection({
  id: "cn_linear",
  name: "Linear",
  health: "auth_required",
  tools: [],
});

function renderInspector(
  step: PipelineStep,
  options: {
    steps?: PipelineStep[];
    resources?: ContextResources;
    agents?: readonly AgentSummaryDto[] | null;
    presets?: readonly ModelPresetDto[] | null;
    withProviders?: boolean;
  } = {},
) {
  const steps = options.steps ?? [step];
  const definition = definitionOf(steps);
  const dispatch = mock((_action: BuilderAction) => {});
  const referenceSourcesFor = (stepId: string, context?: StepReferenceContext) =>
    referenceSourcesForStep(steps, stepId, {
      trigger: definition.trigger,
      connections: context?.connections ?? [],
      skills: context?.skills ?? [],
    });
  const ui = (
    <StepInspector
      step={step}
      definition={definition}
      dispatch={dispatch}
      resources={options.resources ?? resourcesOf([SLACK, LINEAR])}
      agents={options.agents ?? []}
      presets={options.presets ?? null}
      workspaceId="ws_1"
      referenceSourcesFor={referenceSourcesFor}
    />
  );
  if (options.withProviders) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return {
      dispatch,
      view: renderWithRouter(
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
      ),
    };
  }
  return { dispatch, view: render(ui) };
}

function lastAction(dispatch: ReturnType<typeof mock>): BuilderAction {
  const calls = dispatch.mock.calls;
  return calls[calls.length - 1]![0] as BuilderAction;
}

function toolStep(overrides: Partial<ToolStep> = {}): ToolStep {
  return {
    id: id(),
    slug: "search",
    kind: "tool",
    connectionId: "cn_slack",
    tool: "search_messages",
    args: {},
    sideEffect: "at_least_once",
    ...overrides,
  };
}

// ── shared frame ────────────────────────────────────────────────────────────

test("frame: name and slug edits dispatch patchStepParams; Remove removes", () => {
  const step = toolStep();
  const { view, dispatch } = renderInspector(step);

  fireEvent.input(view.getByLabelText("Name"), {
    target: { value: "Search Slack" },
  });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { name: "Search Slack" },
  });

  fireEvent.input(view.getByLabelText("Slug"), { target: { value: "find" } });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { slug: "find" },
  });

  fireEvent.click(view.getByRole("button", { name: /Remove step/ }));
  expect(lastAction(dispatch)).toEqual({ type: "removeStep", stepId: step.id });
});

test("frame: a slug another step already uses is flagged", () => {
  const other = toolStep({ slug: "search" });
  const step = toolStep({ slug: "search" });
  const { view } = renderInspector(step, { steps: [other, step] });
  expect(view.getByText("Another step already uses this slug.")).toBeTruthy();
});

// ── tool form ───────────────────────────────────────────────────────────────

test("tool form: switching connection clears tool + args in one patch, health chip shows", () => {
  const step = toolStep();
  const { view, dispatch } = renderInspector(step);

  // Probe health rides the chip next to the select.
  expect(view.getByText("Healthy")).toBeTruthy();

  fireEvent.change(view.getByLabelText("Connection"), {
    target: { value: "cn_linear" },
  });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { connectionId: "cn_linear", tool: "", args: {} },
  });
});

test("tool form: searchable picker over the cached tools sets the tool", () => {
  const step = toolStep({ tool: "" });
  const { view, dispatch } = renderInspector(step);

  fireEvent.input(view.getByLabelText("Search tools"), {
    target: { value: "post" },
  });
  const listbox = view.getByRole("listbox", { name: "Tools" });
  expect(within(listbox).queryByText("search_messages")).toBeNull();
  fireEvent.click(within(listbox).getByRole("option", { name: /post_message/ }));
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { tool: "post_message" },
  });
});

test("tool form: schema-aware arg fields parse @refs into $ref values", () => {
  const prev = toolStep({ slug: "prev" });
  const step = toolStep();
  const { view, dispatch } = renderInspector(step, { steps: [prev, step] });

  // Schema fields, required first.
  const query = view.getByLabelText("query");
  expect(view.getByText("Search text.")).toBeTruthy();
  fireEvent.input(query, { target: { value: "@steps.prev.result" } });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { args: { query: { $ref: "steps.prev.result" } } },
  });

  // The integer-typed field coerces plain numerals.
  fireEvent.input(view.getByLabelText("limit"), { target: { value: "25" } });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { args: { limit: 25 } },
  });
});

test("tool form: the side-effect switch flips the crash-retry stance", () => {
  const step = toolStep();
  const { view, dispatch } = renderInspector(step);
  fireEvent.click(view.getByRole("switch", { name: "Never run twice" }));
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { sideEffect: "at_most_once" },
  });
});

// ── control verbs ───────────────────────────────────────────────────────────

test("for_each form: items path edits dispatch a $ref patch", () => {
  const prev = toolStep({ slug: "search" });
  const step: ForEachStep = {
    id: id(),
    slug: "each",
    kind: "for_each",
    items: { $ref: "" },
    steps: [],
    maxItems: 100,
    onItemError: "halt",
  };
  const { view, dispatch } = renderInspector(step, { steps: [prev, step] });
  fireEvent.input(view.getByLabelText("Items reference"), {
    target: { value: "steps.search.result" },
  });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { items: { $ref: "steps.search.result" } },
  });
});

test("branch form: the else toggle adds and removes the lane", () => {
  const step: BranchStep = {
    id: id(),
    slug: "route",
    kind: "branch",
    branches: [{ when: { truthy: { $ref: "now" } }, steps: [] }],
  };
  const { view, dispatch } = renderInspector(step);
  fireEvent.click(view.getByRole("switch", { name: "Else lane" }));
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { else: [] },
  });
});

// ── state form ──────────────────────────────────────────────────────────────

test("state form: adding a key seeds it empty; values are template-aware", () => {
  const step: StateStep = {
    id: id(),
    slug: "cursor",
    kind: "state",
    set: { cursor: "" },
  };
  const { view, dispatch } = renderInspector(step);

  fireEvent.input(view.getByLabelText("New key"), {
    target: { value: "last_seen" },
  });
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { set: { cursor: "", last_seen: "" } },
  });

  fireEvent.input(view.getByLabelText("cursor"), {
    target: { value: "@trigger.ts" },
  });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { set: { cursor: { $ref: "trigger.ts" } } },
  });
});

test("state form: an invalid key is rejected before it reaches the draft", () => {
  const step: StateStep = { id: id(), slug: "s", kind: "state", set: {} };
  const { view, dispatch } = renderInspector(step);
  fireEvent.input(view.getByLabelText("New key"), {
    target: { value: "9bad key" },
  });
  expect(
    view.getByText("Keys start with a letter and use letters, digits, _ or -."),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});

// ── agent form ──────────────────────────────────────────────────────────────

const AGENTS: AgentSummaryDto[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Executive assistant",
    description: "Handles scheduling.",
    runAsUserId: "user_1",
    publishedVersionId: "00000000-0000-4000-8000-0000000000aa",
    publishedAt: "2026-08-01T00:00:00.000Z",
    buildStatus: "succeeded",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Release bot",
    description: null,
    runAsUserId: "user_1",
    publishedVersionId: null,
    publishedAt: null,
    buildStatus: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
];

test("agent form: published-only picker dispatches agentId patches", async () => {
  const step: PipelineStep = {
    id: id(),
    slug: "delegate",
    kind: "agent",
    agentId: null,
    instructions: { markdown: "" },
    session: "fresh",
  };
  const { view, dispatch } = renderInspector(step, {
    agents: AGENTS,
    withProviders: true,
  });

  const group = await view.findByRole("radiogroup", { name: "Agent" });
  const radios = within(group).getAllByRole("radio");
  // The never-published agent is not offerable.
  expect(radios).toHaveLength(1);
  fireEvent.click(
    within(group).getByRole("radio", { name: /Executive assistant/ }),
  );
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { agentId: AGENTS[0]!.id },
  });
  // Manual trigger → the thread toggle is not offered at all.
  expect(view.queryByRole("switch", { name: "Continue the Slack thread" })).toBeNull();
});

// ── infer form ──────────────────────────────────────────────────────────────

const PRESETS: ModelPresetDto[] = [
  {
    id: "pr_1",
    slug: "quick",
    provider: "openrouter",
    modelId: "moonshotai/kimi-k3",
    reasoning: "low",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "pr_2",
    slug: "balanced",
    provider: "openrouter",
    modelId: "moonshotai/kimi-k3",
    reasoning: "high",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
];

test("infer form: preset select + structured-output toggle patch the step", () => {
  const step: InferStep = {
    id: id(),
    slug: "summarize",
    kind: "infer",
    preset: "quick",
    prompt: { markdown: "" },
  };
  const { view, dispatch } = renderInspector(step, { presets: PRESETS });

  fireEvent.change(view.getByLabelText("Model preset"), {
    target: { value: "balanced" },
  });
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { preset: "balanced" },
  });

  fireEvent.click(view.getByRole("switch", { name: "Structured output" }));
  expect(lastAction(dispatch)).toEqual({
    type: "patchStepParams",
    stepId: step.id,
    patch: { output: { schema: { type: "object", properties: {} } } },
  });
});
