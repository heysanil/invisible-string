/**
 * ThreadContainer integration (happy-dom + real query hooks + mocked fetch):
 * BOTH 409 composer flows (transient `session_busy` vs permanent
 * `session_not_active` — opposite recoveries, so opposite copy), the HITL
 * approval POST /runs/:id/input round-trip that re-opens the stream, and the
 * eve 0.31 context controls (clear fires straight off the menu; reset is
 * destructive and must pass a confirm step first).
 *
 * The SSE layer is mocked (useThreadStreams) so frames are injected directly;
 * everything else — useSession, usePostMessage, usePostRunInput, the context
 * controls — is real.
 */
import { ensureDomForThisFile } from "../test/setup";
import { expectAbsent } from "../test/dom";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { useEffect, useReducer } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunEventFrame, RunStatus } from "@invisible-string/shared";
import { EMPTY_FRAME_STORE, addFrames, type FrameStore } from "../lib/chat/run-view";
import { renderWithRouter } from "../test/router";
import { pasteInto, pressEnter } from "../test/editor";
import { ToastProvider } from "../components/ui/Toast";
// The real implementation, bound at THIS file's evaluation, so the module
// mock below can delegate to it when use-thread-streams.test.tsx flips the
// shared flag (see test/stream-mock-flag.ts for the full story).
import * as realThreadStreams from "../lib/chat/use-thread-streams";
import { streamsMockFlag } from "../test/stream-mock-flag";

ensureDomForThisFile();

// The thread list is virtualized; happy-dom reports 0 for layout boxes, so
// give the virtualizer a measurable viewport (RO fires immediately, rects
// report a real size) — otherwise no run items mount to interact with.
beforeEach(() => {
  class ImmediateResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver;
  const rect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
  Element.prototype.getBoundingClientRect = rect;
  HTMLElement.prototype.getBoundingClientRect = rect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
});

const WS = "org_1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const AGV_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-03T00:00:00.000Z";

// ── mock useThreadStreams: feed a per-run store the test controls ───────────

const liveStores = new Map<string, { store: FrameStore; status: RunStatus | null }>();
const reopenCalls: string[] = [];

/** Subscribers that turn a mid-test `liveStores` write into a real re-render. */
const liveStoreListeners = new Set<() => void>();

/**
 * Move a run's live stream state AFTER the thread has mounted — the gesture
 * "the run settled" is made of, and the only way to watch the queue flush.
 *
 * The mocked hook reads `liveStores` at render time, so a bare `.set()` sits
 * there unobserved, and RTL's `rerender` cannot force the issue either: it
 * takes a React element, and nothing in this test owns one (the tree is built
 * inside `renderWithRouter`). Hence the listener channel.
 */
function setLiveStore(
  runId: string,
  entry: { store: FrameStore; status: RunStatus | null },
): void {
  liveStores.set(runId, entry);
  act(() => {
    for (const notify of [...liveStoreListeners]) notify();
  });
}

const streamsModulePath = new URL(
  "../lib/chat/use-thread-streams.ts",
  import.meta.url,
).pathname;

// bun's mock.module can intercept every FUTURE import of this path for the
// rest of the process (observed on Namespace CI runners, where readdir order
// runs this file before use-thread-streams.test.tsx first touches the real
// module — locally the consumer usually binds the real module first and never
// sees the mock). The mock stays FAKE by default for order-independence and
// delegates to the real implementation only while use-thread-streams.test.tsx
// holds the flag — rationale and hang hazard in test/stream-mock-flag.ts.
//
// The delegate target MUST be a value captured BEFORE mock.module registers:
// import bindings are live views, and where mock.module rewrites the real
// module's bindings in place, delegating through the live binding calls the
// mock itself — an infinite tail-recursive loop that JSC's proper tail calls
// keep from ever overflowing the stack, so bun test simply hangs.
const realUseThreadStreams = realThreadStreams.useThreadStreams;

