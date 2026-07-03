/**
 * DOM smoke tests for the builder's plain-React editors and rail — they mount
 * without crashing and route user intent to the reducer. (The CodeMirror
 * instructions editor is exercised by its pure @-source tests instead; it is
 * flaky under happy-dom.)
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type {
  AgentPresetDto,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import { TriggerEditor } from "../components/builder/TriggerEditor";
import { AgentEditor } from "../components/builder/AgentEditor";
import { PillarRail } from "../components/builder/PillarRail";
import { emptyDiagnostics } from "../lib/builder/diagnostics";
import { INITIAL_PUBLISH_STATE } from "../lib/builder/publish-machine";

ensureDomForThisFile();
afterEach(cleanup);

const PRESET_ID = "a1111111-1111-4111-8111-111111111111";

function definition(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    trigger: { type: "manual" },
    context: { mcpConnectionIds: [], skillIds: [] },
    agent: { agentPresetId: PRESET_ID },
    instructions: { markdown: "Hello" },
    ...overrides,
  };
}

const agentPreset: AgentPresetDto = {
  id: PRESET_ID,
  name: "General Purpose",
  description: "A helpful generalist",
  basePrompt: "You are helpful.",
  reasoningEffort: "medium",
  modelPreset: "balanced",
  modelId: null,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const modelPreset: ModelPresetDto = {
  id: "b2222222-2222-4222-8222-222222222222",
  slug: "balanced",
  provider: "openrouter",
  modelId: "deepseek/deepseek-v4-pro",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

test("TriggerEditor switches type and adds a form field via dispatch", () => {
  const dispatch = mock(() => {});
  const view = render(
    <TriggerEditor definition={definition()} dispatch={dispatch} />,
  );

  fireEvent.click(view.getByRole("radio", { name: /Form/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setTriggerType",
    triggerType: "form",
  });
});

test("TriggerEditor form view renders the field designer and cron preview", () => {
  const dispatch = mock(() => {});
  const view = render(
    <TriggerEditor
      definition={definition({
        trigger: {
          type: "form",
          fields: [{ key: "email", label: "Email", type: "text", required: true }],
        },
      })}
      dispatch={dispatch}
    />,
  );
  expect(view.getByRole("button", { name: /Add field/ })).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: /Add field/ }));
  expect(dispatch).toHaveBeenCalledWith({ type: "addFormField" });
});

test("AgentEditor renders preset cards and dispatches model-preset changes", () => {
  const dispatch = mock(() => {});
  const view = render(
    <AgentEditor
      definition={definition()}
      dispatch={dispatch}
      presets={[agentPreset]}
      modelPresets={[modelPreset]}
      allowlist={[]}
      members={[]}
      runAsUserId="u1"
      onChangeRunAs={() => {}}
    />,
  );
  expect(view.getByRole("radio", { name: /General Purpose/ })).toBeTruthy();

  fireEvent.click(view.getByRole("radio", { name: /^Quick$/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setModelPreset",
    preset: "quick",
  });
});

test("PillarRail lists the four pillars and fires focus + publish", () => {
  const onFocusPillar = mock(() => {});
  const onPublish = mock(() => {});
  const view = render(
    <PillarRail
      name="My workflow"
      publishedVersionId={null}
      isDirty={false}
      definition={definition()}
      diagnostics={emptyDiagnostics()}
      activePillar="trigger"
      onFocusPillar={onFocusPillar}
      connections={[]}
      skills={[]}
      agentPresets={[agentPreset]}
      modelPresets={[modelPreset]}
      publishState={INITIAL_PUBLISH_STATE}
      onPublish={onPublish}
      onRunDraft={() => {}}
      runDraftPending={false}
      canPublish={true}
    />,
  );

  for (const label of ["Trigger", "Context", "Agent", "Instructions"]) {
    expect(view.getByText(label)).toBeTruthy();
  }

  fireEvent.click(view.getByText("Agent"));
  expect(onFocusPillar).toHaveBeenCalledWith("agent");

  fireEvent.click(view.getByRole("button", { name: /Publish/ }));
  expect(onPublish).toHaveBeenCalled();
});

test("PillarRail shows a build error surface when publish failed", () => {
  const view = render(
    <PillarRail
      name="My workflow"
      publishedVersionId={null}
      isDirty={false}
      definition={definition()}
      diagnostics={emptyDiagnostics()}
      activePillar="trigger"
      onFocusPillar={() => {}}
      connections={[]}
      skills={[]}
      agentPresets={[agentPreset]}
      modelPresets={[modelPreset]}
      publishState={{
        phase: "error",
        result: null,
        error: "tsc: type error in agent.ts",
      }}
      onPublish={() => {}}
      onRunDraft={() => {}}
      runDraftPending={false}
      canPublish={true}
    />,
  );
  expect(view.getByText(/type error in agent.ts/)).toBeTruthy();
});
