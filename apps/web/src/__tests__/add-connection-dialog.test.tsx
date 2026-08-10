/**
 * Add-connection dialog (connectors redesign, plan-1 Task 11): the curated
 * catalog lane installs with one unified POST /connections; secret recipes
 * validate locally and send the typed secret exactly once; community search
 * installs via `{source:"registry"}`; and `search_unavailable` degrades to a
 * catalog-only state without ever blocking the curated tiles.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ConnectionDto, RegistrySearchResult } from "@invisible-string/shared";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { AddConnectionDialog } from "../components/context/AddConnectionDialog";

ensureDomForThisFile();

const NOW = "2026-08-09T00:00:00.000Z";

function connectionDto(over: Partial<ConnectionDto>): ConnectionDto {
  return {
    id: "cn_a1b2c3d4e5f6a7b8",
    scope: "workspace",
    name: "DeepWiki",
    description: null,
    source: "catalog",
    catalogSlug: "deepwiki",
    registryName: null,
    url: "https://mcp.deepwiki.com/mcp",
    transport: "streamable-http",
    authType: "none",
    hasCredentials: false,
    oauthStatus: null,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: null,
    enabled: true,
    health: "unknown",
    lastCheckedAt: null,
    lastError: null,
    tools: null,
    toolsCachedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

// Community-search wire shape ({results, total} from the Meilisearch mirror):
// secret prompts ride the chosen remote's header declarations.
const VAULT_RESULT: RegistrySearchResult = {
  name: "io.github.acme/vault",
  title: "Acme Vault",
  description: "Secrets and config for Acme services.",
  verified: false,
  remotes: [
    {
      type: "streamable-http",
      url: "https://mcp.acme.dev/mcp",
      headers: [{ name: "API_KEY", isRequired: true, isSecret: true }],
    },
  ],
};

const VERIFIED_RESULT: RegistrySearchResult = {
  name: "dev.acme/registry-notes",
  title: "Acme Notes",
  description: "Notes for Acme teams.",
  verified: true,
  remotes: [{ type: "streamable-http", url: "https://notes.acme.dev/mcp", headers: [] }],
};

const SECRET = "sk-live-super-secret-123";
const SCOPE = { scope: "workspace", workspaceId: "org_1" } as const;

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
  // The dialog reads the current scope's connections for its "Added" state.
  fetchMock.on("GET", "/connections", () => jsonResponse({ connections: [] }));
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

function postCalls() {
  return fetchMock.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/connections"),
  );
}

test("catalog tile with a no-auth recipe installs with exactly one {source:'catalog'} POST", async () => {
  fetchMock.on("POST", "/connections", () =>
    jsonResponse({ connection: connectionDto({}) }, 201),
  );

  const onClose = mock(() => {});
  const view = renderWithProviders(
    <AddConnectionDialog open onClose={onClose} scope={SCOPE} scopeLabel="workspace" />,
  );

  // The curated lane renders without any network round-trip.
  const tile = await view.findByText("DeepWiki");
  fireEvent.click(tile.closest("button")!);

  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });

  const posts = postCalls();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ source: "catalog", slug: "deepwiki" });
});

test("secret recipe validates before any request and sends the secret exactly once", async () => {
  fetchMock.on("POST", "/connections", () =>
    jsonResponse(
      {
        connection: connectionDto({
          name: "Context7",
          catalogSlug: "context7",
          url: "https://mcp.context7.com/mcp",
          authType: "headers",
          hasCredentials: true,
        }),
      },
      201,
    ),
  );

  const onClose = mock(() => {});
  const view = renderWithProviders(
    <AddConnectionDialog open onClose={onClose} scope={SCOPE} scopeLabel="workspace" />,
  );

  const tile = await view.findByText("Context7");
  fireEvent.click(tile.closest("button")!);

  // The recipe's secret header renders as a password field.
  const secretField = (await view.findByLabelText("CONTEXT7_API_KEY")) as HTMLInputElement;
  expect(secretField.type).toBe("password");

  // Submitting without the secret never leaves the browser.
  fireEvent.click(view.getByRole("button", { name: "Connect" }));
  expect(await view.findByText("Required.")).toBeTruthy();
  expect(postCalls()).toHaveLength(0);

  fireEvent.input(secretField, { target: { value: SECRET } });
  fireEvent.click(view.getByRole("button", { name: "Connect" }));

  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });

  const posts = postCalls();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({
    source: "catalog",
    slug: "context7",
    auth: { type: "headers", values: { CONTEXT7_API_KEY: SECRET } },
  });

  // After the flow completes the secret is nowhere in the DOM.
  expect(view.queryByDisplayValue(SECRET)).toBeNull();
  expect(document.body.textContent).not.toContain(SECRET);
});

test("community search result installs via {source:'registry'} with the remote's declared secret", async () => {
  fetchMock
    .on("GET", "/mcp-registry/search", () =>
      jsonResponse({ results: [VERIFIED_RESULT, VAULT_RESULT], total: 2 }),
    )
    .on("POST", "/connections", () =>
      jsonResponse(
        {
          connection: connectionDto({
            name: "Acme Vault",
            source: "registry",
            catalogSlug: null,
            registryName: "io.github.acme/vault",
            url: "https://mcp.acme.dev/mcp",
            authType: "headers",
            hasCredentials: true,
          }),
        },
        201,
      ),
    );

  const onClose = mock(() => {});
  const view = renderWithProviders(
    <AddConnectionDialog open onClose={onClose} scope={SCOPE} scopeLabel="workspace" />,
  );

  fireEvent.input(view.getByLabelText("Search connectors"), {
    target: { value: "acme" },
  });

  // Results appear after the debounce + query resolve; verified servers are
  // badged, unverified ones are not.
  const card = await view.findByText("Acme Vault", {}, { timeout: 2000 });
  expect(view.getByText("Verified")).toBeTruthy();

  fireEvent.click(card.closest("button")!);

  const secretField = (await view.findByLabelText("API_KEY")) as HTMLInputElement;
  expect(secretField.type).toBe("password");
  fireEvent.input(secretField, { target: { value: SECRET } });
  fireEvent.click(view.getByRole("button", { name: "Connect" }));

  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });

  const posts = postCalls();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({
    source: "registry",
    registryName: "io.github.acme/vault",
    remoteUrl: "https://mcp.acme.dev/mcp",
    auth: { type: "headers", values: { API_KEY: SECRET } },
  });
  expect(document.body.textContent).not.toContain(SECRET);
});

test("search_unavailable renders the degraded state while catalog tiles stay interactive", async () => {
  fetchMock.on("GET", "/mcp-registry/search", () =>
    jsonResponse(
      {
        error: {
          code: "search_unavailable",
          message: "community search is unavailable",
        },
      },
      503,
    ),
  );

  const view = renderWithProviders(
    <AddConnectionDialog open onClose={() => {}} scope={SCOPE} scopeLabel="workspace" />,
  );

  // "context" matches the curated Context7 entry client-side.
  fireEvent.input(view.getByLabelText("Search connectors"), {
    target: { value: "context" },
  });

  // Degraded state — not a blocking error pane.
  await view.findByText(/community search is unavailable/i, {}, { timeout: 2000 });

  // The pinned catalog match is still fully usable.
  const tile = view.getByText("Context7");
  fireEvent.click(tile.closest("button")!);
  expect(await view.findByLabelText("CONTEXT7_API_KEY")).toBeTruthy();
});

test("custom lane still validates against the shared schema before POSTing {source:'custom'}", async () => {
  fetchMock.on("POST", "/connections", () =>
    jsonResponse(
      {
        connection: connectionDto({
          name: "CMS",
          source: "custom",
          catalogSlug: null,
          url: "https://cms.example.com/mcp",
        }),
      },
      201,
    ),
  );

  const onClose = mock(() => {});
  const view = renderWithProviders(
    <AddConnectionDialog open onClose={onClose} scope={SCOPE} scopeLabel="workspace" />,
  );

  fireEvent.click(await view.findByText("Add a custom server"));

  // Invalid submit is caught by the shared create schema — nothing is sent.
  fireEvent.click(view.getByRole("button", { name: "Add connection" }));
  await waitFor(() => {
    const nameField = view.getByLabelText("Connection name") as HTMLInputElement;
    expect(nameField.getAttribute("aria-invalid")).toBe("true");
  });
  expect(postCalls()).toHaveLength(0);

  fireEvent.input(view.getByLabelText("Connection name"), {
    target: { value: "CMS" },
  });
  fireEvent.input(view.getByLabelText("Server URL"), {
    target: { value: "https://cms.example.com/mcp" },
  });
  fireEvent.click(view.getByRole("button", { name: "Add connection" }));

  await waitFor(() => {
    expect(onClose).toHaveBeenCalled();
  });

  const posts = postCalls();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({
    source: "custom",
    name: "CMS",
    url: "https://cms.example.com/mcp",
  });
});
