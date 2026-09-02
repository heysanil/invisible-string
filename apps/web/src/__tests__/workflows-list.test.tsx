/**
 * Workflows LIST rows (pipelines redesign): a sole-agent-step pipeline keeps
 * the familiar agent chip; a multi-step pipeline renders the kind-glyph
 * capsule + "N steps"; a stepless draft says so. Rendered through the real
 * route tree (shell.test.tsx harness) so the rows exercise the live
 * WorkflowSummaryDto contract.
 */
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { WorkflowSummaryDto } from "@invisible-string/shared";

import { createAppQueryClient } from "../lib/query-client";
import {
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
} from "../test/auth-mock";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

const NOW = "2026-07-10T00:00:00.000Z";

function workflowSummary(
  overrides: Partial<WorkflowSummaryDto>,
): WorkflowSummaryDto {
  return {
    id: "00000000-0000-4000-8000-00000000000a",
    name: "Untitled workflow",
    triggerType: "schedule",
    agentName: null,
    stepKinds: [],
    enabled: true,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const WORKFLOWS: WorkflowSummaryDto[] = [
  workflowSummary({
    id: "00000000-0000-4000-8000-00000000000b",
    name: "Exec digest",
    agentName: null,
    stepKinds: ["tool", "for_each", "infer", "tool"],
    publishedAt: NOW,
  }),
  workflowSummary({
    id: "00000000-0000-4000-8000-00000000000c",
    name: "Support triage",
    agentName: "Support triager",
    stepKinds: ["agent"],
  }),
  workflowSummary({
    id: "00000000-0000-4000-8000-00000000000d",
    name: "Empty draft",
    stepKinds: [],
  }),
];

let realFetch: typeof fetch;

beforeEach(() => {
  resetAuthMock();
  signInToDemoWorkspace();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        workflows: WORKFLOWS,
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

function renderList() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/workflows"] }),
    context: { queryClient: createAppQueryClient() },
  });
  return render(<RouterProvider router={router} />);
}

test("multi-step rows render the kind-glyph capsule with the step count", async () => {
  const view = renderList();
  const list = await view.findByRole("list");
  const row = within(list).getByText("Exec digest").closest("li")!;

  const capsule = within(row as HTMLElement).getByTestId("workflow-step-kinds");
  expect(capsule.textContent).toContain("4 steps");
  // One glyph per kind, in document order (svg icons).
  expect(capsule.querySelectorAll("svg")).toHaveLength(4);
  // Published chip rides along.
  expect((row as HTMLElement).textContent).toContain("Published");
});

test("a sole-agent-step row keeps the agent chip; a stepless draft says so", async () => {
  const view = renderList();
  const list = await view.findByRole("list");

  const agentRow = within(list).getByText("Support triage").closest("li")!;
  const chip = within(agentRow as HTMLElement).getByTestId("workflow-agent-chip");
  expect(chip.textContent).toContain("Support triager");
  expect(
    within(agentRow as HTMLElement).queryByTestId("workflow-step-kinds"),
  ).toBeNull();

  const emptyRow = within(list).getByText("Empty draft").closest("li")!;
  expect((emptyRow as HTMLElement).textContent).toContain("No steps yet");
});
