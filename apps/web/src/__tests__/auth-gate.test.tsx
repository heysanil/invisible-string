import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
  type AnyRouter,
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

/**
 * Every route id that ever COMMITTED, sampled on each router lifecycle event.
 *
 * `router.state.matches` only shows the settled set, which is identical
 * whether the gate redirected or `AppLayout` did it in render — so a
 * post-hoc pathname assertion cannot tell the two apart. A route that
 * commits shows up here; one the gate turned away never does.
 */
function trackCommittedRoutes(router: AnyRouter): Set<string> {
  const committed = new Set<string>();
  const record = () => {
    for (const match of router.state.matches) committed.add(match.routeId);
  };
  router.subscribe("onBeforeRouteMount", record);
  router.subscribe("onRendered", record);
  router.subscribe("onResolved", record);
  record();
  return committed;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

/**
 * The GATE must be what turns a signed-out visitor away — not `AppLayout`'s
 * render-time <Navigate>, which produces the same final pathname. Two
 * assertions pin that down: `/_app` never commits at all, and the login URL
 * carries the redirect the gate builds from `location.href` (the render-time
 * fallback carries no search at all).
 */
test("a signed-out visitor to a protected route lands on /login", async () => {
  authMockState.session = null;
  const { router } = renderApp("/chat");
  const committed = trackCommittedRoutes(router);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  expect([...committed]).not.toContain("/_app");
  expect(router.state.location.search).toEqual({ redirect: "/chat" });
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
  expect(
    authMockState.setActiveCalls.map((call) => call["organizationId"]),
  ).toContain("org_test_1");
  expect(authMockState.session?.session?.activeOrganizationId).toBe("org_test_1");
});

/**
 * Activation must be AWAITED, not raced. A mock that mutates its session
 * synchronously and hands back an already-resolved promise satisfies the
 * same assertions whether or not `beforeLoad` awaits it, so activation is
 * parked on a deferred promise here: the route must not commit until it
 * resolves. Without the `await`, `/_app` commits immediately and its layout
 * paints over a session that has no workspace selected yet.
 */
test("the gate does not commit the route until activation resolves", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  const gate = deferred();
  authMockState.setActiveGate = gate.promise;

  const { router, view } = renderApp("/chat");
  const committed = trackCommittedRoutes(router);

  await waitFor(() => {
    expect(authMockState.setActiveCalls).toHaveLength(1);
  });
  expect([...committed]).not.toContain("/_app");
  expect(view.queryByRole("navigation", { name: "Primary" })).toBeNull();

  gate.resolve();

  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});

/**
 * The session can die during activation's own viewer re-read. The gate must
 * redirect while `location.href` is still the page the user asked for —
 * committing and letting the render-time <Navigate> handle it loses the
 * redirect, so signing back in drops them on /chat instead.
 */
test("a session that dies during activation redirects with the target preserved", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSetActive = null;

  const { router } = renderApp("/settings/members");
  const committed = trackCommittedRoutes(router);

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  expect(router.state.location.search).toEqual({
    redirect: "/settings/members",
  });
  expect([...committed]).not.toContain("/_app");
});

/**
 * A 200 from set-active that does not stick is not a shell we may commit:
 * WorkspaceGate would have nothing to resolve. It has to fail visibly.
 */
test("an activation that does not stick shows the retry card", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  // set-active answers 200 but the session still carries no active workspace.
  authMockState.sessionAfterSetActive = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };

  const { view } = renderApp("/chat");
  expect(await view.findByText("Can't reach the server")).toBeTruthy();
});

/**
 * A 401 from set-active is definitive: the session expired between the viewer
 * read and this call. Wrapping it as an activation failure showed "Can't
 * reach the server" to a user who only needs to sign in again.
 */
test("a 401 during activation sends the user to login, not the retry card", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  authMockState.setActiveResult = {
    data: null,
    error: { status: 401, message: "UNAUTHORIZED" },
  };

  const { router, view } = renderApp("/chat");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  expect(view.queryByText("Can't reach the server")).toBeNull();
});

/** A rejected set-active is transport, not an answer: undetermined. */
test("a rejected activation shows the retry card, never a login bounce", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  authMockState.rejectSetActive = true;

  const { router, view } = renderApp("/chat");
  expect(await view.findByText("Can't reach the server")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/chat");
});

test("a fully signed-in viewer renders the shell", async () => {
  signInToDemoWorkspace();
  // A positive assertion, never `queryBy…` to be null — an absent element is
  // also absent mid-transition, so a negative-only assertion passes vacuously.
  const { view } = renderApp("/chat");
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});

test("clicking Try again on the retry card recovers into the shell", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  const { view } = renderApp("/chat");
  await view.findByText("Can't reach the server");

  // The server is reachable now; the click must be what re-runs the gate —
  // nothing else in this test drives a refetch.
  authMockState.getSessionError = null;
  signInToDemoWorkspace();
  fireEvent.click(view.getByRole("button", { name: "Try again" }));

  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
});

test("a non-viewer error under /_app renders the generic error state, never the network copy", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: null },
  };
  authMockState.organizations = [demoWorkspace()];
  // A malformed organization list: not the array `toWorkspaces` expects, so
  // it throws a raw TypeError from OUTSIDE every deliberate error class —
  // neither ViewerUnavailableError nor ActivateWorkspaceError. Stands in for
  // I1's concrete scenario (an unrelated render crash under /_app): both
  // reach the SAME errorComponent boundary, so this exercises the same
  // discrimination.
  //
  // It deliberately no longer uses a malformed `setActive` response: a
  // rejected activation is now wrapped as ActivateWorkspaceError on purpose
  // (the session may genuinely be unreachable), so that provocation would be
  // testing the opposite of what this case is for.
  authMockState.organizations =
    "not-an-array" as unknown as typeof authMockState.organizations;

  const { view } = renderApp("/chat");
  expect(await view.findByText("Something went wrong")).toBeTruthy();
  expect(view.queryByText("Can't reach the server")).toBeNull();
});
