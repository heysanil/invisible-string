/**
 * Connection detail slide-over (connectors redesign spec §10, plan-2 Task 4):
 * every section renders from a full DTO; "Test connection" fires exactly one
 * probe POST and re-renders the returned health; a rename 409 surfaces inline
 * and keeps the field editable; auth rotation sends the secret exactly once
 * (one-shot form). The delete-in-use blocker lives in
 * mcp-delete-blocker.test.tsx.
 *
 * The OAuth panel additionally carries the 2026-08-31 fix plan's SPA half:
 * F3 (a server-supplied authorization URL that is not https is refused, never
 * navigated to), F9 (the callback's sanitized `reason` — and a start route's
 * `ApiError.code` — become specific, actionable copy instead of one generic
 * "authorization failed"), and the grant/health PAIRING: `oauthStatus` and
 * `health` are two different columns, and a reader must never be left with
 * "Connected" beside a 401 and no sentence reconciling them.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ConnectionDto } from "@invisible-string/shared";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { API_BASE_URL } from "../lib/api-client";
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
// Captured per-test: `window` only exists between this file's DOM hooks.
let realWindowOpen: typeof window.open;

beforeEach(() => {
  realWindowOpen = window.open;
  fetchMock = installFetchMock();
});

afterEach(() => {
  window.open = realWindowOpen;
  fetchMock.restore();
  cleanup();
});

/** Minimal stand-in for the consent popup window the oauth flow drives. */
function fakePopup() {
  const popup = {
    closed: false,
    href: "",
    location: {
      replace(url: string) {
        popup.href = url;
      },
    },
    close() {
      popup.closed = true;
    },
  };
  return popup;
}

/** A catalog oauth connection in the given grant state. */
function oauthDto(
  status: NonNullable<ConnectionDto["oauthStatus"]>,
  over: Partial<ConnectionDto> = {},
): ConnectionDto {
  return connectionDto({
    source: "catalog",
    catalogSlug: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    authType: "oauth",
    // Only a `connected` grant can present a credential (fix plan F10).
    hasCredentials: status === "connected",
    oauthStatus: status,
    ...over,
  });
}

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

test("oauth pending shows Connect; the popup outcome refetches into the connected shield", async () => {
  const popup = fakePopup();
  window.open = mock(() => popup as unknown as Window) as unknown as typeof window.open;

  let current = oauthDto("pending");
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: current }))
    .on("POST", `/connections/${ID}/oauth/start`, () =>
      jsonResponse({ authorizeUrl: "https://as.example.com/authorize?state=s1" }),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  // The oauth auth panel offers Connect — no credential-rotation affordance.
  const connect = await view.findByRole("button", { name: "Connect" });
  expect(view.queryByRole("button", { name: "Rotate credentials" })).toBeNull();

  fireEvent.click(connect);
  await waitFor(() => {
    expect(popup.href).toBe("https://as.example.com/authorize?state=s1");
  });

  // Callback success → the detail refetches and renders the connected shield.
  current = oauthDto("connected");
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "mcp-oauth", ok: true, connectionId: ID },
      origin: new URL(API_BASE_URL).origin,
    }),
  );

  expect(await view.findByText("Connected")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
  const starts = fetchMock.calls.filter(
    (call) =>
      call.method === "POST" && call.path.endsWith(`/connections/${ID}/oauth/start`),
  );
  expect(starts).toHaveLength(1);
});

test("oauth expired shows the reconnect affordance", async () => {
  fetchMock.on("GET", `/connections/${ID}`, () =>
    jsonResponse({ connection: oauthDto("expired") }),
  );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  expect(await view.findByRole("button", { name: "Reconnect" })).toBeTruthy();
  expect(view.getByText(/expired/i)).toBeTruthy();
});

