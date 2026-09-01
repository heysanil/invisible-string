import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import {
  installFetchMock,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";

ensureDomForThisFile();
registerAuthMock();

const { WorkspaceGate } = await import("../components/WorkspaceGate");

// renderWithProviders already supplies an isolated QueryClient and the
// ToastProvider (test/harness.tsx) — do not hand-roll another one.
function renderGate() {
  return renderWithProviders(
    <WorkspaceGate title="Members">
      {({ workspaceName }) => <p>ws:{workspaceName}</p>}
    </WorkspaceGate>,
  );
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

test("a resolved workspace is handed to children", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  const view = renderGate();
  expect(await view.findByText("ws:Acme")).toBeTruthy();
});

test("a signed-in user with no workspace sees the empty state", async () => {
  authMockState.session = {
    user: { id: "u_new", email: "new@example.com", name: "New" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [];
  const view = renderGate();
  expect(await view.findByText("No workspace yet")).toBeTruthy();
});

/** An outage must not masquerade as "you have no workspaces". */
test("an undetermined session shows an error state, not the empty state", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const view = renderGate();
  expect(await view.findByText("Can't load your workspace")).toBeTruthy();
  expect(view.queryByText("No workspace yet")).toBeNull();
});

test("Try again retries the viewer query and recovers into the workspace", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const view = renderGate();
  await view.findByText("Can't load your workspace");

  // The server is reachable now; the click must be what re-runs the query —
  // nothing else in this test drives a refetch.
  authMockState.getSessionError = null;
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  fireEvent.click(view.getByRole("button", { name: "Try again" }));

  expect(await view.findByText("ws:Acme")).toBeTruthy();
});
