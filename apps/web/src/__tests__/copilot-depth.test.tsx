/**
 * Copilot dock DEPTH + REACH (2026-08-11 spec D7), driven through the AGENT
 * surface adapter against a scripted fake WebSocket:
 *
 * - D7.1 thinking and steps render as the chat's rail-in-box grammar, and a
 *   step that already has a suggestion card is not ALSO rendered as a rail row;
 * - D7.2 the allow-edits switch is session-scoped, defaults off, rides the
 *   `user_message` frame, is unmistakable while on, and auto-applied proposals
 *   apply through the surface controller while still leaving a card behind;
 * - D7.3/D7.4 `setName` / `setDescription` cards, where the name takes the
 *   header's commit seam and the description takes the editor reducer, and
 *   the agent's row IDENTITY rides the `user_message` frame so the copilot is
 *   not blind to what the agent it is editing is called.
 *
 * The rename seam is a PATCH, so it also carries the async/failure contract:
 * a card may not print a receipt before the write lands, and may never print
 * "Applied" when it did not.
 *
 * The dock's own baseline behavior (thread, focus choreography, persistence,
 * reconnect) lives in copilot-dock.test.tsx on the workflow surface.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  AgentDefinition,
  CopilotProposal,
  CopilotServerFrame,
} from "@invisible-string/shared";

import { CopilotDock } from "../components/copilot/CopilotDock";
import { agentCopilotAdapter } from "../lib/copilot/agent-mutations";
import type { AgentEditorAction } from "../lib/agents/model";
import type { ContextResources } from "../lib/builder/resources";
import type { WebSocketLike } from "../lib/copilot/socket";
import { pasteInto, pressEnter } from "../test/editor";

ensureDomForThisFile();

// ── Fake WS fixture (same shape as copilot-dock.test.tsx) ───────────────────

type Listener = (event: unknown) => void;

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
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

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(frame: CopilotServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  frames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }
}

const createWebSocket = (url: string) => new FakeWebSocket(url);
const q = () => within(document.body);

// ── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";

const definition: AgentDefinition = {
  persona: "You are a careful assistant.",
  model: { preset: "balanced" },
  context: { mcpConnectionIds: [], skillIds: [] },
};

const resources = {
  connections: [],
  skills: [],
  connectionById: new Map(),
  skillById: new Map(),
  isPending: false,
  isError: false,
} as unknown as ContextResources;

function proposal(overrides: Partial<CopilotProposal> = {}): CopilotProposal {
  return {
    id: "call-1",
    tool: "setPersona",
    params: { markdown: "You are relentless." },
    rationale: "The persona is too vague.",
    ...overrides,
  } as CopilotProposal;
}

interface DockOptions {
  identity?: { name: string; description: string | null };
  /** Resolves the rename PATCH — a deferred one parks the card in "Applying…". */
  renameOutcome?: (name: string) => boolean | Promise<boolean>;
}

function renderDock(options: DockOptions = {}) {
  const dispatched: AgentEditorAction[] = [];
  const names: string[] = [];
  const identity = options.identity ?? {
    name: "Untitled agent",
    description: null,
  };
  const adapter = agentCopilotAdapter({
    agentId: AGENT_ID,
    getDraft: () => definition,
    getIdentity: () => identity,
    dispatch: (action) => dispatched.push(action),
    setName: (name) => {
      names.push(name);
      return options.renameOutcome ? options.renameOutcome(name) : true;
    },
    resources,
    onApplied: mock(() => {}),
  });
  const view = render(
    <CopilotDock
      workspaceId="ws-1"
      adapter={adapter}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
    />,
  );
  return { view, dispatched, names };
}

function socket(): FakeWebSocket {
  const found = FakeWebSocket.instances.at(-1);
  if (!found) throw new Error("no socket created");
  return found;
}

function openSocket(): FakeWebSocket {
  const ws = socket();
  act(() => ws.open());
  return ws;
}

function push(ws: FakeWebSocket, ...frames: CopilotServerFrame[]) {
  act(() => {
    for (const frame of frames) ws.message(frame);
  });
}

/** Flush the microtask queue inside act() — used after an async apply. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The composer is lazily imported — poll for the chunk instead of sleeping. */
async function waitForComposer(): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = q().queryByLabelText("Ask copilot");
    if (found !== null) return found;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return q().getByLabelText("Ask copilot");
}

const OPEN_KEY = "is.copilot.open:ws-1";

