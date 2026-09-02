/**
 * Copilot dock behavior against a scripted fake WebSocket, driven through the
 * WORKFLOW surface adapter: streamed thread, proposal frame → card per
 * mutation tool, Apply → controller action + accepted mutation_result,
 * Dismiss → rejected mutation_result, off-surface proposals, abort,
 * reconnect, a11y roles, and open-state persistence. Frames follow the
 * shared protocol in packages/shared/src/copilot.ts (`user_message` names
 * `surface` + `entityId`; the socket itself is per-workspace).
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  CopilotProposal,
  PipelineStep,
  WorkflowConfig,
} from "@invisible-string/shared";

import { CopilotDock } from "../components/copilot/CopilotDock";
import { CONVERT_PROMPT, workflowCopilotAdapter } from "../lib/copilot/mutations";
import type { WebSocketLike } from "../lib/copilot/socket";
import { FIXTURE_AGENTS, FIXTURE_AGENT_IDS } from "../lib/agents/fixtures";
import { pasteInto, pressEnter } from "../test/editor";

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

const AGENTS = FIXTURE_AGENTS.map((entry) => entry.summary);
const EXEC_ID = FIXTURE_AGENT_IDS.execAssistant;
const CONNECTION_ID = "cn_slack12345678";

/** Minted-shaped step id from a mnemonic (charset [0-9a-z], length 16). */
function sid(mnemonic: string): string {
  return `st_${mnemonic.padEnd(16, "0").slice(0, 16)}`;
}

const searchStep: PipelineStep = {
  id: sid("search"),
  slug: "search",
  name: "Search Slack",
  kind: "tool",
  connectionId: CONNECTION_ID,
  tool: "search_messages",
  args: { query: { $tpl: "@trigger.text" } },
  sideEffect: "at_least_once",
};

const summarizeStep: PipelineStep = {
  id: sid("summarize"),
  slug: "summarize",
  kind: "infer",
  preset: "quick",
  prompt: { markdown: "Old line\nShared line" },
};

const agentStep: PipelineStep = {
  id: sid("delegate"),
  slug: "delegate",
  kind: "agent",
  agentId: EXEC_ID,
  instructions: { markdown: "Do the thing." },
  session: "fresh",
};

const definition: WorkflowConfig = {
  version: 2,
  trigger: { type: "manual" },
  steps: [searchStep, summarizeStep],
  overlap: "skip",
};

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

