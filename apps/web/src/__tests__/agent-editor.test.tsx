/**
 * Agent editor state tests:
 * - reducer semantics (persona/description/model/context/run-as actions,
 *   dedupe, override clearing, lossless PATCH round-trip)
 * - controller behavior over a mocked fetch (debounced autosave PATCH,
 *   piggybacked dry-run diagnostics routing, publish → build-status poll).
 *
 * The publish poll no longer belongs to the controller (spec D2) — the probe
 * injects its own {@link AgentPublishStore} so this file exercises the same
 * end-to-end path without touching the app singleton. The store's own
 * behavior (surviving unmount, workspace teardown) lives in
 * agent-publish-store.test.ts.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDefinition, AgentDto } from "@invisible-string/shared";

import { dryRunAgentDiagnostics } from "../lib/agents/diagnostics";
import {
  agentEditorReducer,
  agentEditorStatesEqual,
  agentPatchOf,
  emptyAgentDefinition,
  initAgentEditorState,
  type AgentEditorState,
} from "../lib/agents/model";
import { AgentPublishStore } from "../lib/agents/publish-store";
import { useAgentController } from "../lib/agents/useAgentController";

ensureDomForThisFile();

const WS = "org_test_1";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CONN_ID = "33333333-3333-4333-8333-333333333333";
const SKILL_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-03T00:00:00.000Z";

function agentRow(draft: unknown): AgentDto {
  return {
    id: AGENT_ID,
    name: "Executive assistant",
    description: "Handles the inbox.",
    runAsUserId: "user_1",
    draft: draft as AgentDto["draft"],
    publishedVersionId: null,
    publishedDefinition: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const STORED_DRAFT: AgentDefinition = {
  persona: "Be helpful.",
  model: { preset: "balanced", modelId: "deepseek/deepseek-v4-pro", reasoning: "medium" },
  context: { mcpConnectionIds: [CONN_ID], skillIds: [SKILL_ID] },
};

function initialState(): AgentEditorState {
  return initAgentEditorState(agentRow(STORED_DRAFT));
}

// ── reducer ──────────────────────────────────────────────────────────────────

test("initAgentEditorState parses the stored draft and row fields", () => {
  const state = initialState();
  expect(state.definition.persona).toBe("Be helpful.");
  expect(state.definition.model.modelId).toBe("deepseek/deepseek-v4-pro");
  expect(state.description).toBe("Handles the inbox.");
  expect(state.runAsUserId).toBe("user_1");
});

test("a shape-invalid stored draft degrades to the empty definition", () => {
  const state = initAgentEditorState(agentRow({ persona: 42 }));
  expect(state.definition).toEqual(emptyAgentDefinition());
});

test("agentPatchOf round-trips the stored draft losslessly", () => {
  const state = initialState();
  expect(agentPatchOf(state)).toEqual({
    draft: STORED_DRAFT,
    description: "Handles the inbox.",
    runAsUserId: "user_1",
  });
});

test("setPersona / setDescription update their fields; empty description clears to null", () => {
  let state = agentEditorReducer(initialState(), {
    type: "setPersona",
    markdown: "You are terse.",
  });
  expect(state.definition.persona).toBe("You are terse.");

  state = agentEditorReducer(state, { type: "setDescription", description: "" });
  expect(state.description).toBeNull();

  state = agentEditorReducer(state, {
    type: "setDescription",
    description: "New line",
  });
  expect(state.description).toBe("New line");
});

test("model actions: preset/reasoning set, clearing the override omits the key", () => {
  let state = agentEditorReducer(initialState(), {
    type: "setModelPreset",
    preset: "powerful",
  });
  expect(state.definition.model.preset).toBe("powerful");

  state = agentEditorReducer(state, { type: "setReasoning", reasoning: "high" });
  expect(state.definition.model.reasoning).toBe("high");

  state = agentEditorReducer(state, { type: "setModelId", modelId: undefined });
  expect("modelId" in state.definition.model).toBe(false);

  state = agentEditorReducer(state, {
    type: "setModelId",
    modelId: "z-ai/glm-5.2",
  });
  expect(state.definition.model.modelId).toBe("z-ai/glm-5.2");
});

test("setReasoning(undefined) actually CLEARS the effort (back to inherit)", () => {
  // The regression this guards: merging with `patch.reasoning ?? current`
  // makes the clear a silent no-op whenever a value is already set — and it
  // typechecks, so only this assertion catches it.
  let state = agentEditorReducer(initialState(), {
    type: "setReasoning",
    reasoning: "max",
  });
  expect(state.definition.model.reasoning).toBe("max");

  state = agentEditorReducer(state, {
    type: "setReasoning",
    reasoning: undefined,
  });
  expect("reasoning" in state.definition.model).toBe(false);

  // Unrelated model edits must not resurrect it.
  state = agentEditorReducer(state, {
    type: "setModelPreset",
    preset: "powerful",
  });
  expect("reasoning" in state.definition.model).toBe(false);
});

test("a brand-new agent draft INHERITS its effort (no reasoning key at all)", () => {
  expect("reasoning" in emptyAgentDefinition().model).toBe(false);
});

test("context actions dedupe adds and filter removes", () => {
  const start = initialState();
  const dup = agentEditorReducer(start, { type: "addConnection", id: CONN_ID });
  expect(dup).toBe(start); // identity bail-out on duplicates

  let state = agentEditorReducer(start, {
    type: "addConnection",
    id: "55555555-5555-4555-8555-555555555555",
  });
  expect(state.definition.context.mcpConnectionIds).toHaveLength(2);

  state = agentEditorReducer(state, { type: "removeConnection", id: CONN_ID });
  expect(state.definition.context.mcpConnectionIds).toEqual([
    "55555555-5555-4555-8555-555555555555",
  ]);

  state = agentEditorReducer(state, { type: "removeSkill", id: SKILL_ID });
  expect(state.definition.context.skillIds).toEqual([]);
});

test("draft_invalid issues with the server's DOT-JOINED string paths route to their section cards", () => {
  // The real wire shape: compile-service.ts parseAgentDefinition serializes
  // zod issues as {path: issue.path.join("."), message} — STRINGS, not arrays.
  const diagnostics = dryRunAgentDiagnostics({
    code: "draft_invalid",
    message: "draft failed validation",
    details: [
      { path: "model", message: "Invalid input: expected object, received undefined" },
      { path: "model.preset", message: "Invalid option" },
      { path: "context", message: "Invalid input: expected object, received undefined" },
      { path: "runAsUserId", message: "Required" },
      { path: "", message: "unrooted issue" },
    ],
  });
  expect(diagnostics.sections.model.map((d) => d.message)).toEqual([
    "model: Invalid input: expected object, received undefined",
    "model.preset: Invalid option",
  ]);
  expect(diagnostics.sections.context).toHaveLength(1);
  expect(diagnostics.sections.access).toHaveLength(1);
  // Pathless issues fall back to General with the bare message.
  expect(diagnostics.general.map((d) => d.message)).toEqual(["unrooted issue"]);
  // Defensive: a raw zod path ARRAY still routes.
  const arrayShape = dryRunAgentDiagnostics({
    code: "draft_invalid",
    message: "draft failed validation",
    details: [{ path: ["persona"], message: "Required" }],
  });
  expect(arrayShape.sections.persona.map((d) => d.message)).toEqual([
    "persona: Required",
  ]);
});

test("setRunAs swaps the credentials owner and flips equality", () => {
  const start = initialState();
  const state = agentEditorReducer(start, { type: "setRunAs", userId: "user_2" });
  expect(state.runAsUserId).toBe("user_2");
  expect(agentEditorStatesEqual(start, state)).toBe(false);
});

// ── controller (mocked fetch) ────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
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
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    recordedCalls.push({ method, url, body });
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

function ControllerProbe({ store }: { store: AgentPublishStore }) {
  const controller = useAgentController({
    workspaceId: WS,
    agent: agentRow(STORED_DRAFT),
    initialState: initAgentEditorState(agentRow(STORED_DRAFT)),
    // The stored override is allowlisted → the local mirror stays quiet and
    // the model card's single issue below comes from the PATCH's dry run.
    allowlist: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    publishStore: store,
  });
  return (
    <div>
      <p>save:{controller.saveStatus}</p>
      <p>dirty:{String(controller.isDirty)}</p>
      <p>lifecycle:{controller.lifecycle}</p>
      <p>phase:{controller.publishState.phase}</p>
      <p>model-issues:{controller.diagnostics.sections.model.length}</p>
      <p>persona-issues:{controller.diagnostics.sections.persona.length}</p>
      <button
        type="button"
        onClick={() =>
          controller.dispatch({ type: "setPersona", markdown: "You are terse." })
        }
      >
        edit
      </button>
      <button type="button" onClick={() => void controller.publish()}>
        publish
      </button>
    </div>
  );
}

function renderProbe(store = new AgentPublishStore({ pollIntervalMs: 10 })) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ControllerProbe store={store} />
    </QueryClientProvider>,
  );
}

test("autosave debounces, PATCHes the whole row slice, and consumes PATCH diagnostics", async () => {
  respond = (method) => {
    if (method === "PATCH") {
      return jsonResponse({
        agent: agentRow({ ...STORED_DRAFT, persona: "You are terse." }),
        diagnostics: {
          ok: false,
          error: {
            code: "compile_failed",
            message: "compile failed",
            details: [
              { message: "MODEL_MISMATCH: model is not on the allowlist" },
            ],
          },
        },
      });
    }
    return jsonResponse({ agents: [] });
  };

  const view = renderProbe();
  expect(view.getByText("dirty:false")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "edit" }));
  expect(view.getByText("dirty:true")).toBeTruthy();

  // Debounce (700 ms) → PATCH → saved + diagnostics routed to the model card.
  await waitFor(
    () => {
      expect(view.getByText("save:saved")).toBeTruthy();
    },
    { timeout: 3000 },
  );
  expect(view.getByText("dirty:false")).toBeTruthy();
  expect(view.getByText("model-issues:1")).toBeTruthy();

  const patches = recordedCalls.filter((call) => call.method === "PATCH");
  expect(patches.length).toBe(1);
  expect(patches[0]!.url).toContain(`/workspaces/${WS}/agents/${AGENT_ID}`);
  expect(patches[0]!.body).toEqual({
    draft: { ...STORED_DRAFT, persona: "You are terse." },
    description: "Handles the inbox.",
    runAsUserId: "user_1",
  });
});

test("publish flows through the build-status poll to ready", async () => {
  respond = (method, url) => {
    if (method === "POST" && url.includes("/publish")) {
      return jsonResponse({
        agentId: AGENT_ID,
        versionId: VERSION_ID,
        contentHash: "hash123",
        buildStatus: "building",
        cached: false,
        buildError: null,
      });
    }
    if (method === "GET" && url.includes(`/versions/${VERSION_ID}/build`)) {
      return jsonResponse({ status: "succeeded", error: null });
    }
    return jsonResponse({ agents: [] });
  };

  const view = renderProbe();
  fireEvent.click(view.getByRole("button", { name: "publish" }));

  await waitFor(
    () => {
      expect(view.getByText("phase:ready")).toBeTruthy();
    },
    { timeout: 3000 },
  );
  expect(
    recordedCalls.some(
      (call) =>
        call.method === "GET" &&
        call.url.includes(
          `/workspaces/${WS}/agents/${AGENT_ID}/versions/${VERSION_ID}/build`,
        ),
    ),
  ).toBe(true);
  // No pending edits, so publish must not fire a flush PATCH.
  expect(recordedCalls.some((call) => call.method === "PATCH")).toBe(false);
});

test("publish() RESOLVES on the POST, without waiting for the build (D2)", async () => {
  // The regression this guards: awaiting the build here is what made
  // "Chat with agent" sit on a spinner for the length of an `eve build`.
  let buildDone = false;
  respond = (method, url) => {
    if (method === "POST" && url.includes("/publish")) {
      return jsonResponse({
        agentId: AGENT_ID,
        versionId: VERSION_ID,
        contentHash: "hash123",
        buildStatus: "building",
        cached: false,
        buildError: null,
      });
    }
    if (method === "GET" && url.includes(`/versions/${VERSION_ID}/build`)) {
      return jsonResponse(
        buildDone
          ? { status: "succeeded", error: null }
          : { status: "building", error: null },
      );
    }
    return jsonResponse({ agents: [] });
  };

  let resolved: string | null = null;
  function ResolveProbe({ store }: { store: AgentPublishStore }) {
    const controller = useAgentController({
      workspaceId: WS,
      agent: agentRow(STORED_DRAFT),
      initialState: initAgentEditorState(agentRow(STORED_DRAFT)),
      allowlist: [],
      publishStore: store,
    });
    return (
      <button
        type="button"
        onClick={() =>
          void controller.publish().then((response) => {
            resolved = response?.buildStatus ?? "null";
          })
        }
      >
        publish
      </button>
    );
  }

  const store = new AgentPublishStore({ pollIntervalMs: 10 });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ResolveProbe store={store} />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "publish" }));

  // Resolves with the NON-terminal status while the build is still running…
  await waitFor(() => expect(resolved).toBe("building"));
  expect(store.stateOf(AGENT_ID).phase).toBe("building");

  // …and the store finishes the job on its own.
  buildDone = true;
  await waitFor(() => expect(store.stateOf(AGENT_ID).phase).toBe("ready"), {
    timeout: 3000,
  });
});

test("lifecycle: saved-but-behind reads 'unpublished', a never-published agent 'draft'", async () => {
  respond = () => jsonResponse({ agents: [] });

  // Never published → draft (NOT "unpublished changes" — nothing to be behind).
  const draft = renderProbe();
  expect(draft.getByText("lifecycle:draft")).toBeTruthy();
  cleanup();

  // Published, and the saved draft matches it → published.
  function LifecycleProbe({ published }: { published: unknown }) {
    const agent: AgentDto = {
      ...agentRow(STORED_DRAFT),
      publishedVersionId: VERSION_ID,
      publishedDefinition: published as AgentDto["publishedDefinition"],
    };
    const controller = useAgentController({
      workspaceId: WS,
      agent,
      initialState: initAgentEditorState(agent),
      allowlist: [],
      publishStore: new AgentPublishStore({ pollIntervalMs: 10 }),
    });
    return <p>lifecycle:{controller.lifecycle}</p>;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  // Key-ORDER differs from the reducer's own output on purpose: the published
  // definition arrives from postgres jsonb, so a stringify-based comparison
  // would call this identical draft "unpublished" forever.
  const reordered = {
    context: STORED_DRAFT.context,
    model: {
      reasoning: STORED_DRAFT.model.reasoning,
      modelId: STORED_DRAFT.model.modelId,
      preset: STORED_DRAFT.model.preset,
    },
    persona: STORED_DRAFT.persona,
  };
  const synced = render(
    <QueryClientProvider client={queryClient}>
      <LifecycleProbe published={reordered} />
    </QueryClientProvider>,
  );
  expect(synced.getByText("lifecycle:published")).toBeTruthy();
  cleanup();

  const behind = render(
    <QueryClientProvider client={queryClient}>
      <LifecycleProbe
        published={{ ...STORED_DRAFT, persona: "An older persona." }}
      />
    </QueryClientProvider>,
  );
  expect(behind.getByText("lifecycle:unpublished")).toBeTruthy();
});

test("lifecycle: a rename of a published agent is an UNPUBLISHED change", () => {
  // The controller must feed the NAME into the lifecycle, not just the two
  // definitions: `agentSlug` is still a content-hash input (spec D1), so a
  // rename re-keys the artifact and the running agent keeps introducing
  // itself by the old name until the next publish.
  respond = () => jsonResponse({ agents: [] });

  function RenamedProbe({ publishedName }: { publishedName: string }) {
    const agent = {
      ...agentRow(STORED_DRAFT),
      name: "Inbox triage",
      publishedVersionId: VERSION_ID,
      publishedDefinition: STORED_DRAFT as AgentDto["publishedDefinition"],
      publishedName,
    } as AgentDto;
    const controller = useAgentController({
      workspaceId: WS,
      agent,
      initialState: initAgentEditorState(agent),
      allowlist: [],
      publishStore: new AgentPublishStore({ pollIntervalMs: 10 }),
    });
    return <p>lifecycle:{controller.lifecycle}</p>;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const renamed = render(
    <QueryClientProvider client={queryClient}>
      <RenamedProbe publishedName="Untitled agent" />
    </QueryClientProvider>,
  );
  expect(renamed.getByText("lifecycle:unpublished")).toBeTruthy();
  cleanup();

  const unchanged = render(
    <QueryClientProvider client={queryClient}>
      <RenamedProbe publishedName="Inbox triage" />
    </QueryClientProvider>,
  );
  expect(unchanged.getByText("lifecycle:published")).toBeTruthy();
});
