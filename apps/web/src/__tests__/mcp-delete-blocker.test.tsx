/**
 * Deleting an MCP connection that AGENTS still reference must not silently
 * fail: the server's 409 `connection_in_use` carries a bare array of agent
 * names (errors.connectionInUse) which surfaces as a helpful blocker dialog
 * that names the agents and prescribes achievable remediation. Since the
 * connectors redesign (plan-2 Task 4) delete lives in the connection
 * detail's danger zone, not on the card.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, within } from "@testing-library/react";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { ConnectionDetail } from "../components/context/ConnectionDetail";

ensureDomForThisFile();

const NOW = "2026-07-03T00:00:00.000Z";
const ID = "cn_cccccccccccccccc";

const CONNECTION = {
  id: ID,
  scope: "workspace",
  name: "GitHub",
  description: null,
  source: "registry",
  catalogSlug: null,
  registryName: "io.github/github",
  url: "https://mcp.github.dev/mcp",
  transport: "streamable-http",
  authType: "headers",
  hasCredentials: true,
  oauthStatus: null,
  toolAllow: null,
  toolBlock: null,
  approvalPolicy: null,
  enabled: true,
  health: "ok",
  // Fresh so the detail's stale auto re-probe stays quiet in this test.
  lastCheckedAt: new Date().toISOString(),
  lastError: null,
  tools: null,
  toolsCachedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("409 on delete opens a blocker dialog naming the agents (real server shape: bare name array)", async () => {
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: CONNECTION }))
    .on("DELETE", `/connections/${ID}`, () =>
      jsonResponse(
        {
          error: {
            code: "connection_in_use",
            message: "connection is referenced by 2 agent(s): Support Bot, Research Assistant",
            // errors.connectionInUse sends a BARE array of agent names.
            details: ["Support Bot", "Research Assistant"],
          },
        },
        409,
      ),
    );

  const view = renderWithProviders(
    <ConnectionDetail
      scope={{ scope: "workspace", workspaceId: "org_1" }}
      connectionId={ID}
      readOnly={false}
      onClose={() => {}}
    />,
  );

  // Delete lives in the detail's danger zone.
  fireEvent.click(await view.findByRole("button", { name: "Remove connection" }));

  // Confirm the destructive action in the confirm dialog.
  const confirm = await view.findByText("Remove GitHub?");
  fireEvent.click(
    within(confirm.closest('[role="dialog"]') as HTMLElement).getByRole("button", {
      name: "Remove",
    }),
  );

  // The 409 flips it to a blocker dialog listing the blocking AGENTS, with
  // remediation the user can actually perform (the reference lives on the
  // agent's context — unpublishing workflows can never clear it).
  expect(await view.findByText("Still in use")).toBeTruthy();
  expect(await view.findByText("Support Bot")).toBeTruthy();
  expect(view.getByText("Research Assistant")).toBeTruthy();
  expect(
    view.getByText(
      "The agents below still use this connection (in their draft or a published version). Detach it from each agent's context first, then remove it.",
    ),
  ).toBeTruthy();
});
