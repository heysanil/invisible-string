/**
 * Copilot dock behavior against a scripted fake WebSocket: hello on connect,
 * streamed thread, suggestion frame → card per mutation type, Apply →
 * controller action + accepted report, Dismiss → rejected report, reconnect
 * resends the draft, a11y roles, and open-state persistence.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  AgentPresetDto,
  CopilotSuggestion,
  WorkflowDefinition,
} from "@invisible-string/shared";

import { CopilotDock } from "../components/builder/CopilotDock";
import type { ContextResources } from "../lib/builder/resources";
import type { WebSocketLike } from "../lib/copilot/socket";

ensureDomForThisFile();

// ── Fake WS fixture ─────────────────────────────────────────────────────────

type Listener = (event: unknown) => void;

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as Listener);
    this.listeners.set(type, list);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  // test drivers
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  frames(): { type: string }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }
}

const createWebSocket = (url: string) => new FakeWebSocket(url);

// `screen` binds document.body at import time — before happy-dom registers
// in this file's beforeAll — so query at call time instead.
const q = () => within(document.body);

// ── Fixtures ────────────────────────────────────────────────────────────────

const PRESET_ID = "a1111111-1111-4111-8111-111111111111";

const definition: WorkflowDefinition = {
  trigger: { type: "manual" },
  context: { mcpConnectionIds: [], skillIds: [] },
  agent: { agentPresetId: PRESET_ID },
  instructions: { markdown: "Old line\nShared line" },
};

const resources = {
  connections: [],
  skills: [],
  connectionById: new Map([["conn-1", { id: "conn-1", name: "zendesk" }]]),
  skillById: new Map(),
  isPending: false,
  isError: false,
} as unknown as ContextResources;

const agentPresets = [
  { id: PRESET_ID, name: "General" },
] as unknown as readonly AgentPresetDto[];

function suggestion(overrides: Partial<CopilotSuggestion> = {}): CopilotSuggestion {
  return {
    id: "sug-1",
    rationale: "Support asks arrive in Slack.",
    mutation: {
      kind: "setTrigger",
      trigger: {
        type: "slack",
        binding: {
          mentionOnly: true,
          includeDirectMessages: false,
          channelId: "support",
        },
      },
    },
    ...overrides,
  };
}

function renderDock(overrides: Record<string, unknown> = {}) {
  const dispatch = mock(() => {});
  const onApplied = mock(() => {});
  const view = render(
    <CopilotDock
      workspaceId="ws-1"
      workflowId="wf-1"
      definition={definition}
      dispatch={dispatch}
      resources={resources}
      agentPresets={agentPresets}
      modelPresets={[]}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
      {...overrides}
    />,
  );
  return { view, dispatch, onApplied };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  window.localStorage.setItem("is.copilot.open", "1");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ── Tests ───────────────────────────────────────────────────────────────────

test("collapsed pill when closed; opening persists to localStorage", () => {
  window.localStorage.setItem("is.copilot.open", "0");
  renderDock();
  expect(FakeWebSocket.instances.length).toBe(0);
  fireEvent.click(q().getByRole("button", { name: "Open Copilot" }));
  expect(window.localStorage.getItem("is.copilot.open")).toBe("1");
  expect(FakeWebSocket.instances.length).toBe(1);
});

test("sends client_hello with the draft on open", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  const frames = socket.sent.map((raw) => JSON.parse(raw));
  expect(frames).toEqual([
    { type: "client_hello", workflowId: "wf-1", draft: definition },
  ]);
});

test("streams assistant deltas into one message; stop sends a stop frame", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());

  fireEvent.input(q().getByLabelText("Ask copilot"), {
    target: { value: "Help me" },
  });
  // happy-dom does not synthesize form submission from a button click.
  const input = q().getByLabelText("Ask copilot") as HTMLInputElement;
  fireEvent.submit(input.closest("form")!);
  expect(socket.frames().at(-1)?.type).toBe("user_message");

  act(() => {
    socket.message({ type: "assistant_delta", messageId: "m1", text: "Hel" });
    socket.message({ type: "assistant_delta", messageId: "m1", text: "lo **you**" });
  });
  const thread = q().getByLabelText("Copilot conversation");
  expect(thread.getAttribute("aria-live")).toBe("polite");
  expect(thread.textContent).toContain("Hello");
  expect(thread.textContent).toContain("you");

  // Streaming ⇒ the stop affordance is up; clicking reports stop.
  fireEvent.click(q().getByRole("button", { name: "Stop generating" }));
  expect(socket.frames().at(-1)).toEqual({ type: "stop" });

  act(() => socket.message({ type: "assistant_done", messageId: "m1" }));
  expect(q().queryByRole("button", { name: "Stop generating" })).toBeNull();
});

test("empty-state example chips send a user_message", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  fireEvent.click(
    q().getByRole("button", { name: "Set this up to triage Slack mentions" }),
  );
  const frame = JSON.parse(socket.sent.at(-1)!);
  expect(frame.type).toBe("user_message");
  expect(frame.text).toBe("Set this up to triage Slack mentions");
  expect(frame.draft).toEqual(definition);
});

test("suggestion frame renders a structured card; Apply routes through dispatch and reports accepted", () => {
  const applied = mock(() => {});
  const { dispatch } = renderDock({ onApplied: applied });
  const socket = lastSocket();
  act(() => socket.open());
  act(() => socket.message({ type: "suggestion", suggestion: suggestion() }));

  const card = q().getByTestId("suggestion-card");
  expect(card.textContent).toContain("Set trigger: Slack — #support · @mentions");
  expect(card.textContent).toContain("Support asks arrive in Slack.");
  expect(q().getByTestId("before-after").textContent).toContain("Manual");

  fireEvent.click(q().getByRole("button", { name: /Apply/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setTrigger",
    trigger: {
      type: "slack",
      binding: {
        mentionOnly: true,
        includeDirectMessages: false,
        channelId: "support",
      },
    },
  });
  expect(applied).toHaveBeenCalledWith("trigger");
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "suggestion_decision",
    suggestionId: "sug-1",
    decision: "accepted",
  });
  // Card collapses to a ✓ receipt line.
  expect(q().queryByTestId("suggestion-card")).toBeNull();
  expect(q().getByTestId("suggestion-receipt").textContent).toContain("Applied");
});

test("Dismiss reports rejected without applying", () => {
  const { dispatch } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "suggestion",
      suggestion: suggestion({
        id: "sug-2",
        mutation: { kind: "addContext", contextKind: "connection", id: "conn-1" },
      }),
    }),
  );
  expect(q().getByTestId("suggestion-card").textContent).toContain(
    "Add connection: zendesk",
  );
  fireEvent.click(q().getByRole("button", { name: "Dismiss" }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "suggestion_decision",
    suggestionId: "sug-2",
    decision: "rejected",
  });
  expect(q().getByTestId("suggestion-receipt").textContent).toContain(
    "Dismissed",
  );
});

test("setInstructions suggestion renders an inline diff", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "suggestion",
      suggestion: suggestion({
        id: "sug-3",
        mutation: {
          kind: "setInstructions",
          markdown: "New line\nShared line",
        },
      }),
    }),
  );
  const diff = q().getByTestId("diff-view");
  const dels = diff.querySelectorAll('[data-diff="del"]');
  const adds = diff.querySelectorAll('[data-diff="add"]');
  expect([...dels].map((n) => n.textContent)).toEqual(["Old line"]);
  expect([...adds].map((n) => n.textContent)).toEqual(["New line"]);
  expect(diff.textContent).toContain("Shared line");
});

test("suggestion card is keyboard-operable (Enter applies)", () => {
  const { dispatch } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "suggestion",
      suggestion: suggestion({
        id: "sug-4",
        mutation: { kind: "setAgent", agentPresetId: PRESET_ID },
      }),
    }),
  );
  const card = q().getByRole("group", { name: /Suggestion: Set agent/ });
  expect(card.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(card, { key: "Enter" });
  expect(dispatch).toHaveBeenCalledWith({ type: "setAgentPreset", id: PRESET_ID });
});

test("copilot_error frames render as alerts", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() => socket.message({ type: "copilot_error", message: "Model unavailable" }));
  expect(q().getByRole("alert").textContent).toBe("Model unavailable");
});

test("reconnects after a drop and re-sends the draft hello", async () => {
  renderDock();
  const first = lastSocket();
  act(() => first.open());
  expect(FakeWebSocket.instances.length).toBe(1);

  act(() => first.drop());
  // Backoff base is 1ms — the replacement socket appears almost immediately.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(FakeWebSocket.instances.length).toBe(2);
  const second = lastSocket();
  act(() => second.open());
  expect(JSON.parse(second.sent[0]!)).toEqual({
    type: "client_hello",
    workflowId: "wf-1",
    draft: definition,
  });
});

test("unmount tears the socket down without reconnecting", async () => {
  const { view } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  view.unmount();
  expect(socket.readyState).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(FakeWebSocket.instances.length).toBe(1);
});


