import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { focusManager, onlineManager } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
} from "../test/auth-mock";
import { installFetchMock, type FetchMock } from "../test/harness";
import { createAppQueryClient } from "../lib/query-client";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

function renderApp(path = "/chat") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

/**
 * `focusManager.setFocused` only emits when the value CHANGES, so a refocus
 * is blur-then-focus. This is the same path a real `visibilitychange` takes.
 */
function refocus() {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

function reconnect() {
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
});

/**
 * The viewer is deliberately fresh for 30 s, and `refetchOnWindowFocus: true`
 * refetches only a STALE query (query-core 5.101.2 `shouldFetchOn`). So a
 * session revoked in another tab seconds after this tab last read it would
 * survive the very refocus that exists to notice it — and staleness alone
 * never schedules a request, so the signed-out shell could stay up
 * indefinitely. Only `"always"` closes that window.
 */
test("a refocus notices a session revoked elsewhere, even inside staleTime", async () => {
  signInToDemoWorkspace();
  const { router, view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  // Another tab signed out. This tab's viewer is still well inside its 30 s
  // staleTime, so nothing but an unconditional refocus fetch can see it.
  authMockState.session = null;
  refocus();

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});

test("a reconnect notices a session revoked elsewhere, even inside staleTime", async () => {
  signInToDemoWorkspace();
  const { router, view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  authMockState.session = null;
  reconnect();

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});

/**
 * The three-way contract has to hold for the LIVE observer too, not just for
 * initial navigation. A refocus that throws leaves `useViewer()` holding both
 * the previous viewer and an error; rendering the shell over that stale data
 * silently downgrades "couldn't ask" to "everything is fine".
 */
test("a refocus that cannot determine the session shows the retry card, not the shell", async () => {
  signInToDemoWorkspace();
  const { view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  authMockState.getSessionError = { status: 503, message: "unavailable" };
  refocus();

  expect(await view.findByText("Can't reach the server")).toBeTruthy();
  expect(view.queryByRole("navigation", { name: "Primary" })).toBeNull();
});

/**
 * A live viewer update can leave a signed-in user with workspaces but no
 * RESOLVABLE active workspace — the active organization was removed in
 * another tab. `beforeLoad` does not re-run without a navigation, so the
 * shell stayed up over a `WorkspaceGate` that could only show its defensive
 * empty state: stuck until a manual reload.
 */
test("a live viewer with workspaces but no active one re-enters the gate", async () => {
  signInToDemoWorkspace();
  const { view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  const activationsBefore = authMockState.setActiveCalls.length;
  // The active organization is gone; the user still has one workspace.
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: "org_gone" },
  };
  authMockState.organizations = [demoWorkspace()];
  refocus();

  await waitFor(() => {
    expect(authMockState.setActiveCalls.length).toBeGreaterThan(
      activationsBefore,
    );
  });
  await waitFor(() => {
    expect(authMockState.session?.session?.activeOrganizationId).toBe(
      "org_test_1",
    );
  });
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});

/**
 * The mirror case: no workspaces at all is NOT a stuck state, it is
 * first-run onboarding. It must not be mistaken for one that needs the gate.
 */
test("a live viewer that loses its last workspace lands on first-run onboarding", async () => {
  signInToDemoWorkspace();
  const { view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [];
  refocus();

  expect(await view.findByText("Create your workspace")).toBeTruthy();
});

/** A refocus for the same signed-in principal must change nothing on screen. */
test("a refocus that resolves the same viewer keeps the shell", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  const { router, view } = renderApp("/chat");
  await view.findByRole("navigation", { name: "Primary" });

  refocus();

  await waitFor(() => {
    expect(authMockState.getSessionCalls).toBeGreaterThan(1);
  });
  expect(view.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/chat");
});
