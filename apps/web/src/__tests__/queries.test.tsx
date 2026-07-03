/**
 * Query-hook tests (happy-dom + QueryClientProvider + mocked global fetch):
 * list rendering, error-code surfacing, and create → list invalidation.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "../lib/api-client";
import { useCreateWorkflow, useWorkflows } from "../lib/queries/workflows";

ensureDomForThisFile();

const WS = "org_test_1";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-03T00:00:00.000Z";

function workflowSummary(id: string, name: string) {
  return {
    id,
    name,
    runAsUserId: "user_1",
    publishedVersionId: null,
    triggerType: "manual",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ── fetch mock ───────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  url: string;
}

let recordedCalls: RecordedCall[] = [];
let respond: (method: string, url: string) => Response;
let realFetch: typeof fetch;

beforeEach(() => {
  recordedCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    recordedCalls.push({ method, url });
    return respond(method, url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── probes ───────────────────────────────────────────────────────────────────

function WorkflowsProbe() {
  const workflows = useWorkflows(WS);
  if (workflows.isPending) return <p>Loading workflows…</p>;
  if (workflows.isError) {
    const code =
      workflows.error instanceof ApiError ? workflows.error.code : "unknown";
    return <p>error:{code}</p>;
  }
  return (
    <ul>
      {workflows.data.map((workflow) => (
        <li key={workflow.id}>{workflow.name}</li>
      ))}
    </ul>
  );
}

function CreateWorkflowProbe() {
  const create = useCreateWorkflow(WS);
  return (
    <button type="button" onClick={() => create.mutate({ name: "Second flow" })}>
      Create workflow
    </button>
  );
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ── tests ────────────────────────────────────────────────────────────────────

test("useWorkflows fetches and renders the workspace list", async () => {
  respond = () =>
    jsonResponse({ workflows: [workflowSummary(UUID_A, "First flow")] });

  const view = renderWithClient(<WorkflowsProbe />);
  expect(view.getByText("Loading workflows…")).toBeTruthy();
  await view.findByText("First flow");

  expect(recordedCalls.length).toBe(1);
  expect(recordedCalls[0]!.method).toBe("GET");
  expect(recordedCalls[0]!.url).toContain(`/workspaces/${WS}/workflows`);
});

test("useWorkflows surfaces the API error code, not a blank pane", async () => {
  respond = () =>
    jsonResponse(
      { error: { code: "workspace_forbidden", message: "not your workspace" } },
      403,
    );

  const view = renderWithClient(<WorkflowsProbe />);
  await view.findByText("error:workspace_forbidden");
});

test("useCreateWorkflow invalidates the list after a successful create", async () => {
  const listPayloads = [
    { workflows: [workflowSummary(UUID_A, "First flow")] },
    {
      workflows: [
        workflowSummary(UUID_A, "First flow"),
        workflowSummary(UUID_B, "Second flow"),
      ],
    },
  ];
  let listCalls = 0;
  respond = (method) => {
    if (method === "POST") {
      return jsonResponse(
        {
          workflow: {
            ...workflowSummary(UUID_B, "Second flow"),
            draft: {},
          },
        },
        201,
      );
    }
    const payload = listPayloads[Math.min(listCalls, listPayloads.length - 1)];
    listCalls += 1;
    return jsonResponse(payload);
  };

  const view = renderWithClient(
    <>
      <WorkflowsProbe />
      <CreateWorkflowProbe />
    </>,
  );
  await view.findByText("First flow");

  fireEvent.click(view.getByRole("button", { name: "Create workflow" }));

  // The create POST lands, then invalidation refetches the list.
  await view.findByText("Second flow");
  await waitFor(() => {
    expect(
      recordedCalls.filter((call) => call.method === "POST").length,
    ).toBe(1);
    expect(
      recordedCalls.filter((call) => call.method === "GET").length,
    ).toBe(2);
  });
});
