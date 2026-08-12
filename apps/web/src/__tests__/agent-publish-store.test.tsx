/**
 * The workspace-level publish store (spec D2).
 *
 * The behavior under test is the one the old in-controller poll could not
 * have: a build watch that OUTLIVES the editor. Everything else here exists
 * to keep that honest — announcements fire exactly once per settle, a
 * transient poll failure is not a build failure, a superseded publish does not
 * leave a second loop writing into the same agent, and leaving the workspace
 * tears the whole thing down.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  BuildStatusResponse,
  PublishAgentResponse,
} from "@invisible-string/shared";

import {
  AgentPublishStore,
  type AgentPublishSink,
  type AgentPublishWatch,
} from "../lib/agents/publish-store";
import type { PublishAnnouncement } from "../lib/agents/publish-machine";
import { initAgentEditorState } from "../lib/agents/model";
import { useAgentController } from "../lib/agents/useAgentController";
import type { AgentDto } from "@invisible-string/shared";

ensureDomForThisFile();
afterEach(cleanup);

const WS = "org_test_1";
const OTHER_WS = "org_test_2";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-11T00:00:00.000Z";

function published(
  overrides: Partial<PublishAgentResponse> = {},
): PublishAgentResponse {
  return {
    agentId: AGENT_ID,
    versionId: VERSION_ID,
    contentHash: "hash123",
    buildStatus: "building",
    cached: false,
    buildError: null,
    ...overrides,
  };
}

interface Recorder {
  sink: AgentPublishSink;
  announcements: PublishAnnouncement[];
  settled: AgentPublishWatch[];
}

function recorder(): Recorder {
  const announcements: PublishAnnouncement[] = [];
  const settled: AgentPublishWatch[] = [];
  return {
    announcements,
    settled,
    sink: {
      toast: (announcement) => announcements.push(announcement),
      settled: (watch) => settled.push(watch),
    },
  };
}

/** A store whose poll returns the scripted statuses, one per call. */
function scriptedStore(
  script: readonly (BuildStatusResponse | Error)[],
  calls: string[] = [],
) {
  let index = 0;
  return new AgentPublishStore({
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
    fetchBuildStatus: async (workspaceId, agentId, versionId) => {
      calls.push(`${workspaceId}/${agentId}/${versionId}`);
      const next = script[Math.min(index++, script.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  });
}

// ── settling ────────────────────────────────────────────────────────────────

test("a cache hit settles on the POST itself and announces by NAME", () => {
  const store = scriptedStore([]);
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  expect(store.stateOf(AGENT_ID).phase).toBe("compiling");

  store.received(
    AGENT_ID,
    published({ buildStatus: "succeeded", cached: true }),
  );

  expect(store.stateOf(AGENT_ID).phase).toBe("ready");
  expect(sink.announcements).toEqual([
    {
      variant: "success",
      message: "“Release bot” published — build served from cache.",
    },
  ]);
  expect(sink.settled).toHaveLength(1);
});

test("a fresh build polls to succeeded and announces exactly once", async () => {
  const calls: string[] = [];
  const store = scriptedStore(
    [
      { status: "building", error: null },
      { status: "building", error: null },
      { status: "succeeded", error: null },
    ],
    calls,
  );
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published());
  expect(store.stateOf(AGENT_ID).phase).toBe("building");

  await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("ready"));
  expect(calls).toEqual(Array(3).fill(`${WS}/${AGENT_ID}/${VERSION_ID}`));
  expect(sink.announcements).toEqual([
    { variant: "success", message: "“Release bot” published and built." },
  ]);
  // The POST's own fields survive the poll — the rail's ready card reads
  // `cached` off them, so a polled success must not fake it.
  expect(store.stateOf(AGENT_ID).result?.contentHash).toBe("hash123");
  expect(store.stateOf(AGENT_ID).result?.cached).toBe(false);
});

test("a failed build announces the FIRST line of the compiler output", async () => {
  const store = scriptedStore([
    {
      status: "failed",
      error: "eve build failed\n  at agent.ts:12\n  at runtime.ts:3",
    },
  ]);
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published());

  await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("error"));
  expect(sink.announcements).toEqual([
    {
      variant: "error",
      message: "“Release bot” failed to publish. eve build failed",
    },
  ]);
  // …while the rail still gets the whole thing.
  expect(store.stateOf(AGENT_ID).error).toContain("at agent.ts:12");
});

