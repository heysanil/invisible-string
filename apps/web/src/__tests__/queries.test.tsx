/**
 * Query-hook tests (happy-dom + QueryClientProvider + mocked global fetch):
 * list rendering, error-code surfacing, create → list invalidation, and the
 * agent PATCH's piggybacked dry-run diagnostics.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "../lib/api-client";
import { useAgents, useCreateAgent, useUpdateAgent } from "../lib/queries/agents";
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
    triggerType: "manual",
    agentName: null,
    enabled: true,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workflowRow(id: string, name: string) {
  return {
    id,
    name,
    draft: {},
    published: null,
    enabled: true,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentSummary(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    runAsUserId: "user_1",
    publishedVersionId: null,
    publishedAt: null,
    buildStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentRow(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    runAsUserId: "user_1",
    draft: {},
    publishedVersionId: null,
    publishedDefinition: null,
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

function AgentsProbe() {
  const agents = useAgents(WS);
  if (agents.isPending) return <p>Loading agents…</p>;
  if (agents.isError) {
    const code =
      agents.error instanceof ApiError ? agents.error.code : "unknown";
    return <p>error:{code}</p>;
  }
  return (
    <ul>
      {agents.data.map((agent) => (
        <li key={agent.id}>{agent.name}</li>
      ))}
    </ul>
  );
}

function CreateAgentProbe() {
  const create = useCreateAgent(WS);
  return (
    <button type="button" onClick={() => create.mutate({ name: "Second agent" })}>
      Create agent
    </button>
  );
}

function UpdateAgentProbe() {
  const update = useUpdateAgent(WS);
  const diagnostics = update.data?.diagnostics;
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          update.mutate({ agentId: UUID_A, patch: { description: "x" } })
        }
      >
        Update agent
      </button>
      {diagnostics !== undefined ? (
        <p>diagnostics:{diagnostics.ok ? "ok" : diagnostics.error.code}</p>
      ) : null}
    </div>
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

// ── workflow tests ───────────────────────────────────────────────────────────

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
      return jsonResponse({ workflow: workflowRow(UUID_B, "Second flow") }, 201);
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

// ── agent tests ──────────────────────────────────────────────────────────────

test("useAgents fetches and renders the workspace agent list", async () => {
  respond = () =>
    jsonResponse({ agents: [agentSummary(UUID_A, "Executive assistant")] });

  const view = renderWithClient(<AgentsProbe />);
  expect(view.getByText("Loading agents…")).toBeTruthy();
  await view.findByText("Executive assistant");

  expect(recordedCalls.length).toBe(1);
  expect(recordedCalls[0]!.method).toBe("GET");
  expect(recordedCalls[0]!.url).toContain(`/workspaces/${WS}/agents`);
});

test("useCreateAgent invalidates the agent list after a successful create", async () => {
  const listPayloads = [
    { agents: [agentSummary(UUID_A, "First agent")] },
    {
      agents: [
        agentSummary(UUID_A, "First agent"),
        agentSummary(UUID_B, "Second agent"),
      ],
    },
  ];
  let listCalls = 0;
  respond = (method) => {
    if (method === "POST") {
      return jsonResponse({ agent: agentRow(UUID_B, "Second agent") }, 201);
    }
    const payload = listPayloads[Math.min(listCalls, listPayloads.length - 1)];
    listCalls += 1;
    return jsonResponse(payload);
  };

  const view = renderWithClient(
    <>
      <AgentsProbe />
      <CreateAgentProbe />
    </>,
  );
  await view.findByText("First agent");

  fireEvent.click(view.getByRole("button", { name: "Create agent" }));

  await view.findByText("Second agent");
  await waitFor(() => {
    expect(
      recordedCalls.filter((call) => call.method === "POST").length,
    ).toBe(1);
    expect(
      recordedCalls.filter((call) => call.method === "GET").length,
    ).toBe(2);
  });
});

test("useUpdateAgent surfaces the PATCH's dry-run diagnostics payload", async () => {
  respond = (method) => {
    if (method === "PATCH") {
      return jsonResponse({
        agent: agentRow(UUID_A, "First agent"),
        diagnostics: {
          ok: false,
          error: { code: "compile_failed", message: "compile failed" },
        },
      });
    }
    return jsonResponse({ agents: [] });
  };

  const view = renderWithClient(<UpdateAgentProbe />);
  fireEvent.click(view.getByRole("button", { name: "Update agent" }));

  await view.findByText("diagnostics:compile_failed");
  expect(
    recordedCalls.some(
      (call) =>
        call.method === "PATCH" &&
        call.url.includes(`/workspaces/${WS}/agents/${UUID_A}`),
    ),
  ).toBe(true);
});
