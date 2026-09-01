/**
 * The workflow shell layout + Runs tab, mounted through the REAL route tree:
 * the header renders the lifecycle chrome (name · save state · status chip ·
 * Edit | Runs segments · Run · Publish), and /runs lists the workflow's run
 * history — trigger glyph, relative start, duration, status chip, and the
 * failure message on failed rows — each row linking to the run's timeline.
 */
import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { RunDto, WorkflowDto } from "@invisible-string/shared";

import { createAppQueryClient } from "../lib/query-client";
import {
  DEMO_WORKSPACE_ID,
  registerAuthMock,
  resetAuthMock,
  signInToDemoWorkspace,
} from "../test/auth-mock";

ensureDomForThisFile();
registerAuthMock();

const { routeTree } = await import("../routeTree.gen");

const WF_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = "2026-07-10T00:00:00.000Z";

const CONFIG = {
  version: 2,
  trigger: { type: "schedule", cron: "0 9 * * 1" },
  steps: [
    {
      id: "st_search00000000",
      slug: "search",
      kind: "tool",
      connectionId: "cn_slack0000000",
      tool: "search_messages",
      args: {},
      sideEffect: "at_least_once",
    },
  ],
  overlap: "skip",
};

const WORKFLOW: WorkflowDto = {
  id: WF_ID,
  name: "Exec digest",
  draft: CONFIG,
  published: CONFIG,
  enabled: true,
  publishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

function run(id: string, status: RunDto["status"], error: string | null): RunDto {
  return {
    id,
    mode: "pipeline",
    agentSessionId: null,
    workflowId: WF_ID,
    status,
    triggerEvent: {
      agentId: "00000000-0000-4000-8000-000000000001",
      workflowId: WF_ID,
      triggerType: "schedule",
      message: "",
      data: {},
      principal: { workspaceId: DEMO_WORKSPACE_ID, source: "schedule" },
    },
    taskMessage: null,
    deliveryStatus: null,
    eveRunId: null,
    error,
    startedAt: "2026-07-10T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-07-10T00:00:12.000Z",
    createdAt: NOW,
  };
}

const RUNS: RunDto[] = [
  run("00000000-0000-4000-8000-0000000000b1", "succeeded", null),
  run(
    "00000000-0000-4000-8000-0000000000b2",
    "failed",
    "search: the MCP server was unreachable",
  ),
];

let realFetch: typeof fetch;

beforeEach(() => {
  resetAuthMock();
  signInToDemoWorkspace();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes(`/workflows/${WF_ID}/runs`)
      ? { runs: RUNS }
      : url.includes(`/workflows/${WF_ID}`)
        ? { workflow: WORKFLOW, diagnostics: [] }
        : {
            workflows: [],
            runs: [],
            steps: [],
            agents: [],
            connections: [],
            skills: [],
            presets: [],
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: createAppQueryClient() },
  });
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

test("the shell header carries the lifecycle chrome and marks the Runs tab active", async () => {
  const { view } = renderAt(`/workflows/${WF_ID}/runs`);

  const name = await view.findByLabelText("Workflow name");
  expect((name as HTMLInputElement).value).toBe("Exec digest");
  expect(view.getByText("Published")).toBeTruthy();

  // The Edit | Runs segments, with Runs selected for this URL.
  const tabs = view.getByRole("tablist", { name: "Workflow view" });
  const runsTab = within(tabs).getByRole("tab", { name: "Runs" });
  await waitFor(() =>
    expect(runsTab.getAttribute("aria-selected")).toBe("true"),
  );

  expect(view.getByRole("button", { name: /Publish/ })).toBeTruthy();
  expect(view.getByRole("button", { name: /Run/ })).toBeTruthy();
});

test("run rows show duration + status and link to the run's timeline; failed rows carry the message", async () => {
  const { view } = renderAt(`/workflows/${WF_ID}/runs`);

  const rows = await view.findAllByTestId("run-row");
  expect(rows).toHaveLength(2);

  const [ok, failed] = rows as [HTMLElement, HTMLElement];
  expect(ok.textContent).toContain("12s");
  expect(ok.textContent).toContain("succeeded");
  expect(ok.getAttribute("href")).toBe(
    `/workflows/${WF_ID}/runs/00000000-0000-4000-8000-0000000000b1`,
  );

  expect(failed.textContent).toContain("failed");
  expect(failed.textContent).toContain("the MCP server was unreachable");
});
