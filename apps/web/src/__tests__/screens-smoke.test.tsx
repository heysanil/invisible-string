/**
 * Populated-state smoke tests for the context/settings screens — they render
 * real data without crashing and wire their primary interactions.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { ContextHome } from "../components/context/ContextHome";
import { ModelsPanel } from "../components/settings/ModelsPanel";
import { AgentPresetsPanel } from "../components/settings/AgentPresetsPanel";

ensureDomForThisFile();

const NOW = "2026-07-03T00:00:00.000Z";

const CONNECTIONS = {
  connections: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      scope: "workspace",
      name: "Linear",
      description: "Issue tracking",
      source: "registry",
      registryId: "io.linear/mcp",
      url: null,
      toolAllow: ["create_issue"],
      toolBlock: null,
      approvalPolicy: { default: "once" },
      enabled: true,
      hasCredentials: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

const SKILLS = {
  skills: [
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      scope: "workspace",
      name: "Brand voice",
      description: "How we write",
      content: "# Brand voice",
      files: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

const PRESETS = {
  presets: [
    { id: "11111111-1111-4111-8111-111111111111", slug: "powerful", provider: "openrouter", modelId: "z-ai/glm-5.2", createdAt: NOW, updatedAt: NOW },
    { id: "22222222-2222-4222-8222-222222222222", slug: "balanced", provider: "openrouter", modelId: "deepseek/deepseek-v4-pro", createdAt: NOW, updatedAt: NOW },
    { id: "33333333-3333-4333-8333-333333333333", slug: "quick", provider: "openrouter", modelId: "deepseek/deepseek-v4-flash", createdAt: NOW, updatedAt: NOW },
  ],
};

const ALLOWLIST = {
  entries: [
    { id: "44444444-4444-4444-8444-444444444444", provider: "openrouter", modelId: "z-ai/glm-5.2", enabled: true, createdAt: NOW, updatedAt: NOW },
    { id: "55555555-5555-4555-8555-555555555555", provider: "openrouter", modelId: "deepseek/deepseek-v4-pro", enabled: true, createdAt: NOW, updatedAt: NOW },
  ],
};

const AGENTS = {
  agents: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Support triager",
      description: "Triages inbound support",
      basePrompt: "You are a support triager.",
      reasoningEffort: "medium",
      modelPreset: "balanced",
      modelId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("ContextHome renders connections + skills and opens a skill", async () => {
  fetchMock
    .on("GET", "/mcp-connections", () => jsonResponse(CONNECTIONS))
    .on("GET", "/skills", () => jsonResponse(SKILLS));

  const onOpenSkill = mock((_scope: string, _id: string) => {});
  const view = renderWithProviders(
    <ContextHome workspaceId="org_1" canManage onOpenSkill={onOpenSkill} />,
  );

  await view.findByText("Linear");
  const skill = await view.findByText("Brand voice");
  fireEvent.click(skill);
  expect(onOpenSkill).toHaveBeenCalledWith(
    "workspace",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
});

test("ModelsPanel shows the three presets with current-model chips", async () => {
  fetchMock
    .on("GET", "/model-presets", () => jsonResponse(PRESETS))
    .on("GET", "/model-allowlist", () => jsonResponse(ALLOWLIST));

  const view = renderWithProviders(<ModelsPanel workspaceId="org_1" canManage />);

  await view.findByText("Powerful");
  expect(view.getByText("Balanced")).toBeTruthy();
  expect(view.getByText("Quick")).toBeTruthy();
  // Current-model chip for the powerful preset.
  expect(view.getByText(/OpenRouter · z-ai\/glm-5.2/)).toBeTruthy();
});

test("AgentPresetsPanel lists presets and opens the create drawer", async () => {
  fetchMock
    .on("GET", "/agents", () => jsonResponse(AGENTS))
    .on("GET", "/model-allowlist", () => jsonResponse(ALLOWLIST));

  const view = renderWithProviders(
    <AgentPresetsPanel workspaceId="org_1" canManage />,
  );

  await view.findByText("Support triager");
  fireEvent.click(view.getByRole("button", { name: "New preset" }));
  // Drawer opens with the base-prompt field.
  expect(await view.findByLabelText("Base prompt")).toBeTruthy();
});
