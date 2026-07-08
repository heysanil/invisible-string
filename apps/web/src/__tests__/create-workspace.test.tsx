import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  authMockState,
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
  type MockSessionData,
} from "../test/auth-mock";
import { installFetchMock, jsonResponse, type FetchMock } from "../test/harness";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

/** A signed-in session that belongs to no workspace yet. */
function zeroOrgSession(): MockSessionData {
  return {
    user: { id: "u_new", email: "new@example.com", name: "New User" },
    session: { activeOrganizationId: null },
  };
}

function renderApp(path = "/chat") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

function submitForm(view: RenderResult) {
  const button = view.getByRole("button", { name: /create workspace/i });
  const form = button.closest("form");
  if (!form) throw new Error("create-workspace form not found");
  fireEvent.submit(form);
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
  // Workspace-scoped screens fetch on mount once a workspace exists;
  // empty collections are fine — the shell chrome is what we assert on.
  fetchMock.on("GET", /.*/, () => jsonResponse([]));
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("zero-org session sees the first-run screen instead of the shell", async () => {
  authMockState.session = zeroOrgSession();
  const { view } = renderApp();
  expect(await view.findByText("Create your workspace")).toBeTruthy();
  expect(view.queryByRole("navigation", { name: "Primary" })).toBeNull();
});

test("sessions with a workspace never see onboarding", async () => {
  signInToDemoWorkspace();
  const { view } = renderApp();
  expect(
    await view.findByRole("navigation", { name: "Primary" }),
  ).toBeTruthy();
  expect(view.queryByText("Create your workspace")).toBeNull();
});

test("empty submit validates inline without calling the API", async () => {
  authMockState.session = zeroOrgSession();
  const { view } = renderApp();
  await view.findByText("Create your workspace");
  submitForm(view);
  expect(await view.findByText("Name your workspace.")).toBeTruthy();
  expect(authMockState.createOrganizationCalls.length).toBe(0);
});

test("creating a workspace calls create + setActive and reveals the shell", async () => {
  authMockState.session = zeroOrgSession();
  authMockState.createOrganizationResult = {
    data: {
      id: "org_new_1",
      name: "Acme Inc",
      slug: "acme-inc-abcdef12",
      createdAt: "2026-07-08T00:00:00.000Z",
    },
    error: null,
  };
  const { view } = renderApp();
  await view.findByText("Create your workspace");
  fireEvent.input(view.getByLabelText("Workspace name"), {
    target: { value: "  Acme Inc  " },
  });
  submitForm(view);
  await waitFor(() => {
    expect(authMockState.createOrganizationCalls.length).toBe(1);
  });
  const call = authMockState.createOrganizationCalls[0]!;
  expect(call["name"]).toBe("Acme Inc"); // trimmed
  expect(String(call["slug"])).toMatch(/^acme-inc-[0-9a-f]{8}$/);
  await waitFor(() => {
    expect(authMockState.setActiveCalls.length).toBe(1);
  });
  expect(authMockState.setActiveCalls[0]).toEqual({
    organizationId: "org_new_1",
  });
  // $listOrg refetch (mocked as an organizations append) flips the gate.
  expect(
    await view.findByRole("navigation", { name: "Primary" }),
  ).toBeTruthy();
});

test("server rejection shows an inline form error", async () => {
  authMockState.session = zeroOrgSession();
  authMockState.createOrganizationResult = {
    data: null,
    error: { message: "Organization limit reached", status: 403 },
  };
  const { view } = renderApp();
  await view.findByText("Create your workspace");
  fireEvent.input(view.getByLabelText("Workspace name"), {
    target: { value: "Acme" },
  });
  submitForm(view);
  expect(await view.findByText("Organization limit reached")).toBeTruthy();
  expect(view.queryByRole("navigation", { name: "Primary" })).toBeNull();
});
