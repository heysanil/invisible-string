/**
 * Copilot dock behavior against a scripted fake WebSocket: streamed thread,
 * proposal frame → card per mutation tool, Apply → controller action +
 * accepted mutation_result, Dismiss → rejected mutation_result, abort,
 * reconnect, a11y roles, and open-state persistence. Frames follow the
 * shared protocol in packages/shared/src/copilot.ts.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  AgentPresetDto,
  CopilotProposal,
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
const CONN_ID = "b1111111-1111-4111-8111-111111111111";

const definition: WorkflowDefinition = {
  trigger: { type: "manual" },
  context: { mcpConnectionIds: [], skillIds: [] },
  agent: { agentPresetId: PRESET_ID },
  instructions: { markdown: "Old line\nShared line" },
};

const resources = {
  connections: [],
  skills: [],
  connectionById: new Map([[CONN_ID, { id: CONN_ID, name: "zendesk" }]]),
  skillById: new Map(),
  isPending: false,
  isError: false,
} as unknown as ContextResources;

const agentPresets = [
  { id: PRESET_ID, name: "General" },
] as unknown as readonly AgentPresetDto[];

function proposal(overrides: Partial<CopilotProposal> = {}): CopilotProposal {
  return {
    id: "prop-1",
    tool: "setTrigger",
    params: {
      trigger: {
        type: "slack",
        binding: {
          mentionOnly: true,
          includeDirectMessages: false,
          channelId: "support",
        },
      },
    },
    rationale: "Support asks arrive in Slack.",
    ...overrides,
  } as CopilotProposal;
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

function sendUserMessage(socket: FakeWebSocket, text = "Help me") {
  fireEvent.input(q().getByLabelText("Ask copilot"), {
    target: { value: text },
  });
  // happy-dom does not synthesize form submission from a button click.
  const input = q().getByLabelText("Ask copilot") as HTMLInputElement;
  fireEvent.submit(input.closest("form")!);
  return JSON.parse(socket.sent.at(-1)!);
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

test("connects to the workspace-scoped copilot socket and sends nothing until asked", () => {
  renderDock();
  const socket = lastSocket();
  expect(socket.url).toContain("/workspaces/ws-1/copilot");
  act(() => socket.open());
  expect(socket.sent).toEqual([]);
});

test("user_message carries workflowId + live draft; deltas stream into one message; abort on stop", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());

  const frame = sendUserMessage(socket);
  expect(frame).toEqual({
    type: "user_message",
    workflowId: "wf-1",
    draft: definition,
    message: "Help me",
  });

  act(() => {
    socket.message({ type: "delta", text: "Hel" });
    socket.message({ type: "delta", text: "lo **you**" });
  });
  const thread = q().getByLabelText("Copilot conversation");
  expect(thread.getAttribute("aria-live")).toBe("polite");
  expect(thread.textContent).toContain("Hello");
  expect(thread.textContent).toContain("you");

  // Streaming ⇒ the stop affordance is up; clicking sends an abort frame.
  fireEvent.click(q().getByRole("button", { name: "Stop generating" }));
  expect(socket.frames().at(-1)).toEqual({ type: "abort" });

  act(() => socket.message({ type: "done", reason: "aborted" }));
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
  expect(frame.message).toBe("Set this up to triage Slack mentions");
  expect(frame.draft).toEqual(definition);
});

test("proposal frame renders a structured card; Apply routes through dispatch and reports accepted", () => {
  const applied = mock(() => {});
  const { dispatch } = renderDock({ onApplied: applied });
  const socket = lastSocket();
  act(() => socket.open());
  act(() => socket.message({ type: "proposal", proposal: proposal() }));

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
    type: "mutation_result",
    proposalId: "prop-1",
    outcome: "accepted",
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
      type: "proposal",
      proposal: proposal({
        id: "prop-2",
        tool: "addContext",
        params: { kind: "connection", id: CONN_ID },
      }),
    }),
  );
  expect(q().getByTestId("suggestion-card").textContent).toContain(
    "Add connection: zendesk",
  );
  fireEvent.click(q().getByRole("button", { name: "Dismiss" }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "mutation_result",
    proposalId: "prop-2",
    outcome: "rejected",
  });
  expect(q().getByTestId("suggestion-receipt").textContent).toContain(
    "Dismissed",
  );
});

test("setInstructions proposal renders an inline diff", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "proposal",
      proposal: proposal({
        id: "prop-3",
        tool: "setInstructions",
        params: { markdown: "New line\nShared line" },
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
      type: "proposal",
      proposal: proposal({
        id: "prop-4",
        tool: "setAgent",
        params: { agentPresetId: PRESET_ID },
      }),
    }),
  );
  const card = q().getByRole("group", { name: /Suggestion: Set agent/ });
  expect(card.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(card, { key: "Enter" });
  expect(dispatch).toHaveBeenCalledWith({ type: "setAgentPreset", id: PRESET_ID });
});

test("error frames render as alerts and end the generating state", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  sendUserMessage(socket);
  act(() =>
    socket.message({
      type: "error",
      code: "llm_error",
      message: "Model unavailable",
    }),
  );
  expect(q().getByRole("alert").textContent).toBe("Model unavailable");
  expect(q().queryByRole("button", { name: "Stop generating" })).toBeNull();
});

test("reconnects after a drop; the new socket can carry the next user_message", async () => {
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
  const frame = sendUserMessage(second, "Still here?");
  expect(frame).toMatchObject({
    type: "user_message",
    workflowId: "wf-1",
    message: "Still here?",
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
