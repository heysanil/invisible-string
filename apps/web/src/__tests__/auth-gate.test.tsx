import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  authMockState,
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

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

test("a signed-out visitor to a protected route lands on /login", async () => {
  authMockState.session = null;
  const { router } = renderApp("/chat");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});

test("an undetermined session shows the retry card, never the login form", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { router, view } = renderApp("/chat");
  expect(await view.findByText("Can't reach the server")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/chat");
});

test("a signed-in viewer with no workspace gets first-run onboarding", async () => {
  authMockState.session = {
    user: { id: "u_new", email: "new@example.com", name: "New User" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [];
  const { view } = renderApp("/chat");
  expect(await view.findByText("Create your workspace")).toBeTruthy();
});

test("a signed-in viewer with an unset active workspace has one selected for them", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  const { view } = renderApp("/chat");
  // Assert the OUTCOME, not the call: the shell renders, which it only can
  // once the session actually carries an active workspace.
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(authMockState.setActiveCalls).toContainEqual({
    organizationId: "org_test_1",
  });
  expect(authMockState.session?.session?.activeOrganizationId).toBe("org_test_1");
});

test("a fully signed-in viewer renders the shell", async () => {
  signInToDemoWorkspace();
  // A positive assertion, never `queryBy…` to be null — an absent element is
  // also absent mid-transition, so a negative-only assertion passes vacuously.
  const { view } = renderApp("/chat");
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});
