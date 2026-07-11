/**
 * Agent editor SCREEN assertions (happy-dom) — the DOM surfaces the lib tests
 * (reducer/controller in agent-editor.test.tsx) do not touch:
 * - AgentRail: section cards with live summaries, aria-current, issue badges,
 *   publish phase capsule + build-error/ready cards, chat/publish actions
 * - AgentHeader: inline rename commit/escape/rollback semantics
 * - ModelSection + AccessSection: user intent → reducer actions
 * - ContextAttachments: attached rows, browse-picker add, remove, empty hints
 *
 * PersonaSection mounts CodeMirror (flaky under happy-dom, same policy as the
 * instructions editor) — its content is covered via the rail's persona
 * summary and the pure reducer tests instead.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { AccessSection } from "../components/agents/AccessSection";
import { AgentHeader } from "../components/agents/AgentHeader";
import { AgentRail } from "../components/agents/AgentRail";
import { ModelSection } from "../components/agents/ModelSection";
import { ContextAttachments } from "../components/context/ContextAttachments";
import { ToastProvider } from "../components/ui/Toast";
import { localAgentDiagnostics } from "../lib/agents/diagnostics";
import {
  FIXTURE_AGENT_CONNECTIONS,
  FIXTURE_AGENT_SKILLS,
  FIXTURE_BUILD_ERROR,
  FIXTURE_EXEC_ASSISTANT,
  FIXTURE_MEMBERS,
  FIXTURE_RELEASE_BOT,
} from "../lib/agents/fixtures";
import { initAgentEditorState } from "../lib/agents/model";
import { INITIAL_PUBLISH_STATE } from "../lib/agents/publish-machine";
import type { ContextResources } from "../lib/builder/resources";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
afterEach(cleanup);

const NOW = "2026-07-09T09:00:00.000Z";

const MODEL_PRESETS = [
  {
    id: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa",
    slug: "balanced" as const,
    provider: "openrouter" as const,
    modelId: "deepseek/deepseek-v4-pro",
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const ALLOWLIST = [
  {
    id: "bbbbbbbb-0001-4000-8000-bbbbbbbbbbbb",
    provider: "openrouter" as const,
    modelId: "deepseek/deepseek-v4-pro",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const RESOURCES: ContextResources = (() => {
  const connections = FIXTURE_AGENT_CONNECTIONS.map((connection) => ({
    ...connection,
    resourceScope: "workspace" as const,
  }));
  const skills = FIXTURE_AGENT_SKILLS.map((skill) => ({
    ...skill,
    resourceScope: "workspace" as const,
  }));
  return {
    connections,
    skills,
    connectionById: new Map(connections.map((c) => [c.id, c])),
    skillById: new Map(skills.map((s) => [s.id, s])),
    isPending: false,
    isError: false,
  };
})();

function railProps(fixture = FIXTURE_EXEC_ASSISTANT) {
  const state = initAgentEditorState(fixture.agent);
  return {
    name: fixture.agent.name,
    publishedVersionId: fixture.agent.publishedVersionId,
    isDirty: false,
    state,
    diagnostics: localAgentDiagnostics({
      definition: state.definition,
      allowedModelIds: ALLOWLIST.map((entry) => entry.modelId),
    }),
    activeSection: "persona" as const,
    onSelectSection: () => {},
    resources: RESOURCES,
    members: FIXTURE_MEMBERS,
    modelPresets: MODEL_PRESETS,
    publishState: INITIAL_PUBLISH_STATE,
    onPublish: () => {},
    canPublish: true,
    onChatWithAgent: () => {},
    chatPending: false,
  };
}

// ── AgentRail ────────────────────────────────────────────────────────────────

test("rail renders identity, lifecycle chips, and all four live section summaries", () => {
  const view = render(<AgentRail {...railProps()} />);

  // Identity + lifecycle.
  expect(view.getByText("Executive assistant")).toBeTruthy();
  expect(view.getByText("EA")).toBeTruthy(); // monogram
  expect(view.getByText("Published")).toBeTruthy();

  // Persona: first line + char count.
  expect(
    view.getByText("You are a meticulous executive assistant."),
  ).toBeTruthy();
  expect(view.getByText(/characters$/)).toBeTruthy();

  // Model: preset label + workspace resolution line.
  expect(view.getByText("Balanced")).toBeTruthy();
  expect(view.getByText(/balanced maps to/)).toBeTruthy();

  // Context: 5 attachments → first 4 chips + overflow.
  expect(view.getByText("gmail")).toBeTruthy();
  expect(view.getByText("+1")).toBeTruthy();

  // Access: run-as member email.
  expect(view.getByText("Runs as avery@acme.com")).toBeTruthy();

  // Actions.
  expect(view.getByRole("button", { name: /Chat with agent/ })).toBeTruthy();
  expect(view.getByRole("button", { name: "Publish" })).toBeTruthy();
});

test("rail marks the active card aria-current and clicking a card selects its section", () => {
  const onSelectSection = mock(() => {});
  const view = render(
    <AgentRail {...railProps()} onSelectSection={onSelectSection} />,
  );

  const current = view.container.querySelectorAll('[aria-current="true"]');
  expect(current.length).toBe(1);
  expect(current[0]!.textContent).toContain("Persona");

  fireEvent.click(view.getByRole("button", { name: /^Model/ }));
  expect(onSelectSection).toHaveBeenCalledWith("model");
});

test("draft agent: Draft + Unsaved chips, persona issue badge, empty-context summary", () => {
  const props = railProps(FIXTURE_RELEASE_BOT);
  const view = render(<AgentRail {...props} isDirty={true} />);

  expect(view.getByText("Draft")).toBeTruthy();
  expect(view.getByText("Unsaved")).toBeTruthy();
  // Empty persona → warning badge on the card + the publish-gate hint line.
  expect(view.getByText("Empty — required to publish")).toBeTruthy();
  expect(view.getByText("1 issue to resolve before publishing")).toBeTruthy();
  expect(view.getByText("No connections or skills")).toBeTruthy();
});

test("rail surfaces publish progress, the build-error card, and the ready card", () => {
  const busy = render(
    <AgentRail
      {...railProps()}
      publishState={{ phase: "building", result: null, error: null }}
    />,
  );
  const publishButton = busy.getByRole("button", { name: /Building…/ });
  expect(publishButton.hasAttribute("disabled")).toBe(true);
  cleanup();

  const failed = render(
    <AgentRail
      {...railProps()}
      publishState={{ phase: "error", result: null, error: FIXTURE_BUILD_ERROR }}
    />,
  );
  // Both treatments read "Publish failed": the error card and the capsule.
  expect(failed.getAllByText("Publish failed")).toHaveLength(2);
  expect(failed.getByText(/eve build failed/)).toBeTruthy();
  cleanup();

  const ready = render(
    <AgentRail
      {...railProps()}
      publishState={{
        phase: "ready",
        result: {
          agentId: FIXTURE_EXEC_ASSISTANT.agent.id,
          versionId: "bbbbbbbb-0001-4000-8000-000000000001",
          contentHash: "hash",
          buildStatus: "succeeded",
          cached: true,
          buildError: null,
        },
        error: null,
      }}
    />,
  );
  expect(ready.getByText("Published — build served from cache.")).toBeTruthy();
});

test("publish stays disabled when canPublish is false; chat fires its callback", () => {
  const onChatWithAgent = mock(() => {});
  const view = render(
    <AgentRail
      {...railProps()}
      canPublish={false}
      onChatWithAgent={onChatWithAgent}
    />,
  );
  const publish = view.getByRole("button", { name: "Publish" });
  expect(publish.hasAttribute("disabled")).toBe(true);

  fireEvent.click(view.getByRole("button", { name: /Chat with agent/ }));
  expect(onChatWithAgent).toHaveBeenCalledTimes(1);
});

// ── AgentHeader ──────────────────────────────────────────────────────────────

test("header commits a rename on Enter and rolls back when persistence fails", async () => {
  let accept = true;
  const onCommitName = mock(async (_name: string) => accept);
  const view = renderWithRouter(
    <AgentHeader
      name="Executive assistant"
      onCommitName={onCommitName}
      saveStatus="saved"
      issueCount={0}
      isDirty={false}
    />,
  );
  const input = (await view.findByLabelText("Agent name")) as HTMLInputElement;

  // React keyboard events on an <input> only fire when it really has focus
  // under happy-dom; Enter/Escape then blur() → focusout → onBlur commit.
  act(() => input.focus());
  fireEvent.input(input, { target: { value: "  Chief of staff  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(onCommitName).toHaveBeenCalledWith("Chief of staff"));
  expect(input.value).toBe("Chief of staff");

  // Escape restores the committed name without persisting.
  act(() => input.focus());
  fireEvent.input(input, { target: { value: "scratch" } });
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => expect(input.value).toBe("Chief of staff"));
  expect(onCommitName).toHaveBeenCalledTimes(1);

  // A failed persistence rolls the input back.
  accept = false;
  act(() => input.focus());
  fireEvent.input(input, { target: { value: "Rejected name" } });
  fireEvent.focusOut(input);
  await waitFor(() => expect(input.value).toBe("Chief of staff"));
});

test("header shows Delete only when the viewer can manage", async () => {
  const onRequestDelete = mock(() => {});
  const view = renderWithRouter(
    <AgentHeader
      name="Executive assistant"
      onCommitName={() => true}
      saveStatus="saved"
      issueCount={0}
      isDirty={false}
      onRequestDelete={onRequestDelete}
    />,
  );
  fireEvent.click(await view.findByRole("button", { name: "Delete agent" }));
  expect(onRequestDelete).toHaveBeenCalledTimes(1);

  cleanup();
  const readOnly = renderWithRouter(
    <AgentHeader
      name="Executive assistant"
      onCommitName={() => true}
      saveStatus="saved"
      issueCount={0}
      isDirty={false}
    />,
  );
  await readOnly.findByLabelText("Agent name");
  expect(readOnly.queryByRole("button", { name: "Delete agent" })).toBeNull();
});

// ── ModelSection / AccessSection ─────────────────────────────────────────────

test("model section dispatches preset changes and flags off-allowlist overrides", () => {
  const dispatch = mock(() => {});
  const view = render(
    <ModelSection
      model={{ preset: "balanced", reasoning: "medium" }}
      dispatch={dispatch}
      modelPresets={MODEL_PRESETS}
      allowlist={ALLOWLIST}
    />,
  );
  expect(view.getByText(/balanced maps to/)).toBeTruthy();

  fireEvent.click(view.getByRole("radio", { name: /^Powerful$/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setModelPreset",
    preset: "powerful",
  });

  cleanup();
  const flagged = render(
    <ModelSection
      model={{
        preset: "quick",
        modelId: "internal/warehouse-1",
        reasoning: "high",
      }}
      dispatch={() => {}}
      modelPresets={MODEL_PRESETS}
      allowlist={ALLOWLIST}
    />,
  );
  expect(flagged.getByText(/not on the workspace allowlist/)).toBeTruthy();
});

test("access section swaps the run-as member", () => {
  const onChangeRunAs = mock(() => {});
  const view = render(
    <AccessSection
      members={FIXTURE_MEMBERS}
      runAsUserId={FIXTURE_MEMBERS[0]!.userId}
      onChangeRunAs={onChangeRunAs}
    />,
  );
  fireEvent.change(view.getByLabelText("Run-as member"), {
    target: { value: FIXTURE_MEMBERS[1]!.userId },
  });
  expect(onChangeRunAs).toHaveBeenCalledWith(FIXTURE_MEMBERS[1]!.userId);
});

// ── ContextAttachments ───────────────────────────────────────────────────────

function renderAttachments(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return renderWithRouter(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

test("context attachments render rows, add via the picker, and remove", async () => {
  const onAddSkill = mock(() => {});
  const onRemoveConnection = mock(() => {});
  const view = renderAttachments(
    <ContextAttachments
      workspaceId="org_test_1"
      connectionIds={[FIXTURE_AGENT_CONNECTIONS[0]!.id]}
      skillIds={[FIXTURE_AGENT_SKILLS[0]!.id]}
      onAddConnection={() => {}}
      onRemoveConnection={onRemoveConnection}
      onAddSkill={onAddSkill}
      onRemoveSkill={() => {}}
      resources={RESOURCES}
    />,
  );

  // Attached rows resolve to names.
  expect(await view.findByText("gmail")).toBeTruthy();
  expect(view.getByText("meeting-notes")).toBeTruthy();

  // Browse → pick an unattached skill (second Browse capsule = skills column;
  // the popover's `label` names the panel, not the trigger).
  fireEvent.click(view.getAllByRole("button", { name: "Browse" })[1]!);
  fireEvent.click(await view.findByText("triage-playbook"));
  expect(onAddSkill).toHaveBeenCalledWith(FIXTURE_AGENT_SKILLS[1]!.id);

  // Remove an attached connection.
  fireEvent.click(view.getByRole("button", { name: "Remove gmail" }));
  expect(onRemoveConnection).toHaveBeenCalledWith(
    FIXTURE_AGENT_CONNECTIONS[0]!.id,
  );
});

test("context attachments show dashed empty hints and the missing-resource note", async () => {
  const view = renderAttachments(
    <ContextAttachments
      workspaceId="org_test_1"
      connectionIds={["99999999-9999-4999-8999-999999999999"]}
      skillIds={[]}
      onAddConnection={() => {}}
      onRemoveConnection={() => {}}
      onAddSkill={() => {}}
      onRemoveSkill={() => {}}
      resources={RESOURCES}
    />,
  );

  expect(
    await view.findByText(/No skills attached\. Browse to add authored skills\./),
  ).toBeTruthy();
  expect(
    view.getByText(/1 attached connection could not be found/),
  ).toBeTruthy();
});
