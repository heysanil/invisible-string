import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { createAppQueryClient } from "../lib/query-client";
import {
  authMockState,
  demoSession,
  demoWorkspace,
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
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
  focusManager.setFocused(true);
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
  expect(
    authMockState.setActiveCalls.map((call) => call["organizationId"]),
  ).toContain("org_test_1");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
  // The org LIST is stale after acceptance (no $listOrg refetch) but the
  // active org is set — the _app gate must show the shell, not onboarding.
  expect(
    await view.findByRole("navigation", { name: "Primary" }),
  ).toBeTruthy();
});

test("a failed workspace switch after accepting is reported honestly", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  authMockState.setActiveResult = {
    data: null,
    error: { message: "boom", status: 500 },
  };
  const { router, view } = renderInvite();
  await view.findByText("Join Acme");
  fireEvent.click(view.getByRole("button", { name: /accept invitation/i }));
  expect(
    await view.findByText("Joined Acme, but couldn't switch to it."),
  ).toBeTruthy();
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
});

/**
 * Acceptance is a COMMIT POINT: the invitation is consumed and the membership
 * exists. Anything that fails afterwards must never route the user back to a
 * state whose only recovery re-reads the invitation — the retry would fetch a
 * consumed invitation and report "no longer valid", stranding a user who is
 * already a member. Same partial-success principle as login.tsx,
 * signup.tsx, and CreateWorkspaceScreen.tsx.
 */
test("a viewer refresh that fails after accepting never blames the invitation", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  const { view } = renderInvite();
  await view.findByText("Join Acme");

  // The membership lands, then the follow-up viewer read hits a transient 503.
  authMockState.acceptInvitationCalls = [];
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  fireEvent.click(view.getByRole("button", { name: /accept invitation/i }));

  expect(await view.findByText("Joined Acme")).toBeTruthy();
  expect(view.queryByText("Can't load this invitation")).toBeNull();
  expect(view.queryByText("This invitation is no longer valid")).toBeNull();

  // The recovery re-reads the SESSION, never the consumed invitation.
  const invitationReads = authMockState.getInvitationCalls.length;
  authMockState.getSessionError = null;
  fireEvent.click(view.getByRole("button", { name: /try again/i }));

  await waitFor(() => {
    expect(
      view.queryByRole("navigation", { name: "Primary" }),
    ).toBeTruthy();
  });
  expect(authMockState.getInvitationCalls.length).toBe(invitationReads);
  expect(authMockState.acceptInvitationCalls).toHaveLength(1);
});

/**
 * The commit-point protection above stops the invitation effect from
 * re-firing when the SAME retry click drives a viewer read. But
 * `refetchOnWindowFocus: "always"` (viewer.ts) means ANY refocus refetches
 * the viewer unconditionally, even while its data is still well inside the
 * 30s staleTime — a background tab and a returning network, not a race. If
 * that refetch's payload genuinely differs (the newly-joined org now shows
 * up in `organization.list`), `query.data` gets a new identity, and without
 * a guard tied to the commit point itself (not just to the in-flight retry)
 * the invitation-fetch effect re-enters, re-reads the now-CONSUMED
 * invitation, and the server's 400 replaces the joined card with "This
 * invitation is no longer valid" — stranding a user who already joined.
 */
test("a post-commit refocus never re-reads the consumed invitation", async () => {
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  const { view } = renderInvite();
  await view.findByText("Join Acme");

  // Membership lands, then activateWorkspace's own internal viewer refetch
  // hits a transient 503 — same setup as the retry test above, just without
  // clicking "Try again" afterward.
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  fireEvent.click(view.getByRole("button", { name: /accept invitation/i }));
  expect(await view.findByText("Joined Acme")).toBeTruthy();
  expect(
    await view.findByText(
      "You're a member — we just couldn't open the workspace",
    ),
  ).toBeTruthy();

  // The server recovers, and the join is now visible in the org list — a
  // genuinely different payload, not one query-core's structural sharing
  // would collapse back to the same reference. The invitation itself is
  // consumed server-side, so re-reading it now returns the real 400.
  authMockState.getSessionError = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.getInvitationResult = {
    data: null,
    error: { message: "Invitation not found!", status: 400 },
  };
  const sessionCallsBefore = authMockState.getSessionCalls;
  const invitationReads = authMockState.getInvitationCalls.length;

  focusManager.setFocused(false);
  focusManager.setFocused(true);

  await waitFor(() => {
    expect(authMockState.getSessionCalls).toBeGreaterThan(sessionCallsBefore);
  });

  expect(view.getByText("Joined Acme")).toBeTruthy();
  expect(view.queryByText("This invitation is no longer valid")).toBeNull();
  expect(authMockState.getInvitationCalls.length).toBe(invitationReads);
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

test("an undetermined session shows the retry card, not a login bounce", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { router, view } = renderInvite();
  expect(await view.findByText("Can't load this invitation")).toBeTruthy();
  expect(router.state.location.pathname).toContain("/accept-invitation/");
});

test("Try again recovers once the server answers", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { view } = renderInvite();
  await view.findByText("Can't load this invitation");

  // The retry must drop the CACHED error, not just re-run an effect.
  authMockState.getSessionError = null;
  authMockState.session = demoSession();
  authMockState.getInvitationResult = { data: INVITATION, error: null };
  fireEvent.click(view.getByRole("button", { name: /try again/i }));
  expect(await view.findByText("Join Acme")).toBeTruthy();
});
