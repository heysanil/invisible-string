/**
 * Workspace settings: rename-then-refresh, and sign-out.
 *
 * Both paths participate in principal-cache invalidation now (`completeSignOut`
 * clears the cache; the rename refreshes the viewer that names the workspace
 * everywhere), so they are exercised end to end through the real route rather
 * than asserted at the type level.
 */
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
import { installFetchMock, jsonResponse, type FetchMock } from "../test/harness";
import { createAppQueryClient } from "../lib/query-client";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

const MEMBERS = {
  members: [
    {
      id: "m_owner",
      userId: "u1",
      name: "Demo",
      email: "demo@example.com",
      role: "owner",
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  ],
};

function renderWorkspaceSettings() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/settings/workspace"],
    }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
  fetchMock.on("GET", /.*/, () => jsonResponse([]));
  fetchMock.on("GET", "/members", () => jsonResponse(MEMBERS));
});

afterEach(() => {
  cleanup();
  fetchMock.restore();
});

/** `Input` delivers onChange via onInput only — fireEvent.input, never change. */
function typeName(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
}

test("renaming saves and refreshes the viewer so the new name lands", async () => {
  signInToDemoWorkspace();
  const { view } = renderWorkspaceSettings();

  const input = await view.findByLabelText("Workspace name");
  typeName(input, "Umbrella");
  fireEvent.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(authMockState.updateOrganizationCalls).toHaveLength(1);
  });
  expect(authMockState.updateOrganizationCalls[0]).toEqual({
    organizationId: "org_test_1",
    data: { name: "Umbrella" },
  });

  // The refreshed viewer is what carries the new name back into the shell.
  await waitFor(() => {
    expect(
      (view.getByLabelText("Workspace name") as HTMLInputElement).value,
    ).toBe("Umbrella");
  });
  expect(await view.findByText("Workspace renamed.")).toBeTruthy();
});

/**
 * The rename has already landed server-side. A failed viewer refresh after it
 * must not be reported as a failed rename — same partial-success rule as
 * login.tsx and CreateWorkspaceScreen.tsx.
 */
test("a viewer refresh that fails after renaming still reports the rename", async () => {
  signInToDemoWorkspace();
  const { view } = renderWorkspaceSettings();

  const input = await view.findByLabelText("Workspace name");
  typeName(input, "Umbrella");
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  fireEvent.click(view.getByRole("button", { name: "Save" }));

  expect(await view.findByText("Workspace renamed.")).toBeTruthy();
  expect(view.queryByText("Could not rename the workspace.")).toBeNull();
});

test("a rejected rename is reported and the viewer is never refreshed", async () => {
  signInToDemoWorkspace();
  authMockState.updateOrganizationResult = {
    data: null,
    error: { status: 403, message: "Not allowed." },
  };
  const { view } = renderWorkspaceSettings();

  const input = await view.findByLabelText("Workspace name");
  typeName(input, "Umbrella");
  fireEvent.click(view.getByRole("button", { name: "Save" }));

  expect(await view.findByText("Not allowed.")).toBeTruthy();
  expect(view.queryByText("Workspace renamed.")).toBeNull();
});

// The cache-clearing half of sign-out is asserted directly, at the
// `completeSignOut` level, in viewer-principal.test.tsx; this test exercises
// only the redirect through the real route.
test("signing out redirects to /login", async () => {
  signInToDemoWorkspace();
  const { router, view } = renderWorkspaceSettings();

  const signOut = await view.findByRole("button", { name: "Sign out" });
  // The server drops the session the moment sign-out lands.
  authMockState.signOutResult = { data: null, error: null };
  authMockState.session = null;
  fireEvent.click(signOut);

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});

/**
 * Better Auth resolves HTTP failures as `{error}` rather than throwing, so an
 * unchecked `await signOut()` would send the user to /login with a live
 * session cookie. `completeSignOut` throws instead, and the panel must stay
 * put and say so.
 */
test("a failed sign-out keeps the user here and says so", async () => {
  signInToDemoWorkspace();
  authMockState.signOutResult = {
    data: null,
    error: { status: 500, message: "boom" },
  };
  const { router, view } = renderWorkspaceSettings();

  fireEvent.click(await view.findByRole("button", { name: "Sign out" }));

  expect(await view.findByText("Could not sign out. Try again.")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/settings/workspace");
  expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

test("a member without manage rights gets a read-only name field", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  fetchMock.on("GET", "/members", () =>
    jsonResponse({
      members: [{ ...MEMBERS.members[0], role: "member" }],
    }),
  );
  const { view } = renderWorkspaceSettings();

  expect(
    await view.findByText("Only owners and admins can rename the workspace."),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
});
