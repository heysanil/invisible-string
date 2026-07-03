/**
 * Phase-3 trigger UI: the Integrations settings panel (connected-team cards +
 * disconnect), the builder's live webhook-token reveal ("shown once, we store
 * only a hash"), and the chat run-cancel button.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { IntegrationsPanel } from "../components/settings/IntegrationsPanel";
import { LiveTriggerConfig } from "../components/builder/LiveTriggerConfig";
import { RunMessage } from "../components/chat/RunMessage";
import type { RunView } from "../lib/chat/run-view";

ensureDomForThisFile();

const NOW = "2026-07-03T00:00:00.000Z";

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

// ── Integrations panel ───────────────────────────────────────────────────────

const SLACK_INTEGRATION = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "slack",
  externalId: "T-ACME",
  teamName: "Acme HQ",
  botUserId: "U0BOT",
  scopes: ["chat:write", "app_mentions:read"],
  hasCredentials: true,
  createdAt: NOW,
  updatedAt: NOW,
};

test("IntegrationsPanel lists connected Slack teams and disconnects", async () => {
  fetchMock.on("GET", "/integrations", () =>
    jsonResponse({ integrations: [SLACK_INTEGRATION] }),
  );
  fetchMock.on("DELETE", /\/integrations\/[^/]+$/, () =>
    jsonResponse({ id: SLACK_INTEGRATION.id, deleted: true }),
  );

  const view = renderWithProviders(
    <IntegrationsPanel workspaceId="org_1" canManage />,
  );

  await view.findByText("Acme HQ");
  expect(view.getByText("Connected")).toBeTruthy();
  // Non-secret metadata only — no token surfaced.
  expect(view.queryByText(/xoxb/)).toBeNull();

  fireEvent.click(view.getByLabelText("Disconnect Acme HQ"));
  // Confirm dialog → disconnect.
  const confirm = await view.findByText("Disconnect Slack?");
  expect(confirm).toBeTruthy();
  fireEvent.click(view.getAllByText("Disconnect").at(-1)!);

  await waitFor(() => {
    expect(
      fetchMock.calls.some(
        (c) => c.method === "DELETE" && c.path.includes("/integrations/"),
      ),
    ).toBe(true);
  });
});

test("IntegrationsPanel shows an empty state with a Connect button", async () => {
  fetchMock.on("GET", "/integrations", () => jsonResponse({ integrations: [] }));
  const view = renderWithProviders(
    <IntegrationsPanel workspaceId="org_1" canManage />,
  );
  await view.findByText("No connected workspaces");
  expect(view.getAllByText("Connect Slack").length).toBeGreaterThan(0);
});

// ── Webhook token reveal ─────────────────────────────────────────────────────

test("LiveTriggerConfig mints a webhook token, revealing it ONCE with a hash notice", async () => {
  fetchMock.on(
    "GET",
    /\/workflows\/[^/]+\/triggers$/,
    () => jsonResponse({ triggers: [] }),
  );
  fetchMock.on("POST", /\/triggers\/webhook-token$/, () =>
    jsonResponse(
      {
        triggerId: "22222222-2222-4222-8222-222222222222",
        token: "whk_live_supersecret012345",
        tokenSuffix: "2345",
        ingressUrl: "https://app.test/t/whk_live_supersecret012345",
        createdAt: NOW,
      },
      201,
    ),
  );

  const view = renderWithProviders(
    <LiveTriggerConfig workspaceId="org_1" workflowId="wf_1" triggerType="webhook" />,
  );

  fireEvent.click(await view.findByText("Generate token"));

  const revealed = await view.findByTestId("revealed-token");
  expect(revealed.textContent).toBe("whk_live_supersecret012345");
  expect(view.getByText(/we store only a hash/i)).toBeTruthy();
});

// ── Chat cancel button ───────────────────────────────────────────────────────

function runningRunView(runId: string): RunView {
  return {
    runId,
    status: "running",
    userMessage: "do the thing",
    block: null,
    reply: null,
    pendingInputs: [],
    error: null,
    modelId: null,
  };
}

test("RunMessage renders a Cancel button on an active run and fires onCancel", () => {
  const onCancel = mock((_runId: string) => {});
  const view = renderWithProviders(
    <RunMessage
      run={runningRunView("run_1")}
      isChatOrigin
      onRespond={() => {}}
      onCancel={onCancel}
    />,
  );
  fireEvent.click(view.getByText("Cancel run"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onCancel.mock.calls[0]![0]).toBe("run_1");
});

test("RunMessage shows no Cancel button on a settled run", () => {
  const view = renderWithProviders(
    <RunMessage
      run={{ ...runningRunView("run_2"), status: "succeeded", reply: { text: "done", streaming: false } }}
      isChatOrigin
      onRespond={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(view.queryByText("Cancel run")).toBeNull();
});
