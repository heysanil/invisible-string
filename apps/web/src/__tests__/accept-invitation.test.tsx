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
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import { installFetchMock, jsonResponse, type FetchMock } from "../test/harness";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

const INVITATION = {
  id: "inv_1",
  email: "demo@example.com",
  role: "member",
  status: "pending",
  organizationId: "org_test_1",
  organizationName: "Acme",
  organizationSlug: "acme",
  inviterId: "u_owner",
  inviterEmail: "owner@acme.dev",
  expiresAt: "2026-07-10T00:00:00.000Z",
  createdAt: "2026-07-08T00:00:00.000Z",
};

function renderInvite() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/accept-invitation/inv_1"],
    }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
  fetchMock.on("GET", /.*/, () => jsonResponse([]));
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("signed-out visitors are sent to login carrying the redirect", async () => {
  const { router } = renderInvite();
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  expect(router.state.location.search).toEqual({
    redirect: "/accept-invitation/inv_1",
  });
});

test("a pending invitation renders workspace, inviter, and role", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  const { view } = renderInvite();
  expect(await view.findByText("Join Acme")).toBeTruthy();
  expect(view.getByText(/owner@acme\.dev/)).toBeTruthy();
  expect(view.getByText("member")).toBeTruthy();
  expect(authMockState.getInvitationCalls[0]).toEqual({
    query: { id: "inv_1" },
  });
});

test("accepting joins, activates the workspace, and lands in the shell", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  const { router, view } = renderInvite();
  await view.findByText("Join Acme");
  fireEvent.click(view.getByRole("button", { name: /accept invitation/i }));
  await waitFor(() => {
    expect(authMockState.acceptInvitationCalls.length).toBe(1);
  });
  expect(authMockState.acceptInvitationCalls[0]).toEqual({
    invitationId: "inv_1",
  });
  await waitFor(() => {
    expect(authMockState.setActiveCalls.length).toBeGreaterThanOrEqual(1);
  });
  expect(authMockState.setActiveCalls).toContainEqual({
    organizationId: "org_test_1",
  });
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
  // The org LIST is stale after acceptance (no $listOrg refetch) but the
  // active org is set — the _app gate must show the shell, not onboarding.
  expect(
    await view.findByRole("navigation", { name: "Primary" }),
  ).toBeTruthy();
});

test("declining rejects the invitation and shows the declined state", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  const { view } = renderInvite();
  await view.findByText("Join Acme");
  fireEvent.click(view.getByRole("button", { name: /^decline$/i }));
  await waitFor(() => {
    expect(authMockState.rejectInvitationCalls.length).toBe(1);
  });
  expect(await view.findByText("Invitation declined")).toBeTruthy();
});

test("a 403 shows the wrong-account state with a sign-out action", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = {
    data: null,
    error: { message: "not the recipient", status: 403 },
  };
  const { view } = renderInvite();
  expect(
    await view.findByText("This invitation belongs to another account"),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: /sign out/i })).toBeTruthy();
});

test("a 400 shows the no-longer-valid state", async () => {
  authMockState.session = demoSession();
  // Default getInvitationResult is already the 400 "Invitation not found!".
  const { view } = renderInvite();
  expect(
    await view.findByText("This invitation is no longer valid"),
  ).toBeTruthy();
});