mock.module(streamsModulePath, () => ({
  useThreadStreams: ((runs, options) => {
    // The re-render channel `setLiveStore` publishes on. Subscribed ABOVE the
    // delegation branch so the hook order is identical on both paths.
    const [, bump] = useReducer((count: number) => count + 1, 0);
    useEffect(() => {
      liveStoreListeners.add(bump);
      return () => {
        liveStoreListeners.delete(bump);
      };
    }, [bump]);
    if (!streamsMockFlag.active) return realUseThreadStreams(runs, options);
    const map = new Map<string, { store: FrameStore; status: RunStatus | null; error: null; streamError: null }>();
    for (const run of runs) {
      const entry = liveStores.get(run.id);
      map.set(run.id, {
        store: entry?.store ?? EMPTY_FRAME_STORE,
        status: entry?.status ?? null,
        error: null,
        streamError: null,
      });
    }
    return { runs: map, reopen: (runId: string) => reopenCalls.push(runId) };
  }) as typeof realThreadStreams.useThreadStreams,
}));

const { ThreadContainer } = await import("../components/chat/ThreadContainer");

// ── fetch mock ───────────────────────────────────────────────────────────────

function sessionResponse(status: RunStatus, title: string | null = null) {
  return {
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      agentVersionId: AGV_ID,
      workflowId: null,
      origin: "chat",
      status: "active",
      title,
      eveSessionId: "eve1",
      createdAt: NOW,
      updatedAt: NOW,
    },
    runs: [
      {
        id: RUN_ID,
        mode: "agent",
        agentSessionId: SESSION_ID,
        workflowId: null,
        status,
        triggerEvent: {
          agentId: AGENT_ID,
          workflowId: null,
          triggerType: "manual",
          message: "Send the report",
          data: {},
          principal: { workspaceId: WS, source: "chat" },
        },
        taskMessage: null,
        deliveryStatus: null,
        eveRunId: "ev1",
        error: null,
        startedAt: NOW,
        completedAt: null,
        createdAt: NOW,
      },
    ],
  };
}

interface Handler {
  (method: string, url: string, body: unknown): Response;
}