function renderDock(
  options: {
    draft?: WorkflowConfig;
    dispatch?: ReturnType<typeof mock>;
    onApplied?: ReturnType<typeof mock>;
  } = {},
) {
  const dispatch = options.dispatch ?? mock(() => {});
  const onApplied = options.onApplied ?? mock(() => {});
  // Mutable holder so tests can move the "live" draft under the adapter.
  const draft = { current: options.draft ?? definition };
  const adapter = workflowCopilotAdapter({
    workflowId: "wf-1",
    getDraft: () => draft.current,
    dispatch,
    agents: AGENTS,
    connections: [{ id: CONNECTION_ID, name: "Slack" }],
    onApplied,
  });
  const view = render(
    <CopilotDock
      workspaceId="ws-1"
      adapter={adapter}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
    />,
  );
  return { view, dispatch, onApplied, draft, adapter };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

/** The composer is a Tiptap editor — see test/editor.ts for the input path. */
function composer(): HTMLElement {
  return q().getByLabelText("Ask copilot");
}

/** Non-throwing lookup — the composer does not exist until the chunk lands. */
function findComposer(): HTMLElement | null {
  return q().queryByLabelText("Ask copilot");
}

/**
 * Wait for the composer to mount AND take focus, polling both conditions.
 *
 * The composer is lazily imported, so until the chunk resolves there is no
 * "Ask copilot" label at all — which is why this polls a QUERY (nullable)
 * rather than a `getBy*` (throws). WHEN it resolves is a property of the
 * machine, not of the code, so a fixed sleep is always a bet.
 *
 * This assertion earned its keep: it caught a real production bug where a
 * focus() arriving before `useEditor` produced an instance was dropped on the
 * floor (RichTextEditor's `isLive` guard, now queued and replayed). Under
 * `@tiptap/react`'s module-scope `isSSR` latch the editor is created AFTER the
 * first render, so that window is wide — the test failed on CI for months of
 * file-ordering luck away from failing everywhere.
 *
 * Deliberately NOT `waitFor`: it wraps every poll in `act()`, which here also
 * flushes the dock's reconnect timers and fake sockets — measured at ~460s for
 * this file versus ~1s for this loop.
 */
async function waitForComposerFocus(): Promise<void> {
  // ~3s of budget, which costs nothing when the condition is already true.
  for (let attempt = 0; attempt < 300; attempt++) {
    const target = findComposer();
    if (target !== null && document.activeElement === target) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  // Out of budget — assert so the failure reports the real diff, not a timeout.
  expect(document.activeElement).toBe(composer());
}

function sendUserMessage(socket: FakeWebSocket, text = "Help me") {
  const box = composer();
  pasteInto(box, text);
  pressEnter(box);
  return JSON.parse(socket.sent.at(-1)!);
}

// Open-state persistence is scoped per workspace (renderDock uses ws-1).
const OPEN_KEY = "is.copilot.open:ws-1";

beforeEach(() => {
  FakeWebSocket.instances = [];
  window.localStorage.setItem(OPEN_KEY, "1");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ── Tests ───────────────────────────────────────────────────────────────────

test("collapsed pill when closed; opening persists to the per-workspace key and focuses the composer", async () => {
  window.localStorage.setItem(OPEN_KEY, "0");
  renderDock();
  expect(FakeWebSocket.instances.length).toBe(0);
  const pill = q().getByRole("button", { name: "Open Copilot" });
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(pill);
  expect(window.localStorage.getItem(OPEN_KEY)).toBe("1");
  expect(FakeWebSocket.instances.length).toBe(1);
  // Focus lands on the composer, not <body>. See waitForComposerFocus for
  // why this polls rather than sleeping a fixed interval.
  await waitForComposerFocus();
  // Explicit budget: the lazy chunk load is what makes this slow on a loaded
  // runner, and it happens inside render() — before the poll even starts.
}, 30_000);

test("collapsing returns focus to the pill", () => {
  renderDock();
  fireEvent.click(q().getByRole("button", { name: "Collapse Copilot" }));
  const pill = q().getByRole("button", { name: "Open Copilot" });
  expect(document.activeElement).toBe(pill);
});

test("connects to the workspace-scoped copilot socket and sends nothing until asked", () => {
  renderDock();
  const socket = lastSocket();
  expect(socket.url).toContain("/workspaces/ws-1/copilot");
  act(() => socket.open());
  expect(socket.sent).toEqual([]);
});

test("user_message names the workflow surface + entity and carries the live draft; deltas stream; abort on stop", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());

  const frame = sendUserMessage(socket);
  expect(frame).toEqual({
    type: "user_message",
    surface: "workflow",
    entityId: "wf-1",
    draft: definition,
    message: "Help me",
  });

  act(() => {
    socket.message({ type: "delta", text: "Hel" });
    socket.message({ type: "delta", text: "lo **you**" });
  });
  const thread = q().getByLabelText("Copilot conversation");
  // The thread is a log; announcements go through a dedicated live region so
  // screen readers are not spammed once per streamed token.
  expect(thread.getAttribute("role")).toBe("log");
  expect(thread.getAttribute("aria-live")).toBe("off");
  expect(q().getByRole("status").textContent).toContain("Copilot is responding");
  expect(thread.textContent).toContain("Hello");
  expect(thread.textContent).toContain("you");

  // Streaming ⇒ the stop affordance is up; clicking sends an abort frame.
  fireEvent.click(q().getByRole("button", { name: "Stop generating" }));
  expect(socket.frames().at(-1)).toEqual({ type: "abort" });

  act(() => socket.message({ type: "done", reason: "aborted" }));
  expect(q().queryByRole("button", { name: "Stop generating" })).toBeNull();
});

test("empty-state chips are draft-aware and send a user_message", () => {
  // The fixture draft has steps → refinement chips, not the scaffold ones
  // (which would be destructive on a configured draft).
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  expect(
    q().queryByRole("button", { name: "Set this up to triage Slack mentions" }),
  ).toBeNull();
  fireEvent.click(
    q().getByRole("button", { name: "Explain this pipeline's issues" }),
  );
  const frame = JSON.parse(socket.sent.at(-1)!);
  expect(frame.type).toBe("user_message");
  expect(frame.message).toBe("Explain this pipeline's issues");
  expect(frame.draft).toEqual(definition);
});

test("a blank draft shows scaffold chips", () => {
  renderDock({
    draft: {
      version: 2,
      trigger: { type: "manual" },
      steps: [],
      overlap: "skip",
    } satisfies WorkflowConfig,
  });
  const socket = lastSocket();
  act(() => socket.open());
  expect(
    q().getByRole("button", { name: "Set this up to triage Slack mentions" }),
  ).toBeTruthy();
});

test("a single-agent-step pipeline offers the conversion chip", () => {
  renderDock({ draft: { ...definition, steps: [agentStep] } });
  const socket = lastSocket();
  act(() => socket.open());
  fireEvent.click(q().getByRole("button", { name: CONVERT_PROMPT }));
  expect(JSON.parse(socket.sent.at(-1)!).message).toBe(CONVERT_PROMPT);
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
  expect(applied).toHaveBeenCalledWith({ kind: "trigger" });
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "mutation_result",
    proposalId: "prop-1",
    outcome: "accepted",
  });
  // Card collapses to a ✓ receipt line.
  expect(q().queryByTestId("suggestion-card")).toBeNull();
  expect(q().getByTestId("suggestion-receipt").textContent).toContain("Applied");
});

