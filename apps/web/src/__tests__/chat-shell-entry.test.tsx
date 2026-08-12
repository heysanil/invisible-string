/**
 * ChatShell's two 2026-08-11 behaviours, driven against a mocked control
 * plane (happy-dom + real query hooks + real Tiptap composer).
 *
 * D8 — sending ENTERS the thread. The pane must swap to the optimistic
 * thread while `POST …/sessions` is still in flight, and if that POST fails
 * it must come back to the composer WITH THE TYPED TEXT. The rollback case is
 * the one this suite exists for: the whole point of holding the message in
 * the shell rather than in the editor that gets unmounted is that a network
 * error can never eat it, and nothing else in the app would catch a
 * regression there.
 *
 * D9 — session rows are titled by the SESSION, not the agent, and they are so
 * titled on a COLD LOAD: the fallback for an untitled row is the opener the
 * list DTO carries, never a message this tab happened to learn by opening the
 * thread. The agent has to stay legible underneath (a title alone loses which
 * agent a thread belongs to), except in the one case where the title already
 * IS the agent's name and repeating it would be noise.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  AgentSessionSummaryDto,
  AgentSummaryDto,
} from "@invisible-string/shared";

import { ChatShell } from "../components/chat/ChatShell";
import { ToastProvider } from "../components/ui/Toast";
import { pasteInto, pressEnter } from "../test/editor";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();

const WS = "org_1";
const AGENT_ID = "aaaaaaaa-0001-4000-8000-000000000001";
const VERSION_ID = "bbbbbbbb-0001-4000-8000-000000000001";
const SESSION_A = "cccccccc-0001-4000-8000-000000000001";
const SESSION_B = "cccccccc-0002-4000-8000-000000000002";
const NEW_SESSION = "cccccccc-0003-4000-8000-000000000003";
const RUN_ID = "dddddddd-0001-4000-8000-000000000001";
const NOW = "2026-08-11T12:00:00.000Z";

const AGENT: AgentSummaryDto = {
  id: AGENT_ID,
  name: "Executive assistant",
  description: "Runs the inbox.",
  runAsUserId: "user_owner",
  publishedVersionId: VERSION_ID,
  publishedAt: NOW,
  buildStatus: "succeeded",
  createdAt: NOW,
  updatedAt: NOW,
};

function session(
  id: string,
  title: string | null,
  overrides: Partial<AgentSessionSummaryDto> = {},
): AgentSessionSummaryDto {
  return {
    id,
    agentId: AGENT_ID,
    agentVersionId: VERSION_ID,
    workflowId: null,
    origin: "chat",
    status: "active",
    title,
    eveSessionId: "eve_1",
    createdAt: NOW,
    updatedAt: NOW,
    agentName: AGENT.name,
    workflowName: null,
    lastRunStatus: "succeeded",
    lastActivityAt: NOW,
    ...overrides,
  };
}

// ── fetch mock ──────────────────────────────────────────────────────────────

type Handler = (
  method: string,
  url: string,
  body: unknown,
) => Response | Promise<Response>;

let handler: Handler;
let realFetch: typeof fetch;
let sessions: AgentSessionSummaryDto[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The routes ChatShell touches on its own; anything else is a test bug. */
function defaultHandler(method: string, url: string): Response {
  if (method === "GET" && url.includes("/sessions")) {
    return json({ sessions });
  }
  if (method === "GET" && url.endsWith(`/workspaces/${WS}/agents`)) {
    return json({ agents: [AGENT] });
  }
  if (method === "GET" && url.includes(`/agents/${AGENT_ID}`)) {
    // Only the model chip reads this; an error here must not break the shell.
    return json({ error: { code: "not_found", message: "no detail" } }, 404);
  }
  throw new Error(`unexpected request ${method} ${url}`);
}

