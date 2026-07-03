/**
 * Deleting an MCP connection that published workflows still reference must
 * not silently fail: a 409 with workflow names surfaces as a helpful blocker
 * dialog that lists them.
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

test("409 on delete opens a blocker dialog listing the workflows", async () => {
  fetchMock
    .on("GET", "/mcp-connections", () => jsonResponse(CONNECTIONS))
    .on("DELETE", "/mcp-connections/", () =>
      jsonResponse(
        {
          error: {
            code: "connection_in_use",
            message: "in use",
            details: { workflows: ["Daily digest", "Standup bot"] },
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

  // The 409 flips it to a blocker dialog listing the blocking workflows.
  expect(await view.findByText("Still in use")).toBeTruthy();
  expect(await view.findByText("Daily digest")).toBeTruthy();
  expect(view.getByText("Standup bot")).toBeTruthy();
});