test("addStep proposal renders a ghost step card; Dismiss reports rejected without applying", () => {
  const { dispatch } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  const newStep: PipelineStep = {
    id: sid("newtool"),
    slug: "file-issue",
    kind: "tool",
    connectionId: CONNECTION_ID,
    tool: "create_issue",
    args: { title: { $tpl: "@steps.summarize.result" } },
    sideEffect: "at_least_once",
  };
  act(() =>
    socket.message({
      type: "proposal",
      proposal: proposal({
        id: "prop-2",
        tool: "addStep",
        params: { step: newStep, position: { after: sid("summarize") } },
      }),
    }),
  );
  const card = q().getByTestId("suggestion-card");
  expect(card.textContent).toContain("Add step: file-issue");
  // The rich preview: ghost mini-card + position phrase + args table.
  const preview = within(card).getByTestId("step-preview");
  expect(within(preview).getByTestId("step-mini-card").textContent).toContain(
    "create_issue",
  );
  expect(preview.textContent).toContain("after “summarize”");
  expect(within(preview).getByTestId("args-diff").textContent).toContain(
    "@steps.summarize.result",
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

test("updateStep proposal renders the prompt as an inline diff; Apply dispatches the action", () => {
  const { dispatch } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  const updated: PipelineStep = {
    ...summarizeStep,
    prompt: { markdown: "New line\nShared line" },
  };
  act(() =>
    socket.message({
      type: "proposal",
      proposal: proposal({
        id: "prop-3",
        tool: "updateStep",
        params: { stepId: sid("summarize"), step: updated },
      }),
    }),
  );
  const diff = q().getByTestId("diff-view");
  const dels = diff.querySelectorAll('[data-diff="del"]');
  const adds = diff.querySelectorAll('[data-diff="add"]');
  // Each row carries an aria-hidden +/− gutter glyph (non-color diff cue).
  expect([...dels].map((n) => n.textContent)).toEqual(["−Old line"]);
  expect([...adds].map((n) => n.textContent)).toEqual(["+New line"]);
  expect(diff.textContent).toContain("Shared line");

  fireEvent.click(q().getByRole("button", { name: /Apply/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "updateStep",
    stepId: sid("summarize"),
    step: updated,
  });
});

test("read-tool step frames render in the work rail with humanized names", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() => {
    socket.message({
      type: "step",
      key: "call-read-1",
      toolName: "searchConnectionTools",
      state: "ok",
      resultPreview: "3 tools matched",
    });
    socket.message({
      type: "step",
      key: "call-read-2",
      toolName: "getConnectionTool",
      state: "pending",
      resultPreview: null,
    });
  });
  const box = q().getByTestId("copilot-work");
  expect(box.textContent).toContain("Search connection tools");
  expect(box.textContent).toContain("3 tools matched");
  expect(box.textContent).toContain("Get connection tool");
});

test("suggestion card is keyboard-operable (Enter applies) and flashes the step", () => {
  const applied = mock(() => {});
  const { dispatch } = renderDock({ onApplied: applied });
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "proposal",
      proposal: proposal({
        id: "prop-4",
        tool: "removeStep",
        params: { stepId: sid("search") },
      }),
    }),
  );
  const card = q().getByRole("group", { name: /Suggestion: Remove step/ });
  expect(card.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(card, { key: "Enter" });
  expect(dispatch).toHaveBeenCalledWith({
    type: "removeStep",
    stepId: sid("search"),
  });
  expect(applied).toHaveBeenCalledWith({ kind: "step", stepId: sid("search") });
});

