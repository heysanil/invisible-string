/**
 * /agents grid tests (happy-dom): monogram initials, the four grid states
 * (loading skeleton → cards, error + retry, empty), lifecycle chips across
 * the fixture state matrix, card links into the editor, and the create flow
 * (POST "Untitled agent" → navigate to the new editor).
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AgentSummaryDto } from "@invisible-string/shared";

import {
  AgentLifecycleChip,
  AgentsGrid,
} from "../components/agents/AgentsGrid";
import { monogramInitials } from "../components/agents/AgentMonogram";
import { ToastProvider } from "../components/ui/Toast";
import {
  FIXTURE_AGENTS,
  FIXTURE_EXEC_ASSISTANT,
  FIXTURE_RELEASE_BOT,
} from "../lib/agents/fixtures";
import {
  installFetchMock,
  jsonResponse,
  type FetchMock,
} from "../test/harness";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();

const WS = "org_test_1";
const SUMMARIES: AgentSummaryDto[] = FIXTURE_AGENTS.map(
  (entry) => entry.summary,
);

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

function renderGrid() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return renderWithRouter(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AgentsGrid workspaceId={WS} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ── monogram ─────────────────────────────────────────────────────────────────

test("monogramInitials takes the first letters of the first two words", () => {
  expect(monogramInitials("Executive assistant")).toBe("EA");
  expect(monogramInitials("Support triager bot")).toBe("ST");
  expect(monogramInitials("solo")).toBe("S");
  expect(monogramInitials("   ")).toBe("?");
});

// ── grid states ──────────────────────────────────────────────────────────────

test("shows the loading skeleton, then the card grid with lifecycle chips", async () => {
  fetchMock.on("GET", `/workspaces/${WS}/agents`, () =>
    jsonResponse({ agents: SUMMARIES }),
  );
  const view = renderGrid();

  // Query in flight → skeleton grid announced as loading.
  expect(await view.findByRole("status", { name: "Loading agents" })).toBeTruthy();

  // Loaded: all four fixture agents render as cards.
  expect(await view.findByText("Executive assistant")).toBeTruthy();
  expect(view.getByText("Support triager")).toBeTruthy();
  expect(view.getByText("Release bot")).toBeTruthy();
  expect(view.getByText("Data analyst")).toBeTruthy();

  // Lifecycle chips across the state matrix: two clean published, one draft,
  // one published-but-build-failed.
  expect(view.getAllByText("Published")).toHaveLength(2);
  expect(view.getByText("Draft")).toBeTruthy();
  expect(view.getByText("Build failed")).toBeTruthy();

  // Identity: description or the designed missing-description fallback.
  expect(
    view.getByText("Handles email, calendar, and follow-ups across the team."),
  ).toBeTruthy();
  expect(view.getByText("No description")).toBeTruthy();

  // Whole card links into the editor.
  const links = view
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
  expect(links).toContain(`/agents/${FIXTURE_EXEC_ASSISTANT.agent.id}`);
  expect(links).toContain(`/agents/${FIXTURE_RELEASE_BOT.agent.id}`);
});

test("query failure renders the error state and retry refetches", async () => {
  let failures = 0;
  fetchMock.on("GET", `/workspaces/${WS}/agents`, () => {
    if (failures === 0) {
      failures += 1;
      return jsonResponse(
        { error: { code: "internal_error", message: "boom" } },
        500,
      );
    }
    return jsonResponse({ agents: SUMMARIES });
  });
  const view = renderGrid();

  expect(
    await view.findByText("Could not load this workspace's agents."),
  ).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(await view.findByText("Executive assistant")).toBeTruthy();
});

test("no agents → designed empty state with the create CTA", async () => {
  fetchMock.on("GET", `/workspaces/${WS}/agents`, () =>
    jsonResponse({ agents: [] }),
  );
  const view = renderGrid();

  expect(await view.findByText("No agents yet")).toBeTruthy();
  expect(view.getByText(/reusable teammates/)).toBeTruthy();
  // Header capsule + empty-state action both offer creation.
  expect(view.getAllByRole("button", { name: /New agent/ }).length).toBe(2);
});

// ── create flow ──────────────────────────────────────────────────────────────

test("New agent POSTs an untitled draft and navigates into its editor", async () => {
  fetchMock
    .on("GET", `/workspaces/${WS}/agents`, () => jsonResponse({ agents: [] }))
    .on("POST", `/workspaces/${WS}/agents`, () =>
      jsonResponse({ agent: FIXTURE_RELEASE_BOT.agent }),
    );
  const view = renderGrid();
  await view.findByText("No agents yet");

  fireEvent.click(view.getAllByRole("button", { name: /New agent/ })[0]!);

  const post = await waitFor(() => {
    const call = fetchMock.calls.find((c) => c.method === "POST");
    expect(call).toBeTruthy();
    return call!;
  });
  expect(post.path).toBe(`/workspaces/${WS}/agents`);
  expect(post.body).toEqual({ name: "Untitled agent" });

  // The router leaves the index screen for /agents/:id (stub route → blank).
  await waitFor(() => {
    expect(view.queryByText("No agents yet")).toBeNull();
  });
});

// ── lifecycle chip unit ──────────────────────────────────────────────────────

test("AgentLifecycleChip surfaces the in-flight build state", () => {
  const building: AgentSummaryDto = {
    ...FIXTURE_EXEC_ASSISTANT.summary,
    buildStatus: "building",
  };
  const view = render(<AgentLifecycleChip agent={building} />);
  expect(view.getByText("Building…")).toBeTruthy();
});
