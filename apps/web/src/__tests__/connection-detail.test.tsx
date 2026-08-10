/**
 * Connection detail slide-over (connectors redesign spec §10, plan-2 Task 4):
 * every section renders from a full DTO; "Test connection" fires exactly one
 * probe POST and re-renders the returned health; a rename 409 surfaces inline
 * and keeps the field editable; auth rotation sends the secret exactly once
 * (one-shot form). The delete-in-use blocker lives in
 * mcp-delete-blocker.test.tsx.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ConnectionDto } from "@invisible-string/shared";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { ConnectionDetail } from "../components/context/ConnectionDetail";

ensureDomForThisFile();

const SCOPE = { scope: "workspace", workspaceId: "org_1" } as const;
const ID = "cn_a1b2c3d4e5f6a7b8";
const SECRET = "sk-live-rotated-secret-9";

/** Recent lastCheckedAt so the stale auto re-probe never fires in tests. */
function freshCheck(): string {
  return new Date().toISOString();
}

function connectionDto(over: Partial<ConnectionDto>): ConnectionDto {
  return {
    id: ID,
    scope: "workspace",
    name: "Acme Vault",
    description: "Secrets and config for Acme services.",
    source: "custom",
    catalogSlug: null,
    registryName: null,
    url: "https://mcp.acme.dev/mcp",
    transport: "streamable-http",
    authType: "bearer",
    hasCredentials: true,
    oauthStatus: null,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: { default: "never" },
    enabled: true,
    health: "ok",
    lastCheckedAt: freshCheck(),
    lastError: null,
    tools: [
      { name: "save_note", description: "Save a note", params: ["title", "body"] },
      { name: "list_notes", description: "List notes", params: [] },
    ],
    toolsCachedAt: freshCheck(),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...over,
  };
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

function probeCalls() {
  return fetchMock.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith(`/connections/${ID}/probe`),
  );
}

function patchCalls() {
  return fetchMock.calls.filter(
    (call) => call.method === "PATCH" && call.path.endsWith(`/connections/${ID}`),
  );
}

test("renders every section from a full DTO", async () => {
  fetchMock.on("GET", `/connections/${ID}`, () =>
    jsonResponse({ connection: connectionDto({}) }),
  );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  // Identity
  expect(await view.findByLabelText("Name")).toBeTruthy();
  expect(view.getByLabelText("Description")).toBeTruthy();
  // Endpoint (custom → editable URL + transport)
  expect(view.getByText("Endpoint")).toBeTruthy();
  expect((view.getByLabelText("Server URL") as HTMLInputElement).value).toBe(
    "https://mcp.acme.dev/mcp",
  );
  expect(view.getByLabelText("Transport")).toBeTruthy();
  // Auth panel
  expect(view.getByText("Authentication")).toBeTruthy();
  expect(view.getByText("Bearer token")).toBeTruthy();
  expect(view.getByText("Credentials stored")).toBeTruthy();
  expect(view.getByRole("button", { name: "Rotate credentials" })).toBeTruthy();
  // Tool policy
  expect(view.getByText("Tool policy")).toBeTruthy();
  // Approvals: default select + per-tool overrides from the cached tools
  expect(view.getByText("Approvals")).toBeTruthy();
  expect(view.getByLabelText("Default approval")).toBeTruthy();
  expect(view.getByText("save_note")).toBeTruthy();
  expect(view.getByText("list_notes")).toBeTruthy();
  // Health panel
  expect(view.getByText("Health")).toBeTruthy();
  expect(view.getByText("Healthy")).toBeTruthy();
  expect(view.getByRole("button", { name: "Test connection" })).toBeTruthy();
  // Danger zone
  expect(view.getByText("Danger zone")).toBeTruthy();
  expect(view.getByRole("button", { name: "Remove connection" })).toBeTruthy();

  // Fresh lastCheckedAt → the stale auto re-probe must NOT fire.
  expect(probeCalls()).toHaveLength(0);
});

test("Test connection fires exactly one POST and re-renders the returned health", async () => {
  let current = connectionDto({ health: "unreachable", lastError: "connect ECONNREFUSED" });
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: current }))
    .on("POST", `/connections/${ID}/probe`, () => {
      current = connectionDto({ health: "ok", lastError: null });
      return jsonResponse({ connection: current });
    });

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  expect(await view.findByText("Unreachable")).toBeTruthy();
  expect(view.getByText("connect ECONNREFUSED")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Test connection" }));

  expect(await view.findByText("Healthy")).toBeTruthy();
  expect(probeCalls()).toHaveLength(1);
});

test("stale lastCheckedAt auto-probes exactly once on open", async () => {
  let current = connectionDto({ health: "unknown", lastCheckedAt: null });
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: current }))
    .on("POST", `/connections/${ID}/probe`, () => {
      current = connectionDto({ health: "ok" });
      return jsonResponse({ connection: current });
    });

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  expect(await view.findByText("Healthy")).toBeTruthy();
  await waitFor(() => {
    expect(probeCalls()).toHaveLength(1);
  });
});

test("rename 409 shows the inline error and keeps the field editable", async () => {
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: connectionDto({}) }))
    .on("PATCH", `/connections/${ID}`, () =>
      jsonResponse(
        {
          error: {
            code: "duplicate_connection_name",
            message: 'a connection named "GitHub" already exists in this scope',
          },
        },
        409,
      ),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  const name = (await view.findByLabelText("Name")) as HTMLInputElement;
  fireEvent.input(name, { target: { value: "GitHub" } });
  fireEvent.click(view.getByRole("button", { name: "Save details" }));

  expect(
    await view.findByText('a connection named "GitHub" already exists in this scope'),
  ).toBeTruthy();
  expect(patchCalls()).toHaveLength(1);
  // The field stays editable for another attempt.
  const after = view.getByLabelText("Name") as HTMLInputElement;
  expect(after.disabled).toBe(false);
  expect(after.value).toBe("GitHub");
});

test("auth rotate sends the secret exactly once", async () => {
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: connectionDto({}) }))
    .on("PATCH", `/connections/${ID}`, () =>
      jsonResponse({ connection: connectionDto({}) }),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Rotate credentials" }));
  const token = view.getByLabelText("New token") as HTMLInputElement;
  expect(token.type).toBe("password");
  fireEvent.input(token, { target: { value: SECRET } });
  fireEvent.click(view.getByRole("button", { name: "Save credentials" }));

  // The one-shot form closes after success (the rotate entry point returns)…
  // NOTE: asserted via findByRole, not waitFor(queryBy… toBeNull) — an
  // explicit waitFor around this unmount panics bun 1.3.14 under happy-dom.
  await view.findByRole("button", { name: "Rotate credentials" });
  expect(view.queryByLabelText("New token")).toBeNull();
  // …and the secret crossed the wire exactly once.
  const secretPatches = patchCalls().filter((call) => {
    const body = call.body as { auth?: { type?: string; values?: { token?: string } } };
    return body.auth?.values?.token === SECRET;
  });
  expect(secretPatches).toHaveLength(1);
  expect(secretPatches[0]!.body).toEqual({
    auth: { type: "bearer", values: { token: SECRET } },
  });
});