test("an off-surface proposal renders as unsupported and applies as a no-op", () => {
  const { dispatch, onApplied } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "proposal",
      // Agent-surface tool arriving on the workflow surface = server bug.
      proposal: proposal({
        id: "prop-5",
        tool: "setPersona",
        params: { markdown: "You are helpful." },
      }),
    }),
  );
  const card = q().getByTestId("suggestion-card");
  expect(card.textContent).toContain("Unsupported suggestion (setPersona)");
  fireEvent.click(q().getByRole("button", { name: /Apply/ }));
  // The adapter ignores it — no reducer action, no section flash — but the
  // decision is still reported so the server's tool loop can move on.
  expect(dispatch).not.toHaveBeenCalled();
  expect(onApplied).not.toHaveBeenCalled();
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "mutation_result",
    proposalId: "prop-5",
    outcome: "accepted",
  });
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
    surface: "workflow",
    entityId: "wf-1",
    message: "Still here?",
  });
});

test("composer keeps its text until the socket accepts the frame", () => {
  renderDock();
  const socket = lastSocket();
  // Socket not open yet: submit must neither clear the composer nor lose the
  // message silently.
  const box = composer();
  pasteInto(box, "early bird");
  pressEnter(box);
  expect(socket.sent).toEqual([]);
  expect(box.textContent).toBe("early bird");
  // Once open, the same gesture goes through and clears the composer.
  act(() => socket.open());
  pressEnter(box);
  expect(JSON.parse(socket.sent.at(-1)!).message).toBe("early bird");
  expect(box.textContent).toBe("");
});

test("submits are blocked while a turn is generating (no orphaned bubbles)", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  sendUserMessage(socket, "first");
  const box = composer();
  pasteInto(box, "second while busy");
  pressEnter(box);
  const userFrames = socket
    .frames()
    .filter((frame) => frame.type === "user_message");
  expect(userFrames).toHaveLength(1);
  // The text stays in the composer for after the turn.
  expect(box.textContent).toBe("second while busy");
});

test("a mid-turn connection drop leaves a visible notice in the thread", async () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  sendUserMessage(socket);
  act(() => socket.message({ type: "delta", text: "Two suggestions" }));
  act(() => socket.drop());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(q().getByTestId("copilot-notice").textContent).toContain("cut short");
});

test("thinking indicator shows between send and first token; pending proposal shows the follow-up hint", () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  sendUserMessage(socket);
  expect(q().getByTestId("copilot-thinking").textContent).toContain("Thinking");
  act(() => socket.message({ type: "proposal", proposal: proposal() }));
  expect(q().getByTestId("copilot-thinking").textContent).toContain(
    "More suggestions may follow",
  );
  act(() => socket.message({ type: "done", reason: "completed" }));
  expect(q().queryByTestId("copilot-thinking")).toBeNull();
});

test("receipt description is frozen at decision time (no drift as the draft changes)", () => {
  const { view, draft } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() =>
    socket.message({
      type: "proposal",
      proposal: proposal({
        id: "prop-freeze",
        tool: "removeStep",
        params: { stepId: sid("search") },
      }),
    }),
  );
  expect(q().getByTestId("suggestion-card").textContent).toContain(
    "Remove step: Search Slack",
  );
  fireEvent.click(q().getByRole("button", { name: /Apply/ }));
  // Simulate the applied draft flowing back down: the step is gone, so a live
  // card could no longer resolve the id and would degrade to the raw st_ id.
  draft.current = { ...definition, steps: [summarizeStep] };
  view.rerender(
    <CopilotDock
      workspaceId="ws-1"
      adapter={workflowCopilotAdapter({
        workflowId: "wf-1",
        getDraft: () => draft.current,
        dispatch: mock(() => {}),
        agents: AGENTS,
      })}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
    />,
  );
  // The receipt keeps the pending-time title instead of drifting to the id.
  expect(q().getByTestId("suggestion-receipt").textContent).toContain(
    "Applied — Remove step: Search Slack",
  );
});

test("applying the focused card moves focus to the composer (not <body>)", async () => {
  renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  act(() => socket.message({ type: "proposal", proposal: proposal() }));
  const card = q().getByTestId("suggestion-card");
  card.focus();
  fireEvent.keyDown(card, { key: "Enter" });
  // Same lazy-editor focus chain as the open-the-dock case above.
  await waitForComposerFocus();
}, 30_000);

test("unmount tears the socket down without reconnecting", async () => {
  const { view } = renderDock();
  const socket = lastSocket();
  act(() => socket.open());
  view.unmount();
  expect(socket.readyState).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(FakeWebSocket.instances.length).toBe(1);
});
