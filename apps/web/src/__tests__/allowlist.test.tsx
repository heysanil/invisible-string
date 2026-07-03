/**
 * Allowlist guard states: an entry a preset points at shows "In use" with a
 * disabled remove; an unreferenced entry can be removed. And role gating —
 * a member (canManage=false) sees a read-only view with no mutating
 * controls.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { AllowlistPanel } from "../components/settings/AllowlistPanel";

ensureDomForThisFile();

const NOW = "2026-07-03T00:00:00.000Z";

const ALLOWLIST = {
  entries: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "openrouter",
      modelId: "z-ai/glm-5.2",
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

// A preset points at the first entry — making it "in use".
const PRESETS = {
  presets: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "balanced",
      provider: "openrouter",
      modelId: "z-ai/glm-5.2",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
  fetchMock
    .on("GET", "/model-allowlist", () => jsonResponse(ALLOWLIST))
    .on("GET", "/model-presets", () => jsonResponse(PRESETS));
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("in-use entry is guarded; unreferenced entry can be removed (owner)", async () => {
  const view = renderWithProviders(
    <AllowlistPanel workspaceId="org_1" canManage />,
  );

  await view.findByText("z-ai/glm-5.2");
  // The referenced entry is labelled in use.
  expect(view.getByText("In use")).toBeTruthy();

  const guarded = view.getByRole("button", {
    name: "Remove z-ai/glm-5.2 (in use by a preset)",
  }) as HTMLButtonElement;
  expect(guarded.disabled).toBe(true);

  const removable = view.getByRole("button", {
    name: "Remove deepseek/deepseek-v4-flash",
  }) as HTMLButtonElement;
  expect(removable.disabled).toBe(false);

  // The add-model affordance is present for a manager.
  expect(view.getByText("Add a model")).toBeTruthy();
});

test("a member sees a read-only allowlist — no toggles, remove, or add", async () => {
  const view = renderWithProviders(
    <AllowlistPanel workspaceId="org_1" canManage={false} />,
  );

  await view.findByText("z-ai/glm-5.2");

  await waitFor(() => {
    expect(view.queryByText("Add a model")).toBeNull();
  });
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.queryByRole("button", { name: /Remove/ })).toBeNull();
});