beforeEach(() => {
  sessions = [];
  handler = defaultHandler;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return handler(method, url, body);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function renderShell(props: { initialAgentId?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithRouter(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ChatShell workspaceId={WS} initialAgentId={props.initialAgentId} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The sidebar row for a session, addressed by the text it now leads with. */
function row(
  view: ReturnType<typeof renderShell>,
  title: string | RegExp,
): HTMLElement {
  const panel = view.getByLabelText("Chat sessions") as HTMLElement;
  return within(panel).getByRole("button", { name: title });
}

// ── D9: session titles ──────────────────────────────────────────────────────

test("a titled session leads with its title and keeps the agent legible", async () => {
  sessions = [session(SESSION_A, "Launch announcement draft")];
  const view = renderShell();

  const listRow = await waitFor(() => row(view, /Launch announcement draft/));
  // The title is the headline…
  expect(
    within(listRow).getByText("Launch announcement draft"),
  ).toBeTruthy();
  // …and the agent is still there, as its own line of metadata. Without this
  // a workspace with several agents cannot tell whose thread a row is.
  expect(within(listRow).getByText("Executive assistant")).toBeTruthy();
});

test("two sessions of one agent no longer read identically", async () => {
  sessions = [
    session(SESSION_A, "Launch announcement draft"),
    session(SESSION_B, "Q3 board deck outline"),
  ];
  const view = renderShell();

  await waitFor(() => row(view, /Launch announcement draft/));
  expect(row(view, /Q3 board deck outline/)).toBeTruthy();
});

test("untitled rows are named by their own opening message on a COLD load", async () => {
  // Nothing has been opened, so this tab holds no thread detail and no
  // message of its own — the label can only come off the list row. It used to
  // come off a map this component filled as threads were opened, which meant
  // a fresh page load (or a second device) showed the agent's name on every
  // untitled row: one repeated string for the whole sidebar, the exact
  // symptom D9 exists to remove, and permanent whenever titling failed —
  // which D9 makes a normal, silent outcome.
  sessions = [
    session(SESSION_A, null, {
      firstMessagePreview: "Draft the launch announcement for Tuesday",
    }),
    session(SESSION_B, null, {
      firstMessagePreview: "Summarize the open support tickets",
    }),
  ];
  const view = renderShell();

  const listRow = await waitFor(() =>
    row(view, /Draft the launch announcement for Tuesday/),
  );
  // Two threads of one agent read differently…
  expect(row(view, /Summarize the open support tickets/)).toBeTruthy();
  // …and the agent stays legible underneath, as it does under a generated
  // title: a message alone loses whose thread this is.
  expect(within(listRow).getByText("Executive assistant")).toBeTruthy();
});

test("a long preview is truncated in the row, not shown whole", async () => {
  // The server clamps to SESSION_MESSAGE_PREVIEW_MAX_CHARS (200), which is
  // still far wider than a 320 px sidebar row — the row's own truncation is
  // what keeps it a label rather than a paragraph.
  const opener = `Please review the whole ${"launch ".repeat(20)}checklist`;
  sessions = [session(SESSION_A, null, { firstMessagePreview: opener })];
  const view = renderShell();

  const listRow = await waitFor(() => row(view, /Please review the whole/));
  const headline = within(listRow).getByText(/^Please review the whole/);
  expect(headline.textContent!.endsWith("…")).toBe(true);
  expect(headline.textContent!.length).toBeLessThan(opener.length);
});

test("a session with no message at all falls back to the agent — once", async () => {
  // Reachable for real: a schedule fires with no inbound message, so the
  // server has nothing to preview. The agent's name is then the only honest
  // label left, and it must not be repeated underneath itself.
  sessions = [
    session(SESSION_A, null, { origin: "schedule", firstMessagePreview: null }),
  ];
  const view = renderShell();

  const listRow = await waitFor(() => row(view, /Executive assistant/));
  expect(within(listRow).getAllByText("Executive assistant")).toHaveLength(1);
});

test("a trigger-origin row keeps its origin and workflow provenance", async () => {
  sessions = [
    session(SESSION_A, null, {
      origin: "webhook",
      workflowId: "eeeeeeee-0001-4000-8000-000000000001",
      workflowName: "Nightly metrics digest",
    }),
  ];
  const view = renderShell();

  const listRow = await waitFor(() => row(view, /Executive assistant/));
  expect(within(listRow).getByText("webhook")).toBeTruthy();
  expect(within(listRow).getByText("Nightly metrics digest")).toBeTruthy();
});

// ── D8: optimistic entry ────────────────────────────────────────────────────

test("sending enters the thread while the session is still being created", async () => {
  let release: ((value: Response) => void) | null = null;
  handler = (method, url, body) => {
    if (method === "POST" && url.endsWith(`/agents/${AGENT_ID}/sessions`)) {
      void body;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return defaultHandler(method, url);
  };

  const view = renderShell({ initialAgentId: AGENT_ID });
  await view.findByText("New chat with Executive assistant");
  const box = await view.findByLabelText("Message");

  pasteInto(box, "Draft the launch announcement");
  pressEnter(box);

  // The POST has not answered — and the user is already in the thread, with
  // their own words on screen.
  await waitFor(() =>
    expect(view.getByText("Draft the launch announcement")).toBeTruthy(),
  );
  expect(view.getByText(/Starting Executive assistant/)).toBeTruthy();
  // The composer they typed into is gone; the empty new-chat pane with it.
  expect(view.queryByText("New chat with Executive assistant")).toBeNull();
  expect(release).not.toBeNull();

  // Let the create land so the test does not leave a promise hanging.
  sessions = [session(NEW_SESSION, null)];
  release!(
    json({
      session: {
        id: NEW_SESSION,
        agentId: AGENT_ID,
        agentVersionId: VERSION_ID,
        workflowId: null,
        origin: "chat",
        status: "active",
        title: null,
        eveSessionId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      run: {
        id: RUN_ID,
        agentSessionId: NEW_SESSION,
        status: "queued",
        triggerEvent: {
          agentId: AGENT_ID,
          workflowId: null,
          triggerType: "manual",
          message: "Draft the launch announcement",
          data: {},
          principal: { workspaceId: WS, source: "chat" },
        },
        taskMessage: null,
        deliveryStatus: null,
        eveRunId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: NOW,
      },
    }),
  );
  await waitFor(() =>
    expect(view.queryByText(/Starting Executive assistant/)).toBeNull(),
  );
});

test("a failed create rolls back to the composer WITH the message", async () => {
  handler = (method, url) => {
    if (method === "POST" && url.endsWith(`/agents/${AGENT_ID}/sessions`)) {
      return json(
        { error: { code: "internal_error", message: "Agent is not published." } },
        500,
      );
    }
    return defaultHandler(method, url);
  };

  const view = renderShell({ initialAgentId: AGENT_ID });
  await view.findByText("New chat with Executive assistant");
  const box = await view.findByLabelText("Message");

  pasteInto(box, "Draft the launch announcement");
  pressEnter(box);

  // Back on the composer…
  await view.findByText("New chat with Executive assistant");
  // …and the text survived the round trip. Losing it here is the regression
  // D8 must not introduce, and it is why the shell owns the message.
  const restored = await view.findByLabelText("Message");
  await waitFor(() =>
    expect(restored.textContent).toContain("Draft the launch announcement"),
  );
  // The failure is announced, not swallowed.
  expect(view.getByText(/Agent is not published/)).toBeTruthy();
});
