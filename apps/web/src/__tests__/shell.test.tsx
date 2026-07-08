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
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
} from "../test/auth-mock";

ensureDomForThisFile();
// Re-register in THIS file: module-mock patches don't survive test-file
// boundaries when the real module was evaluated first (order-dependent).
registerAuthMock();

// Dynamic import AFTER the mock is registered, so the route modules resolve
// the mocked auth client instead of the real one.
const { routeTree } = await import("../routeTree.gen");

// NOTE: RTL's `screen` binds document.body at import time, which is too early
// under bun's module linking — use render-scoped queries instead.
function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

// Every workspace-scoped section fetches its own resources on mount (a
// resolved demo workspace clears the zero-org gate, so Workflows/Chat/Context
// all reach their real queries instead of a "no workspace" gate); stub fetch
// so the shell tests stay hermetic (no real network). The merged body
// satisfies every list schema each section touches (each reads only its own
// key).
let realFetch: typeof fetch;

beforeEach(() => {
  resetAuthMock();
  signInToDemoWorkspace();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        workflows: [],
        sessions: [],
        agents: [],
        connections: [],
        skills: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

test("shell renders the glass dock with all four sections", async () => {
  const { view } = renderAt("/chat");
  const nav = await view.findByRole("navigation", { name: "Primary" });
  expect(nav).toBeTruthy();
  for (const label of ["Chat", "Workflows", "Context", "Settings"]) {
    expect(view.getByRole("link", { name: label })).toBeTruthy();
  }
  expect(await view.findByText("No conversations yet")).toBeTruthy();
});

test("root redirects to /chat", async () => {
  const { router } = renderAt("/");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/chat");
  });
});

test("dock navigation switches routes", async () => {
  const { router, view } = renderAt("/chat");
  const workflowsLink = await view.findByRole("link", { name: "Workflows" });
  fireEvent.click(workflowsLink);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/workflows");
  });
  // The demo session's workspace is resolved, so the Workflows section
  // renders its real (empty) list rather than the no-workspace gate.
  expect(await view.findByText("No workflows yet")).toBeTruthy();

  const contextLink = view.getByRole("link", { name: "Context" });
  fireEvent.click(contextLink);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/context");
  });
  expect(await view.findByText("No connections yet")).toBeTruthy();
});

test("active dock item is marked with aria-current", async () => {
  const { view } = renderAt("/workflows");
  const link = await view.findByRole("link", { name: "Workflows" });
  await waitFor(() => {
    expect(link.getAttribute("aria-current")).toBe("page");
  });
  expect(
    view.getByRole("link", { name: "Chat" }).getAttribute("aria-current"),
  ).toBeNull();
});

test("unauthenticated visitors are redirected to /login", async () => {
  authMockState.session = null;
  const { router, view } = renderAt("/chat");
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
  expect(await view.findByText("Welcome back")).toBeTruthy();
});
