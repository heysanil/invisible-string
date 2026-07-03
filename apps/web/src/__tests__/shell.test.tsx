import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

// The Workflows section fetches workspace resources on mount; stub fetch so
// the shell tests stay hermetic (no real network). The merged body satisfies
// every list schema the index touches (each reads only its own key).
let realFetch: typeof fetch;

beforeEach(() => {
  resetAuthMock();
  authMockState.session = demoSession();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ workflows: [], sessions: [], agents: [] }),
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
  // The demo session has no active organization resolved (the org-plugin
  // hooks are empty), so every workspace-scoped section shows its gate
  // rather than firing resource fetches — workflows included.
  expect(await view.findByText("No active workspace")).toBeTruthy();

  const contextLink = view.getByRole("link", { name: "Context" });
  fireEvent.click(contextLink);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/context");
  });
  expect(await view.findByText("No workspace yet")).toBeTruthy();
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