test("a non-https authorize URL is refused, never navigated to (F3)", async () => {
  const popup = fakePopup();
  window.open = mock(() => popup as unknown as Window) as unknown as typeof window.open;

  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: oauthDto("pending") }))
    // `startOauthResponseSchema` is `z.url()`, which happily accepts
    // `javascript:` — the wire contract is no defence here, the SPA is.
    .on("POST", `/connections/${ID}/oauth/start`, () =>
      jsonResponse({ authorizeUrl: "javascript:fetch('/steal')" }),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Connect" }));

  expect(await view.findByText(/unsafe sign-in address/i)).toBeTruthy();
  // The popup inherits this origin — it must never have been navigated.
  expect(popup.href).toBe("");
  expect(popup.closed).toBe(true);
});

test("a failed callback renders the reason's own copy, not a generic failure (F9)", async () => {
  const popup = fakePopup();
  window.open = mock(() => popup as unknown as Window) as unknown as typeof window.open;

  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: oauthDto("pending") }))
    .on("POST", `/connections/${ID}/oauth/start`, () =>
      jsonResponse({ authorizeUrl: "https://as.example.com/authorize?state=s1" }),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Connect" }));
  await waitFor(() => {
    expect(popup.href).toBe("https://as.example.com/authorize?state=s1");
  });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "mcp-oauth",
        ok: false,
        connectionId: ID,
        reason: "oauth_state_invalid",
      },
      origin: new URL(API_BASE_URL).origin,
    }),
  );

  expect(await view.findByText(/expired or was already used/i)).toBeTruthy();
  // The raw machine code never reaches the reader.
  expect(view.queryByText(/oauth_state_invalid/)).toBeNull();
});

test("a start failure explains a refused client registration (F9)", async () => {
  const popup = fakePopup();
  window.open = mock(() => popup as unknown as Window) as unknown as typeof window.open;

  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: oauthDto("pending") }))
    .on("POST", `/connections/${ID}/oauth/start`, () =>
      jsonResponse(
        {
          error: {
            code: "oauth_registration_failed",
            message: "dynamic client registration failed (HTTP 400: invalid_redirect_uri)",
          },
        },
        502,
      ),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Connect" }));

  expect(await view.findByText(/only accepts pre-approved clients/i)).toBeTruthy();
  expect(popup.closed).toBe(true);
});

test("a connected grant with auth_required health asks for re-authorization", async () => {
  fetchMock.on("GET", `/connections/${ID}`, () =>
    jsonResponse({
      connection: oauthDto("connected", { health: "auth_required", lastError: null }),
    }),
  );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  // Both columns are told honestly, and one sentence reconciles them.
  expect(await view.findByText(/no longer accepting this authorization/i)).toBeTruthy();
  expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  // "Connected" beside a 401 with nothing else said is the bug; a bare
  // "Authorization failed" is the opposite error — neither may appear.
  expect(view.queryByText("Authorization failed. Reconnect to try again.")).toBeNull();
});

test("a pending grant reads as awaiting authorization and is not probed", async () => {
  fetchMock.on("GET", `/connections/${ID}`, () =>
    jsonResponse({
      // What P1.2 leaves behind: created, never probed, no grant yet.
      connection: oauthDto("pending", { health: "unknown", lastCheckedAt: null }),
    }),
  );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  expect(await view.findByText(/first health check runs once/i)).toBeTruthy();
  // A grant with no token cannot be probed into anything but `auth_required`,
  // so opening the detail must not spend a write to re-learn that.
  await waitFor(() => {
    expect(view.getByRole("button", { name: "Connect" })).toBeTruthy();
  });
  expect(probeCalls()).toHaveLength(0);
});

test("a loopback http authorize URL is still allowed (local stacks, e2e)", async () => {
  const popup = fakePopup();
  window.open = mock(() => popup as unknown as Window) as unknown as typeof window.open;

  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: oauthDto("pending") }))
    .on("POST", `/connections/${ID}/oauth/start`, () =>
      jsonResponse({ authorizeUrl: "http://127.0.0.1:9411/authorize?state=s1" }),
    );

  const view = renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Connect" }));

  // The scheme guard draws the browser's own secure-context line: tightening
  // it to https-only would silently break every local stack and the e2e stub
  // authorization server, which speaks http on loopback.
  await waitFor(() => {
    expect(popup.href).toBe("http://127.0.0.1:9411/authorize?state=s1");
  });
});
