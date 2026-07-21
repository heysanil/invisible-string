/**
 * Deleting an MCP connection that AGENTS still reference must not silently
 * fail: the server's 409 `connection_in_use` carries a bare array of agent
 * names (errors.connectionInUse) which surfaces as a helpful blocker dialog
 * that names the agents and prescribes achievable remediation.
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
import { McpConnectionsGrid } from "../components/context/McpConnectionsGrid";

ensureDomForThisFile();

const NOW = "2026-07-03T00:00:00.000Z";

const CONNECTIONS = {
  connections: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      scope: "workspace",
      name: "GitHub",
      description: null,
      source: "registry",
      registryId: "io.github/github",
      url: null,
      toolAllow: null,
      toolBlock: null,
      approvalPolicy: null,
      enabled: true,
      hasCredentials: true,
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

test("409 on delete opens a blocker dialog naming the agents (real server shape: bare name array)", async () => {
  fetchMock
    .on("GET", "/mcp-connections", () => jsonResponse(CONNECTIONS))
    .on("DELETE", "/mcp-connections/", () =>
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
    <McpConnectionsGrid
      scope={{ scope: "workspace", workspaceId: "org_1" }}
      onAdd={() => {}}
      readOnly={false}
    />,
  );

  await view.findByText("GitHub");
  fireEvent.click(view.getByRole("button", { name: "Remove" }));

  // Confirm the destructive action in the first dialog.
  const confirm = await view.findByRole("dialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));

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
