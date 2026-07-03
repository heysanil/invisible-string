/**
 * Registry browser: search → pick → configure (secret form) → install, plus
 * the secrets discipline invariant — a secret the user types is sent once in
 * the install request and never rendered back after the flow completes.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { RegistryServerSummary } from "@invisible-string/shared";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { RegistryBrowserModal } from "../components/context/RegistryBrowserModal";

ensureDomForThisFile();

const SERVER: RegistryServerSummary = {
  name: "io.github.acme/vault",
  title: "Acme Vault",
  description: "Secrets and config for Acme services.",
  version: "1.2.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.acme.dev/mcp" }],
  envVarDeclarations: [
    { name: "API_KEY", isRequired: true, isSecret: true },
  ],
};

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scope: "workspace",
  name: "Acme Vault",
  description: "Secrets and config for Acme services.",
  source: "registry",
  registryId: "io.github.acme/vault",
  url: "https://mcp.acme.dev/mcp",
  toolAllow: null,
  toolBlock: null,
  approvalPolicy: null,
  enabled: true,
  hasCredentials: true,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const SECRET = "sk-live-super-secret-123";

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("search → pick → install sends the typed secret exactly once", async () => {
  fetchMock
    .on("GET", "/mcp-registry/search", () => jsonResponse({ servers: [SERVER] }))
    .on("POST", "/mcp-connections/install", () =>
      jsonResponse({ connection: CONNECTION }, 201),
    );

  const onClose = mock(() => {});
  const view = renderWithProviders(
    <RegistryBrowserModal
      open
      onClose={onClose}
      scope={{ scope: "workspace", workspaceId: "org_1" }}
      scopeLabel="workspace"
    />,
  );

  fireEvent.input(view.getByLabelText("Search the MCP registry"), {
    target: { value: "vault" },
  });

  // Result card appears after the debounce + query resolves.
  const card = await view.findByText("Acme Vault", {}, { timeout: 2000 });
  fireEvent.click(card.closest("button")!);

  // Configure step: the secret declaration renders as a password field.
  const secretField = (await view.findByLabelText("API_KEY")) as HTMLInputElement;
  expect(secretField.type).toBe("password");
  fireEvent.input(secretField, { target: { value: SECRET } });

  fireEvent.click(view.getByRole("button", { name: "Install" }));

  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });

  const installCall = fetchMock.calls.find(
    (call) => call.method === "POST" && call.path.endsWith("/install"),
  );
  expect(installCall).toBeTruthy();
  const body = installCall!.body as {
    registryName: string;
    remoteUrl: string;
    auth?: { type: string; values: Record<string, string> };
  };
  expect(body.registryName).toBe("io.github.acme/vault");
  expect(body.remoteUrl).toBe("https://mcp.acme.dev/mcp");
  expect(body.auth).toEqual({ type: "headers", values: { API_KEY: SECRET } });

  // Secret sent exactly once.
  const installCount = fetchMock.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/install"),
  ).length;
  expect(installCount).toBe(1);

  // After the flow closes, the secret is nowhere in the DOM.
  expect(view.queryByDisplayValue(SECRET)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET);
});

test("required secret is validated before any request is sent", async () => {
  fetchMock
    .on("GET", "/mcp-registry/search", () => jsonResponse({ servers: [SERVER] }))
    .on("POST", "/mcp-connections/install", () =>
      jsonResponse({ connection: CONNECTION }, 201),
    );

  const view = renderWithProviders(
    <RegistryBrowserModal
      open
      onClose={() => {}}
      scope={{ scope: "workspace", workspaceId: "org_1" }}
      scopeLabel="workspace"
    />,
  );

  fireEvent.input(view.getByLabelText("Search the MCP registry"), {
    target: { value: "vault" },
  });
  const card = await view.findByText("Acme Vault", {}, { timeout: 2000 });
  fireEvent.click(card.closest("button")!);
  await view.findByLabelText("API_KEY");

  fireEvent.click(view.getByRole("button", { name: "Install" }));

  expect(await view.findByText("Required.")).toBeTruthy();
  expect(
    fetchMock.calls.some((call) => call.path.endsWith("/install")),
  ).toBe(false);
});
