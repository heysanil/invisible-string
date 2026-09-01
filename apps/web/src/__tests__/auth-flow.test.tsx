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
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import { installFetchMock, type FetchMock } from "../test/harness";
import { createAppQueryClient } from "../lib/query-client";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

function renderApp(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

function submitLogin(view: RenderResult, email: string, password: string) {
  fireEvent.input(view.getByLabelText("Email"), { target: { value: email } });
  fireEvent.input(view.getByLabelText("Password"), {
    target: { value: password },
  });
  const button = view.getByRole("button", { name: /sign in/i });
  const form = button.closest("form");
  if (!form) throw new Error("login form not found");
  fireEvent.submit(form);
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
 * The reported bug, end to end: boot signed out, get bounced to /login, sign
 * in ONCE, and land in the shell. Against the pre-fix code the app bounced
 * back to /login here, which is why users had to type their password twice.
 */
test("signing in once, after a signed-out boot, lands in the shell", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { router, view } = renderApp("/chat");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  await view.findByText("Welcome back");

  submitLogin(view, "demo@example.com", "hunter2hunter2");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
  expect(authMockState.signInCalls).toHaveLength(1);
});

/** The second symptom: workspace content must be there without a reload. */
test("workspace content resolves immediately after that single sign-in", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { view } = renderApp("/chat");
  await view.findByText("Welcome back");
  submitLogin(view, "demo@example.com", "hunter2hunter2");

  // Positive assertion first: waiting only for elements to be ABSENT would
  // also pass during the blank frame between the form and the shell.
  expect(await view.findByRole("navigation", { name: "Primary" })).toBeTruthy();
  expect(view.queryByText("No workspace yet")).toBeNull();
  expect(view.queryByText("Welcome back")).toBeNull();
});

test("a deep link is preserved across the sign-in bounce", async () => {
  authMockState.session = null;
  authMockState.organizations = [demoWorkspace()];
  authMockState.sessionAfterSignIn = demoSession();

  const { router, view } = renderApp("/settings/members");
  await view.findByText("Welcome back");
  submitLogin(view, "demo@example.com", "hunter2hunter2");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/settings/members");
  });
});
