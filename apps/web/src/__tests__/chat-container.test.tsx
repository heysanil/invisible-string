/**
 * ThreadContainer integration (happy-dom + real query hooks + mocked fetch):
 * the 409 session_busy composer flow (keep the draft, show a notice) and the
 * HITL approval POST /runs/:id/input round-trip that re-opens the stream.
 *
 * The SSE layer is mocked (useThreadStreams) so frames are injected directly;
 * everything else — useSession, usePostMessage, usePostRunInput — is real.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunEventFrame, RunStatus } from "@invisible-string/shared";
import { EMPTY_FRAME_STORE, addFrames, type FrameStore } from "../lib/chat/run-view";
import { renderWithRouter } from "../test/router";
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
const WF_ID = "33333333-3333-4333-8333-333333333333";
const WFV_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-03T00:00:00.000Z";

// ── mock useThreadStreams: feed a per-run store the test controls ───────────

const liveStores = new Map<string, { store: FrameStore; status: RunStatus | null }>();
const reopenCalls: string[] = [];

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
mock.module(streamsModulePath, () => ({
  useThreadStreams: ((runs, options) => {
    if (!streamsMockFlag.active) return realThreadStreams.useThreadStreams(runs, options);
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

function sessionResponse(status: RunStatus) {
  return {
    session: {
      id: SESSION_ID,
      workflowId: WF_ID,
      workflowVersionId: WFV_ID,
      origin: "chat",
      status: "active",
      eveSessionId: "eve1",
      createdAt: NOW,
      updatedAt: NOW,
    },
    runs: [
      {
        id: RUN_ID,
        agentSessionId: SESSION_ID,
        status,
        triggerEvent: {
          workflowId: WF_ID,
          triggerType: "manual",
          message: "Send the report",
          data: {},
          principal: { workspaceId: WS, source: "chat" },
        },
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

function renderContainer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithRouter(
    <QueryClientProvider client={client}>
      <ThreadContainer workspaceId={WS} sessionId={SESSION_ID} workflowName="Report bot" />
    </QueryClientProvider>,
  );
}

test("409 session_busy keeps the draft and shows a notice", async () => {
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
  fireEvent.input(box, { target: { value: "second message" } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));

  await waitFor(() => {
    expect(
      view.getByText(/still working|kept/i),
    ).toBeTruthy();
  });
  // Draft retained in the box for retry.
  await waitFor(() =>
    expect((view.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "second message",
    ),
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
