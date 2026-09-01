import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { beforeEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";

ensureDomForThisFile();
registerAuthMock();

const {
  activateWorkspace,
  ActivateWorkspaceError,
  activeWorkspace,
  AUTH_REQUEST_TIMEOUT_MS,
  fetchViewer,
  ViewerUnavailableError,
} = await import("../lib/auth/viewer");

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(resetAuthMock);

test("a null session resolves to null — definitively signed out", async () => {
  authMockState.session = null;
  expect(await fetchViewer()).toBeNull();
});

test("a 401 on the session call resolves to null, not an error", async () => {
  authMockState.getSessionError = { status: 401, message: "UNAUTHORIZED" };
  expect(await fetchViewer()).toBeNull();
});

test("a 401 on the org list resolves to null — the session died mid-flight", async () => {
  authMockState.session = demoSession();
  authMockState.listOrganizationsError = { status: 401, message: "UNAUTHORIZED" };
  expect(await fetchViewer()).toBeNull();
});

test("a 5xx throws rather than resolving to null", async () => {
  authMockState.getSessionError = { status: 503, message: "unavailable" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

test("a transport failure with no status throws", async () => {
  authMockState.getSessionError = { message: "network" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

/**
 * 403 is NOT signed out. Only 401 is. A forbidden answer means the session is
 * real but the request was refused, and collapsing it into "signed out" hands
 * a login form to somebody who is already logged in.
 */
test("a 403 on the session call throws rather than resolving to null", async () => {
  authMockState.getSessionError = { status: 403, message: "FORBIDDEN" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

test("a 403 on the org list throws rather than resolving to null", async () => {
  authMockState.session = demoSession();
  authMockState.listOrganizationsError = { status: 403, message: "FORBIDDEN" };
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

/**
 * Better Auth usually resolves failures as `{error}`, but `@better-fetch/fetch`
 * calls `await fetch(...)` with no try/catch — so a real transport failure
 * (DNS, offline, an abort) REJECTS. Both halves must land on undetermined.
 */
test("a rejected session promise throws ViewerUnavailableError", async () => {
  authMockState.rejectGetSession = true;
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

test("a rejected org-list promise throws ViewerUnavailableError", async () => {
  authMockState.session = demoSession();
  authMockState.rejectListOrganizations = true;
  await expect(fetchViewer()).rejects.toBeInstanceOf(ViewerUnavailableError);
});

/**
 * A proxy that ACCEPTS the request and never answers used to leave the router
 * gate pending forever: the protected route never committed, and the retry
 * card was unreachable because nothing threw. The bound must surface as
 * UNDETERMINED — never as signed out, which would show a login form to a user
 * whose session is fine.
 */
test("a session request that never answers times out as undetermined", async () => {
  authMockState.hangGetSession = true;
  await expect(fetchViewer({ timeoutMs: 20 })).rejects.toBeInstanceOf(
    ViewerUnavailableError,
  );
});

test("an org-list request that never answers times out as undetermined", async () => {
  authMockState.session = demoSession();
  authMockState.hangListOrganizations = true;
  await expect(fetchViewer({ timeoutMs: 20 })).rejects.toBeInstanceOf(
    ViewerUnavailableError,
  );
});

test("an activation that never answers times out rather than hanging the gate", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  authMockState.hangSetActive = true;
  await expect(
    activateWorkspace(makeClient(), "org_test_1", { timeoutMs: 20 }),
  ).rejects.toBeInstanceOf(ActivateWorkspaceError);
});

/** A rejected set-active is transport — wrapped, not left raw. */
test("a rejected activation is wrapped as ActivateWorkspaceError", async () => {
  authMockState.session = demoSession();
  authMockState.rejectSetActive = true;
  await expect(
    activateWorkspace(makeClient(), "org_test_1"),
  ).rejects.toBeInstanceOf(ActivateWorkspaceError);
});

/** A 401 during activation is definitive: signed out, not "server down". */
test("a 401 during activation resolves null rather than throwing", async () => {
  authMockState.session = demoSession();
  authMockState.setActiveResult = {
    data: null,
    error: { status: 401, message: "UNAUTHORIZED" },
  };
  expect(await activateWorkspace(makeClient(), "org_test_1")).toBeNull();
});

/**
 * Every auth call the gate depends on carries an AbortSignal by DEFAULT, not
 * only when a test passes a short bound. Without this, the timeout tests above
 * would still pass while production requests stayed unbounded.
 */
test("every auth call the gate depends on is bounded by default", async () => {
  expect(Number.isFinite(AUTH_REQUEST_TIMEOUT_MS)).toBe(true);
  expect(AUTH_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);

  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  await fetchViewer();
  await activateWorkspace(makeClient(), "org_test_1");

  expect(authMockState.getSessionSignals[0]).toBeInstanceOf(AbortSignal);
  expect(authMockState.listOrganizationsSignals[0]).toBeInstanceOf(AbortSignal);
  expect(authMockState.setActiveSignals[0]).toBeInstanceOf(AbortSignal);
});

test("a signed-in viewer carries the user, active id, and sorted workspaces", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [
    { id: "org_b", name: "Beta", slug: "beta", createdAt: "2026-07-09T00:00:00.000Z" },
    demoWorkspace(), // org_test_1, createdAt 2026-07-01
  ];
  const viewer = await fetchViewer();
  expect(viewer?.user.id).toBe("u1");
  expect(viewer?.activeWorkspaceId).toBe("org_test_1");
  expect(viewer?.workspaces.map((w) => w.id)).toEqual(["org_test_1", "org_b"]);
});

test("activeWorkspace resolves the active id against the list", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  const viewer = await fetchViewer();
  expect(activeWorkspace(viewer!)?.name).toBe("Acme");
});

test("activeWorkspace is null when the active id is not a workspace the user has", async () => {
  authMockState.session = {
    user: { id: "u1", email: "demo@example.com", name: "Demo" },
    session: { activeOrganizationId: "org_gone" },
  };
  authMockState.organizations = [demoWorkspace()];
  const viewer = await fetchViewer();
  expect(activeWorkspace(viewer!)).toBeNull();
});
