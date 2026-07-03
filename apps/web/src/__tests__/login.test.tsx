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

import { authMockState, demoSession, resetAuthMock } from "../test/auth-mock";

ensureDomForThisFile();

// Dynamic import AFTER ../test/auth-mock has registered mock.module, so the
// route modules resolve the mocked auth client instead of the real one.
const { routeTree } = await import("../routeTree.gen");

// NOTE: RTL's `screen` binds document.body at import time, which is too early
// under bun's module linking — use render-scoped queries instead.
function renderLogin() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

function submitForm(view: RenderResult) {
  const button = view.getByRole("button", { name: /sign in/i });
  const form = button.closest("form");
  if (!form) throw new Error("login form not found");
  fireEvent.submit(form);
}

beforeEach(resetAuthMock);
afterEach(cleanup);

test("empty submit shows inline validation and does not call the API", async () => {
  const { view } = renderLogin();
  await view.findByText("Welcome back");
  submitForm(view);
  expect(await view.findByText("Enter your email.")).toBeTruthy();
  expect(view.getByText("Enter your password.")).toBeTruthy();
  expect(authMockState.signInCalls.length).toBe(0);
});

test("invalid email is rejected inline", async () => {
  const { view } = renderLogin();
  await view.findByText("Welcome back");
  fireEvent.input(view.getByLabelText("Email"), {
    target: { value: "not-an-email" },
  });
  fireEvent.input(view.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  submitForm(view);
  expect(await view.findByText("Enter a valid email address.")).toBeTruthy();
  expect(authMockState.signInCalls.length).toBe(0);
});

test("valid credentials are submitted; server rejection shows inline", async () => {
  authMockState.signInResult = {
    data: null,
    error: { message: "Invalid email or password", status: 401 },
  };
  const { view } = renderLogin();
  await view.findByText("Welcome back");
  fireEvent.input(view.getByLabelText("Email"), {
    target: { value: "demo@example.com" },
  });
  fireEvent.input(view.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  submitForm(view);
  await waitFor(() => {
    expect(authMockState.signInCalls.length).toBe(1);
  });
  expect(authMockState.signInCalls[0]).toEqual({
    email: "demo@example.com",
    password: "secret123",
  });
  expect(await view.findByText("Invalid email or password")).toBeTruthy();
});

test("successful sign-in navigates to /chat", async () => {
  const { router, view } = renderLogin();
  await view.findByText("Welcome back");
  authMockState.session = demoSession(); // the guard sees a session post-login
  fireEvent.input(view.getByLabelText("Email"), {
    target: { value: "demo@example.com" },
  });
  fireEvent.input(view.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  submitForm(view);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
});