test("a transient poll failure is retried, never mistaken for a build failure", async () => {
  const store = scriptedStore([
    new Error("network down"),
    new Error("network down"),
    { status: "succeeded", error: null },
  ]);
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published());

  await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("ready"));
  expect(sink.announcements.map((a) => a.variant)).toEqual(["success"]);
});

test("a POST failure settles without ever polling", () => {
  const calls: string[] = [];
  const store = scriptedStore([{ status: "succeeded", error: null }], calls);
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.failed(AGENT_ID, "Could not reach the server.");

  expect(store.stateOf(AGENT_ID).phase).toBe("error");
  expect(calls).toHaveLength(0);
  expect(sink.announcements[0]?.message).toContain("Could not reach the server.");
});

// ── lifecycle of the watch itself ───────────────────────────────────────────

test("republishing supersedes the running loop — one announcement, not two", async () => {
  let resolveFirst: ((value: BuildStatusResponse) => void) | null = null;
  const store = new AgentPublishStore({
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
    fetchBuildStatus: () =>
      resolveFirst
        ? Promise.resolve({ status: "succeeded", error: null })
        : new Promise<BuildStatusResponse>((resolve) => {
            resolveFirst = resolve;
          }),
  });
  const sink = recorder();
  store.setSink(sink.sink);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published());
  await waitFor(() => expect(resolveFirst).not.toBeNull());

  // Second publish while the first poll is parked on its fetch.
  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published({ buildStatus: "succeeded" }));
  expect(store.stateOf(AGENT_ID).phase).toBe("ready");

  // The abandoned loop's answer must not re-announce or re-open the watch.
  resolveFirst!({ status: "failed", error: "stale" });
  await Promise.resolve();
  expect(store.stateOf(AGENT_ID).phase).toBe("ready");
  expect(sink.announcements).toHaveLength(1);
});

test("leaving the workspace cancels the watch and stops the poll", async () => {
  const calls: string[] = [];
  const store = scriptedStore([{ status: "building", error: null }], calls);
  const sink = recorder();
  store.setSink(sink.sink);
  store.setActiveWorkspace(WS);

  store.begin({ workspaceId: WS, agentId: AGENT_ID, agentName: "Release bot" });
  store.received(AGENT_ID, published());
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));

  store.setActiveWorkspace(OTHER_WS);
  expect(store.watchOf(AGENT_ID)).toBeUndefined();
  expect(store.stateOf(AGENT_ID).phase).toBe("idle");

  const seen = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls.length).toBe(seen);
  expect(sink.announcements).toHaveLength(0);
});

// ── the case the whole store exists for ─────────────────────────────────────

function agentRow(): AgentDto {
  return {
    id: AGENT_ID,
    name: "Release bot",
    description: null,
    runAsUserId: "user_1",
    draft: {
      persona: "Ship it.",
      model: { preset: "balanced" },
      context: { mcpConnectionIds: [], skillIds: [] },
    },
    publishedVersionId: null,
    publishedDefinition: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function EditorProbe({ store }: { store: AgentPublishStore }) {
  const agent = agentRow();
  const controller = useAgentController({
    workspaceId: WS,
    agent,
    initialState: initAgentEditorState(agent),
    allowlist: [],
    publishStore: store,
  });
  return (
    <button type="button" onClick={() => void controller.publish()}>
      publish
    </button>
  );
}

test("the build watch OUTLIVES the editor unmount (D2's navigate-away case)", async () => {
  // The exact regression: publish, then leave for /chat. The old poll lived in
  // useAgentController and was cancelled on unmount, so the build finished in
  // silence and nothing ever told the user.
  const realFetch = globalThis.fetch;
  let buildDone = false;
  let statusPolls = 0;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/publish")) {
      return new Response(JSON.stringify(published()), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes(`/versions/${VERSION_ID}/build`)) {
      statusPolls += 1;
      return new Response(
        JSON.stringify({
          status: buildDone ? "succeeded" : "building",
          error: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ agents: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    // A real store: default fetcher, only the cadence shortened.
    const store = new AgentPublishStore({ pollIntervalMs: 5 });
    const sink = recorder();
    store.setSink(sink.sink);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <EditorProbe store={store} />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByRole("button", { name: "publish" }));
    await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("building"));

    // Navigate away.
    view.unmount();
    const pollsAtUnmount = statusPolls;
    await waitFor(() => expect(statusPolls).toBeGreaterThan(pollsAtUnmount));

    // …and the build lands with nobody watching.
    buildDone = true;
    await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("ready"), {
      timeout: 3000,
    });
    expect(sink.announcements).toEqual([
      { variant: "success", message: "“Release bot” published and built." },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
