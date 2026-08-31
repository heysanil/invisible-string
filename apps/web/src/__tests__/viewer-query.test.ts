import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { beforeEach, expect, test } from "bun:test";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";

ensureDomForThisFile();
registerAuthMock();

const { fetchViewer, activeWorkspace, ViewerUnavailableError } = await import(
  "../lib/auth/viewer"
);

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