let handler: Handler;
let realFetch: typeof fetch;
const requests: Array<{ method: string; url: string; body: unknown }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  liveStores.clear();
  reopenCalls.length = 0;
  requests.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    return handler(method, url, body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function renderContainer(
  props: { onSessionReplaced?: (id: string) => void } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithRouter(
    <QueryClientProvider client={client}>
      {/* The container toasts the outcome of every context control. */}
      <ToastProvider>
        <ThreadContainer
          workspaceId={WS}
          sessionId={SESSION_ID}
          agentName="Report bot"
          onSessionReplaced={props.onSessionReplaced}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The session DTO shape the control plane returns for a fresh/reset row. */
function sessionDto(id: string) {
  return {
    id,
    agentId: AGENT_ID,
    agentVersionId: AGV_ID,
    workflowId: null,
    origin: "chat",
    status: "active",
    title: null,
    eveSessionId: `eve_${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("409 session_busy hands the message to the queue, not back to the box", async () => {
  // The queue is the single owner of busy recovery. A direct send only ever
  // 409s `session_busy` when the slot was taken between the keystroke and the
  // POST (a stale `slotHeld`, or another tab), and re-typing is not the fix
  // for a race the client can just wait out — so the text moves into the
  // strip and retries itself instead of coming back as a draft.
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("succeeded"));
    }
    if (method === "POST" && url.includes(`/sessions/${SESSION_ID}/messages`)) {
      return json(
        { error: { code: "session_busy", message: "A run is already active." } },
        409,
      );
    }
    if (method === "GET" && url.includes("/sessions")) {
      return json({ sessions: [] });
    }
    return json({}, 404);
  };

  const view = renderContainer();
  // Wait for the thread to hydrate (composer present).
  const box = await view.findByLabelText("Message");
  pasteInto(box, "second message");
  pressEnter(box);

  // Queued — visible, removable, and retrying on its own.
  await waitFor(() => expect(view.getByText("second message")).toBeTruthy());
  expect(
    view.getByRole("button", { name: /Remove queued message/ }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(view.getByText(/send shortly|still busy/i)).toBeTruthy(),
  );
});

test("answering an approval POSTs to /runs/:id/input and reopens the stream", async () => {
  // Seed the run's live store with a parked approval frame.
  const frames: RunEventFrame[] = [
    {
      runId: RUN_ID,
      seq: 0,
      event: {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req1",
              kind: "tool-approval",
              prompt: "Approve tool call: gmail_send",
              action: { callId: "c1", kind: "tool-call", toolName: "gmail_send", input: { to: "x" } },
              options: [
                { id: "approve", label: "Approve" },
                { id: "deny", label: "Deny" },
              ],
              display: "confirmation",
              allowFreeform: false,
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "t",
        },
      },
      at: NOW,
    },
  ];
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, frames),
    status: "waiting",
  });

  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("waiting"));
    }
    if (method === "POST" && url.includes(`/runs/${RUN_ID}/input`)) {
      return json({ run: { ...sessionResponse("running").runs[0], status: "running" } });
    }
    if (method === "GET" && url.includes("/sessions")) {
      return json({ sessions: [] });
    }
    return json({}, 404);
  };

  const view = renderContainer();
  const approve = await view.findByRole("button", { name: "Approve" });
  fireEvent.click(approve);

  await waitFor(() => {
    expect(
      requests.some(
        (r) => r.method === "POST" && r.url.includes(`/runs/${RUN_ID}/input`),
      ),
    ).toBe(true);
  });
  const inputCall = requests.find((r) => r.url.includes(`/runs/${RUN_ID}/input`));
  expect(inputCall?.body).toEqual({ requestId: "req1", optionId: "approve" });
  await waitFor(() => expect(reopenCalls).toContain(RUN_ID));
});

test("409 session_not_active offers a NEW chat, never a retry", async () => {
  // The opposite recovery from session_busy: eve retired this id (terminal,
  // timed out, or reset), so "try again once it finishes" would be a lie the
  // user could follow forever.
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("succeeded"));
    }
    if (method === "POST" && url.includes(`/sessions/${SESSION_ID}/messages`)) {
      return json(
        {
          error: {
            code: "session_not_active",
            message: "The session is no longer active.",
          },
        },
        409,
      );
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };

  const view = renderContainer();
  const box = await view.findByLabelText("Message");
  pasteInto(box, "still there?");
  pressEnter(box);

  await waitFor(() => expect(view.getByText(/retired/i)).toBeTruthy());
  // Crucially NOT the transient copy.
  expect(view.queryByText(/try again once it finishes/i)).toBeNull();
  // The text is still recoverable by the user even though retrying is futile.
  expect(view.getByLabelText("Message").textContent).toBe("still there?");
});

// ── context controls ────────────────────────────────────────────────────────

test("Clear context fires straight off the menu — no nagging confirm", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("succeeded"));
    }
    if (method === "POST" && url.includes(`/sessions/${SESSION_ID}/clear`)) {
      return json({ session: sessionDto(SESSION_ID), status: "accepted" });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };

  const view = renderContainer();
  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  fireEvent.click(view.getByText("Clear context"));

  await waitFor(() =>
    expect(
      requests.some(
        (r) => r.method === "POST" && r.url.endsWith(`/sessions/${SESSION_ID}/clear`),
      ),
    ).toBe(true),
  );
  // Non-destructive, so it just happens — and then says so.
  await waitFor(() => expect(view.getAllByText(/Context cleared/).length).toBeGreaterThan(0));
});

test("Reset asks first, then swaps the thread onto the replacement session", async () => {
  const NEW_SESSION_ID = "55555555-5555-4555-8555-555555555555";
  const replaced: string[] = [];
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("succeeded"));
    }
    if (method === "POST" && url.includes(`/sessions/${SESSION_ID}/reset`)) {
      return json({
        status: "reset",
        previousSession: { ...sessionDto(SESSION_ID), status: "closed" },
        session: sessionDto(NEW_SESSION_ID),
      });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };

  const view = renderContainer({ onSessionReplaced: (id) => replaced.push(id) });
  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  fireEvent.click(view.getByText("Reset session"));

  // DESTRUCTIVE: the retired eve session id can never take another message,
  // so nothing may be sent before the user confirms.
  expect(await view.findByText("Reset this session?")).toBeTruthy();
  expect(
    requests.some((r) => r.url.includes(`/sessions/${SESSION_ID}/reset`)),
  ).toBe(false);

  fireEvent.click(view.getByRole("button", { name: "Reset session" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) => r.method === "POST" && r.url.endsWith(`/sessions/${SESSION_ID}/reset`),
      ),
    ).toBe(true),
  );
  // The user must land on the REPLACEMENT row, or every later send 409s.
  await waitFor(() => expect(replaced).toEqual([NEW_SESSION_ID]));
});

// ── message queue ───────────────────────────────────────────────────────────

test("a message typed during a run is queued, then sent as one message", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  // The run is live, so the composer is in queueing mode — and still typeable.
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy(),
  );
  pasteInto(box, "also mention the Tiptap swap");
  pressEnter(box);
  pasteInto(box, "keep it under 200 words");
  pressEnter(box);

  // Both sit in the strip; nothing has been POSTed.
  await waitFor(() =>
    expect(view.getByText(/also mention the Tiptap swap/)).toBeTruthy(),
  );
  expect(view.getByText(/keep it under 200 words/)).toBeTruthy();
  expect(requests.filter((r) => r.url.includes("/messages"))).toHaveLength(0);

  // The run settles → the slot frees → the queue flushes as ONE message.
  setLiveStore(RUN_ID, { store: EMPTY_FRAME_STORE, status: "succeeded" });

  await waitFor(() => {
    const posts = requests.filter((r) => r.url.includes("/messages"));
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as { message: string }).message).toBe(
      "also mention the Tiptap swap\n\nkeep it under 200 words",
    );
  });
});

test("the composer Stop cancels the run that holds the slot", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes(`/runs/${RUN_ID}/cancel`)) {
      return json({ run: { ...sessionResponse("canceled").runs[0], status: "canceled" } });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
  const view = renderContainer();

  const stop = await view.findByRole("button", { name: "Stop" });
  fireEvent.click(stop);

  await waitFor(() =>
    expect(requests.some((r) => r.url.includes(`/runs/${RUN_ID}/cancel`))).toBe(true),
  );
});

test("a queued message survives a stop and flushes afterwards", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/cancel")) {
      return json({ run: { ...sessionResponse("canceled").runs[0], status: "canceled" } });
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "actually use zod");
  pressEnter(box);
  await waitFor(() => expect(view.getByText(/actually use zod/)).toBeTruthy());

  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  // Stop cancels the turn only — the follow-up explaining WHY is exactly what
  // the user still wants delivered.
  setLiveStore(RUN_ID, { store: EMPTY_FRAME_STORE, status: "canceled" });

  await waitFor(() => {
    const posts = requests.filter((r) => r.url.includes("/messages"));
    expect((posts[0]?.body as { message: string }).message).toBe("actually use zod");
  });
});

test("a FAILED run flushes the queue too", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "try again with the other model");
  pressEnter(box);

  setLiveStore(RUN_ID, { store: EMPTY_FRAME_STORE, status: "failed" });

  await waitFor(() =>
    expect(requests.filter((r) => r.url.includes("/messages"))).toHaveLength(1),
  );
});

test("removing a queued row drops it before it is ever sent", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "scrap this one");
  pressEnter(box);
  await waitFor(() => expect(view.getByText(/scrap this one/)).toBeTruthy());

  fireEvent.click(view.getByRole("button", { name: /Remove queued message/ }));
  await waitFor(() => expectAbsent(() => view.queryByText(/scrap this one/), "the queued message"));
});

// ── the header's derived facts and the tool directory (spec D5/D6) ──────────

/**
 * The agent row as the header reads it: `publishedDefinition` is where the
 * PINNED VERSION's preset comes from (the resolved model id cannot name it —
 * `balanced` and `quick` are seeded onto the same model), and
 * `publishedVersionId` is what says the definition still describes the version
 * this session is pinned to.
 */
function agentResponse(
  preset: "powerful" | "balanced" | "quick",
  options: { publishedVersionId?: string; modelId?: string } = {},
) {
  return {
    agent: {
      id: AGENT_ID,
      name: "Report bot",
      description: null,
      runAsUserId: "user_1",
      draft: {},
      publishedVersionId: options.publishedVersionId ?? AGV_ID,
      publishedDefinition: {
        persona: "Be helpful.",
        model:
          options.modelId !== undefined
            ? { preset, modelId: options.modelId }
            : { preset },
        context: { mcpConnectionIds: [], skillIds: [] },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

/**
 * Serve the reads the header joins — the version's tool directory, the agent
 * row behind the pinned version, the workspace's model presets and its model
 * capabilities — alongside the session. Everything else 404s, which is itself
 * part of the contract: each of these is allowed to fail without taking the
 * thread with it.
 */
function headerHandler(title: string | null = null): Handler {
  return (method, url) => {
    if (
      method === "GET" &&
      url.endsWith(`/workspaces/${WS}/agents/${AGENT_ID}`)
    ) {
      return json(agentResponse("balanced"));
    }
    if (method === "GET" && url.includes(`/versions/${AGV_ID}/tools`)) {
      return json({
        directory: {
          agentVersionId: AGV_ID,
          connections: [
            {
              slug: "linear",
              connectionId: "cn_containerlinear1",
              connectionName: "Linear",
              tools: [
                {
                  name: "list_issues",
                  description: "List issues in a team, newest first.",
                  params: ["teamId"],
                },
              ],
            },
          ],
        },
      });
    }
    if (method === "GET" && url.includes("/model-presets")) {
      return json({
        presets: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            slug: "balanced",
            provider: "openrouter",
            modelId: "moonshotai/kimi-k3",
            reasoning: "high",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
    }
    if (method === "GET" && url.includes("/model-capabilities")) {
      return json({
        models: [
          {
            provider: "openrouter",
            modelId: "moonshotai/kimi-k3",
            supportedEfforts: ["high", "low"],
            contextWindowTokens: 1_048_576,
          },
        ],
        catalogAvailable: true,
      });
    }
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("succeeded", title));
    }
    if (method === "GET" && url.includes("/sessions")) return json({ sessions: [] });
    return json({}, 404);
  };
}

/** One settled run: an MCP tool call, a reply, and a measured step. */
function toolRunFrames(): RunEventFrame[] {
  const events: RunEventFrame["event"][] = [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: "moonshotai/kimi-k3" } } },
    { type: "actions.requested", data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "linear__list_issues", input: { limit: 5 } }], sequence: 0, stepIndex: 0, turnId: "t0" } },
    { type: "action.result", data: { result: { callId: "c1", kind: "tool-result", toolName: "linear__list_issues", output: { content: [{ type: "text", text: "5 issues: 2 bugs, 3 features" }] } }, status: "completed", sequence: 0, stepIndex: 0, turnId: "t0" } },
    { type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId: "t0", usage: { inputTokens: 262_144 } } },
    { type: "session.waiting", data: { wait: "next-user-message" } },
  ];
  return events.map((event, index) => ({
    runId: RUN_ID,
    seq: index,
    event,
    at: new Date(Date.UTC(2026, 6, 3, 0, 0, index)).toISOString(),
  }));
}

test("the thread resolves tool calls through the version's tool directory", async () => {
  handler = headerHandler();
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  const block = await view.findByRole("button", { name: /Worked/ });
  fireEvent.click(block);
  // The description only exists once the DIRECTORY has resolved — the
  // connection name alone would also appear from the slug fallback, so it is
  // the wrong thing to wait on.
  await waitFor(() =>
    expect(view.getByText("List issues in a team, newest first.")).toBeTruthy(),
  );
  expect(view.getByText("Linear ·")).toBeTruthy();
  expect(view.getByText("List issues")).toBeTruthy();
  // English, not JSON — and never the wire name.
  expect(view.getByText("5 issues: 2 bugs, 3 features")).toBeTruthy();
  expect(view.queryByText("linear__list_issues")).toBeNull();
});

test("the header meters the context against the catalog's window", async () => {
  handler = headerHandler();
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  // 262,144 of 1,048,576 = 25%.
  const meter = await view.findByRole("meter", { name: "Context used" });
  expect(meter.getAttribute("aria-valuenow")).toBe("25");
  // The model is named by its PRESET, and its raw id never appears.
  expect(view.getByText("Balanced")).toBeTruthy();
  expect(view.queryByText("moonshotai/kimi-k3")).toBeNull();
});

test("the header names the thread by its generated title, like the sidebar does", async () => {
  // The sidebar (SessionList) and this header must agree, or one conversation
  // reads as two different things depending on where you look at it. Both go
  // through `sessionRowTitle`; this is the header half of that contract.
  handler = headerHandler("Quarterly revenue breakdown");
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  // Assert on the heading, not on page text: the first message also appears in
  // the transcript as the user's own bubble, so a bare text query matches both.
  await waitFor(() =>
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "Quarterly revenue breakdown",
    ),
  );
});

test("the header falls back to the first message before a title is generated", async () => {
  // Titling is fire-and-forget and can fail silently (spec D9), so the
  // untitled case is the steady state, not an edge case.
  handler = headerHandler(null);
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  await waitFor(() =>
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "Send the report",
    ),
  );
});

test("no meter when the catalog knows no window for the resolved model", async () => {
  // The degradation that must never become a zero or a guess.
  const base = headerHandler();
  handler = (method, url, body) =>
    method === "GET" && url.includes("/model-capabilities")
      ? json({ models: [], catalogAvailable: false })
      : base(method, url, body);
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  await view.findByLabelText("Message");
  await waitFor(() => expect(view.getByText("Balanced")).toBeTruthy());
  expect(view.queryByRole("meter")).toBeNull();
});

// ── the preset label comes from the PINNED VERSION, not the model id ────────
//
// `balanced` and `quick` are seeded onto THE SAME model at different reasoning
// efforts (packages/db/src/seed.ts), so matching the resolved model id against
// the preset list can only ever return whichever the API listed first — which
// labelled every Quick session "Balanced".

/** The model `balanced` and `quick` share in a seeded workspace. */
const SHARED_MODEL_ID = "~deepseek/deepseek-v4-flash-latest";

/** One settled run on the shared model, with a measured step. */
function sharedModelRunFrames(): RunEventFrame[] {
  const events: RunEventFrame["event"][] = [
    { type: "session.started", data: { runtime: { agentId: "a", eveVersion: "0.31.3", modelId: SHARED_MODEL_ID } } },
    { type: "message.completed", data: { finishReason: "stop", message: "Done.", sequence: 0, stepIndex: 0, turnId: "t0" } },
    { type: "step.completed", data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId: "t0", usage: { inputTokens: 262_144 } } },
    { type: "session.waiting", data: { wait: "next-user-message" } },
  ];
  return events.map((event, index) => ({
    runId: RUN_ID,
    seq: index,
    event,
    at: new Date(Date.UTC(2026, 6, 3, 0, 0, index)).toISOString(),
  }));
}

/** headerHandler with both seeded deepseek presets and the shared-model catalog. */
function sharedModelHandler(agent: ReturnType<typeof agentResponse>): Handler {
  const base = headerHandler();
  return (method, url, body) => {
    if (method === "GET" && url.endsWith(`/workspaces/${WS}/agents/${AGENT_ID}`)) {
      return json(agent);
    }
    if (method === "GET" && url.includes("/model-presets")) {
      // The API's own order: Balanced before Quick, on ONE model id.
      return json({
        presets: [
          { id: "77777777-7777-4777-8777-777777777771", slug: "balanced", provider: "openrouter", modelId: SHARED_MODEL_ID, reasoning: "max", createdAt: NOW, updatedAt: NOW },
          { id: "77777777-7777-4777-8777-777777777772", slug: "quick", provider: "openrouter", modelId: SHARED_MODEL_ID, reasoning: "low", createdAt: NOW, updatedAt: NOW },
        ],
      });
    }
    if (method === "GET" && url.includes("/model-capabilities")) {
      return json({
        models: [
          { provider: "openrouter", modelId: SHARED_MODEL_ID, supportedEfforts: ["max", "low"], contextWindowTokens: 1_048_576 },
        ],
        catalogAvailable: true,
      });
    }
    return base(method, url, body);
  };
}

test("a Quick session is named Quick, though Balanced shares its model", async () => {
  handler = sharedModelHandler(agentResponse("quick"));
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, sharedModelRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  await waitFor(() => expect(view.getByText("Quick")).toBeTruthy());
  // The tier the agent does NOT run on must never appear.
  expect(view.queryAllByText("Balanced")).toHaveLength(0);
  expect(view.queryAllByText(SHARED_MODEL_ID)).toHaveLength(0);
});

test("an agent that overrode the model is named by the model, not by a preset", async () => {
  // A specific-model override wins over the preset at compile time, so there
  // is no preset to name — but D6 still forbids the raw slug, so the chip
  // degrades to the model's own short name.
  handler = sharedModelHandler(
    agentResponse("balanced", { modelId: SHARED_MODEL_ID }),
  );
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, sharedModelRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  await waitFor(() =>
    expect(view.getByText("Deepseek v4 flash latest")).toBeTruthy(),
  );
  expect(view.queryAllByText("Balanced")).toHaveLength(0);
  expect(view.queryAllByText(SHARED_MODEL_ID)).toHaveLength(0);
});

test("a session left on an older publish claims no preset at all", async () => {
  // Nothing serves an arbitrary version's definition, so the agent row only
  // describes the CURRENT publish. A session pinned to an older version must
  // not borrow that label — it names the model it actually resolved instead.
  handler = sharedModelHandler(
    agentResponse("quick", {
      publishedVersionId: "88888888-8888-4888-8888-888888888888",
    }),
  );
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, sharedModelRunFrames()),
    status: "succeeded",
  });
  const view = renderContainer();
  await waitFor(() =>
    expect(view.getByText("Deepseek v4 flash latest")).toBeTruthy(),
  );
  expect(view.queryAllByText("Quick")).toHaveLength(0);
});

// ── the memory boundary: the divider, and what it does to the meter ─────────

/** eve's `context.cleared`, as the control plane persists it on a run. */
function clearedFrame(runId: string, seq: number): RunEventFrame {
  return {
    runId,
    seq,
    event: {
      type: "context.cleared",
      data: { sequence: seq, sessionId: "eve1", turnId: "t0" },
    },
    at: new Date(Date.UTC(2026, 6, 3, 0, 1, 0)).toISOString(),
  };
}

test("an idle Clear draws its divider by re-attaching the drained run's tail", async () => {
  // Both control routes refuse a BUSY session, so no tail is attached when one
  // fires and nothing here would ever see eve's `context.cleared`. The control
  // plane drains those frames and appends them to the run in `marker`; the
  // client's whole job is to re-read that run, which is what makes the divider
  // both appear now and survive a reload (D4).
  const base = headerHandler();
  handler = (method, url, body) => {
    if (method === "POST" && url.endsWith(`/sessions/${SESSION_ID}/clear`)) {
      return json({
        session: sessionDto(SESSION_ID),
        status: "accepted",
        marker: { kind: "cleared", runId: RUN_ID },
      });
    }
    return base(method, url, body);
  };
  const settled = addFrames(EMPTY_FRAME_STORE, toolRunFrames());
  liveStores.set(RUN_ID, { store: settled, status: "succeeded" });

  const view = renderContainer();
  await view.findByLabelText("Message");
  // Counts, not nodes: a failed `toBeNull` on a DOM node serializes the whole
  // document into the report.
  expect(view.queryAllByRole("note")).toHaveLength(0);

  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  fireEvent.click(view.getByText("Clear context"));

  await waitFor(() => expect(reopenCalls).toContain(RUN_ID));
  // What the re-attached tail replays: the frame the drain persisted.
  setLiveStore(RUN_ID, {
    store: addFrames(settled, [clearedFrame(RUN_ID, settled.maxSeq + 1)]),
    status: "succeeded",
  });
  await waitFor(() =>
    expect(view.getByRole("note").textContent).toContain(
      "The agent no longer remembers the messages above.",
    ),
  );
});

test("a compact that summarized nothing never claims it did", async () => {
  // D4's edge case: compacting an empty or already-cleared context emits no
  // `compaction.*` at all, so the server answers a null marker. No divider —
  // and no toast saying earlier messages were summarized, because none were.
  const base = headerHandler();
  handler = (method, url, body) => {
    if (method === "POST" && url.endsWith(`/sessions/${SESSION_ID}/compact`)) {
      return json({
        session: sessionDto(SESSION_ID),
        status: "accepted",
        marker: null,
      });
    }
    return base(method, url, body);
  };
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });

  const view = renderContainer();
  await view.findByLabelText("Message");
  fireEvent.click(await view.findByRole("button", { name: "Session actions" }));
  fireEvent.click(view.getByText("Compact context"));

  await waitFor(() => expect(view.getByText(/Nothing to compact/)).toBeTruthy());
  expect(view.queryAllByText(/were summarized/)).toHaveLength(0);
  expect(view.queryAllByRole("note")).toHaveLength(0);
  expect(reopenCalls).not.toContain(RUN_ID);
});

test("the meter goes quiet at the newest boundary until a step re-measures", async () => {
  // The measurement lives on the run BEFORE the boundary, so a reverse scan
  // that crosses it keeps reporting the size of a context that was emptied —
  // D6's "absent, never a guess" applied to the one case that produces it.
  const RUN_2_ID = "66666666-6666-4666-8666-666666666666";
  const base = headerHandler();
  const twoRuns = (() => {
    const single = sessionResponse("succeeded");
    const first = single.runs[0]!;
    return {
      session: single.session,
      runs: [
        first,
        {
          ...first,
          id: RUN_2_ID,
          triggerEvent: { ...first.triggerEvent, message: "and again" },
        },
      ],
    };
  })();
  handler = (method, url, body) =>
    method === "GET" && url.includes(`/sessions/${SESSION_ID}`)
      ? json(twoRuns)
      : base(method, url, body);
  liveStores.set(RUN_ID, {
    store: addFrames(EMPTY_FRAME_STORE, toolRunFrames()),
    status: "succeeded",
  });
  // The clear landed on the LATER exchange: nothing has measured the emptied
  // context, so there is no honest numerator anywhere in the session.
  liveStores.set(RUN_2_ID, {
    store: addFrames(EMPTY_FRAME_STORE, [clearedFrame(RUN_2_ID, 0)]),
    status: "succeeded",
  });

  const view = renderContainer();
  await waitFor(() =>
    expect(view.getByRole("note").textContent).toContain(
      "The agent no longer remembers the messages above.",
    ),
  );
  expect(view.queryAllByRole("meter")).toHaveLength(0);
  // The rest of the header is unaffected — this hides the meter, not the chip.
  expect(view.getByText("Balanced")).toBeTruthy();
});