beforeEach(() => {
  FakeWebSocket.instances = [];
  window.localStorage.setItem(OPEN_KEY, "1");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ── D7.1 — steps and thinking ───────────────────────────────────────────────

test("thinking and self-corrected tool calls render in a rail-in-box; carded steps do not", () => {
  renderDock();
  const ws = openSocket();
  push(
    ws,
    { type: "thought", key: "turn:0:step:0", text: "The persona is thin.", streaming: true },
    { type: "step", key: "call-9", toolName: "addContext", state: "error", resultPreview: "unknown connection id" },
    { type: "step", key: "call-1", toolName: "setPersona", state: "pending", resultPreview: null },
    { type: "proposal", proposal: proposal() },
  );

  const box = q().getAllByTestId("copilot-work")[0]!;
  expect(box.textContent).toContain("The persona is thin.");
  // The rejected call is visible (that is the point of showing steps at all)…
  expect(box.textContent).toContain("Add context");
  expect(box.textContent).toContain("unknown connection id");
  // …while the call that became a card is not duplicated into the rail.
  expect(box.textContent).not.toContain("Set persona");
  expect(q().getByTestId("suggestion-card").textContent).toContain(
    "Rewrite persona",
  );
});

test("a live box is expanded and folds once the turn settles", () => {
  renderDock();
  const ws = openSocket();
  push(ws, { type: "thought", key: "turn:0:step:0", text: "Thinking hard.", streaming: true });
  const toggle = () =>
    within(q().getAllByTestId("copilot-work")[0]!).getByRole("button");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  push(ws, { type: "done", reason: "completed" });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

// ── D7.2 — allow-edits ──────────────────────────────────────────────────────

function switchControl(): HTMLElement {
  return q().getByRole("switch", { name: "Auto-apply edits" });
}

test("allow-edits defaults OFF, is unmistakable when on, and rides the frame", async () => {
  renderDock();
  const ws = openSocket();
  expect(switchControl().getAttribute("aria-checked")).toBe("false");
  expect(q().queryByTestId("copilot-auto-apply-banner")).toBeNull();
  expect(q().queryByRole("button", { name: "Send to copilot" })).not.toBeNull();

  fireEvent.click(switchControl());
  expect(switchControl().getAttribute("aria-checked")).toBe("true");
  // Three independent tells: the switch, a plain-language strip, and the
  // send button's accessible name.
  expect(q().getByTestId("copilot-auto-apply-banner").textContent).toContain(
    "without asking",
  );
  expect(
    q().queryByRole("button", { name: "Send to copilot (auto-apply on)" }),
  ).not.toBeNull();

  const box = await waitForComposer();
  pasteInto(box, "Tighten the persona");
  pressEnter(box);
  const frame = ws.frames().at(-1)!;
  expect(frame.type).toBe("user_message");
  expect(frame.allowEdits).toBe(true);

  // Flipping it back stops sending the flag at all (omitted ⇒ accept gate).
  fireEvent.click(switchControl());
  push(ws, { type: "done", reason: "completed" });
  pasteInto(box, "And again");
  pressEnter(box);
  expect(ws.frames().at(-1)!.allowEdits).toBeUndefined();
}, 30_000);

test("an auto-applied proposal applies through the controller and still leaves a card", () => {
  const { dispatched } = renderDock();
  const ws = openSocket();
  push(ws, { type: "proposal", proposal: proposal(), autoApplied: true });

  // Applied by the CLIENT (still the single writer) without an accept gate.
  expect(dispatched).toEqual([
    { type: "setPersona", markdown: "You are relentless." },
  ]);
  // The audit trail: a receipt that says it was automatic, never a bare
  // "Applied" (which would read as "you applied this").
  const receipt = q().getByTestId("suggestion-receipt");
  expect(receipt.textContent).toContain("Applied automatically");
  expect(q().queryByTestId("suggestion-card")).toBeNull();
  // Nothing to unblock server-side — the loop already moved on.
  expect(ws.frames().some((frame) => frame.type === "mutation_result")).toBe(
    false,
  );
});

// ── D7.3 / D7.4 — name + description ────────────────────────────────────────

test("setName previews the rename and commits through the header's seam, not the reducer", async () => {
  const { dispatched, names } = renderDock();
  const ws = openSocket();
  push(ws, {
    type: "proposal",
    proposal: proposal({
      id: "call-name",
      tool: "setName",
      params: { name: "Inbox triage" },
      rationale: "It triages the shared inbox.",
    } as Partial<CopilotProposal>),
  });

  const card = q().getByTestId("suggestion-card");
  expect(card.textContent).toContain("Rename agent: Inbox triage");
  const preview = within(card).getByTestId("before-after");
  expect(preview.textContent).toContain("Untitled agent");
  expect(preview.textContent).toContain("Inbox triage");

  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  // The name is NOT part of the editor reducer (lib/agents/model.ts) — it
  // must take the same commit path the header uses.
  expect(names).toEqual(["Inbox triage"]);
  expect(dispatched).toEqual([]);

  // …and only once the PATCH has actually resolved does the receipt appear.
  await settle();
  expect(q().getByTestId("suggestion-receipt").textContent).toContain("Applied");
});

test("setDescription previews against the empty state and dispatches to the reducer", () => {
  const { dispatched } = renderDock();
  const ws = openSocket();
  push(ws, {
    type: "proposal",
    proposal: proposal({
      id: "call-desc",
      tool: "setDescription",
      params: { description: "Triages the shared inbox every morning." },
      rationale: "The grid shows nothing today.",
    } as Partial<CopilotProposal>),
  });

  const card = q().getByTestId("suggestion-card");
  expect(card.textContent).toContain("Add description");
  expect(within(card).getByTestId("before-after").textContent).toContain(
    "No description",
  );

  fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
  expect(dispatched).toEqual([
    {
      type: "setDescription",
      description: "Triages the shared inbox every morning.",
    },
  ]);
});

// ── D7.3 — identity reaches the SERVER, not just the card ───────────────────

test("user_message carries the agent's row identity alongside the draft", async () => {
  // The regression: `AgentDefinition` has no name/description at all, so a
  // server reading them off `draft` saw nothing, forever. The card's before
  // side looked right the whole time because it reads the same identity
  // locally — which is exactly why this shipped green.
  renderDock({ identity: { name: "Inbox triage", description: "Triages." } });
  const ws = openSocket();
  const box = await waitForComposer();
  pasteInto(box, "What is this agent called?");
  pressEnter(box);

  const frame = ws.frames().at(-1)!;
  expect(frame.type).toBe("user_message");
  expect(frame.identity).toEqual({
    name: "Inbox triage",
    description: "Triages.",
  });
  // …and it is NOT smuggled into the loose draft record.
  expect(frame.draft).toEqual(definition as unknown as Record<string, unknown>);
}, 30_000);

test("an over-long description is truncated, never allowed to sink the frame", async () => {
  // The row's description may be up to the DTO's 2000 chars; the copilot's
  // wire bound is the same, and a mid-edit draft can exceed it. Rejecting the
  // whole frame would cost the user the turn for a field they did not ask to
  // send.
  renderDock({
    identity: { name: "n".repeat(400), description: "d".repeat(4_000) },
  });
  const ws = openSocket();
  const box = await waitForComposer();
  pasteInto(box, "Tighten this");
  pressEnter(box);

  const identity = ws.frames().at(-1)!.identity as {
    name: string;
    description: string;
  };
  expect(identity.name.length).toBe(120);
  expect(identity.description.length).toBe(2_000);
}, 30_000);

// ── D7.3 — a rename that does not land must not print a receipt ─────────────

function pushRename(ws: FakeWebSocket) {
  push(ws, {
    type: "proposal",
    proposal: proposal({
      id: "call-name",
      tool: "setName",
      params: { name: "Inbox triage" },
      rationale: "It triages the shared inbox.",
    } as Partial<CopilotProposal>),
  });
}

test("a FAILED rename settles as 'Couldn’t apply' and reports rejected, not accepted", async () => {
  const { names } = renderDock({ renameOutcome: () => Promise.resolve(false) });
  const ws = openSocket();
  pushRename(ws);

  fireEvent.click(
    within(q().getByTestId("suggestion-card")).getByRole("button", {
      name: "Apply",
    }),
  );
  expect(names).toEqual(["Inbox triage"]);
  await settle();

  const receipt = q().getByTestId("suggestion-receipt");
  expect(receipt.textContent).toContain("Couldn’t apply");
  expect(receipt.textContent).not.toContain("Applied");
  // The server's tool loop is parked on this frame: it must be answered, and
  // answered truthfully — "accepted" would leave the model editing an agent
  // whose name never changed.
  const result = ws
    .frames()
    .find((frame) => frame.type === "mutation_result") as
    | { outcome: string; reason?: string }
    | undefined;
  expect(result?.outcome).toBe("rejected");
  expect(result?.reason).toContain("could not apply");
});

test("a slow rename parks the card in Applying… — no receipt, no second accept", async () => {
  let resolve: ((ok: boolean) => void) | null = null;
  const { names } = renderDock({
    renameOutcome: () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  });
  const ws = openSocket();
  pushRename(ws);

  // queryBy, not getBy: without the fix the card is already a receipt here,
  // and this assertion must report "no card" rather than dump the DOM.
  const applyButton = (): HTMLElement | null => {
    const card = q().queryByTestId("suggestion-card");
    return card
      ? within(card).queryByRole("button", { name: /Apply/ })
      : null;
  };
  fireEvent.click(applyButton()!);
  await settle();

  // Still a card, not a receipt — and the server has not been told anything.
  // Compared as a BOOLEAN: a failing `toBeNull()` on a DOM node serializes the
  // whole React fiber and turns a 1s failure into a 40s one.
  expect(q().queryByTestId("suggestion-receipt") === null).toBe(true);
  expect(applyButton()?.textContent).toContain("Applying…");
  expect(applyButton()?.hasAttribute("disabled")).toBe(true);
  expect(ws.frames().some((frame) => frame.type === "mutation_result")).toBe(
    false,
  );
  // A second click cannot double-PATCH.
  fireEvent.click(applyButton()!);
  expect(names).toEqual(["Inbox triage"]);

  await act(async () => {
    resolve!(true);
    await Promise.resolve();
  });
  await settle();
  expect(q().getByTestId("suggestion-receipt").textContent).toContain("Applied");
});
