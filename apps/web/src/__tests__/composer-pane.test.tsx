/**
 * ComposerPane — the workflow editor's primary copilot pane (pipelines
 * redesign): always-on socket (no collapse pill, no persistence), the
 * allow-edits switch in the header with a surface-aware INITIAL value
 * (`defaultAllowEdits`: ON for never-published drafts, OFF once published),
 * prefill seeding, and the same shared thread underneath.
 *
 * The thread/composer behavior itself is covered on the dock
 * (copilot-dock.test.tsx / copilot-depth.test.tsx) — this file covers only
 * what the PANE shell owns.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { WorkflowConfig } from "@invisible-string/shared";

import { ComposerPane } from "../components/copilot/ComposerPane";
import { workflowCopilotAdapter } from "../lib/copilot/mutations";
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

  message(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  frames(): { type: string; allowEdits?: boolean }[] {
    return this.sent.map(
      (raw) => JSON.parse(raw) as { type: string; allowEdits?: boolean },
    );
  }
}

const createWebSocket = (url: string) => new FakeWebSocket(url);

const q = () => within(document.body);

const definition: WorkflowConfig = {
  version: 2,
  trigger: { type: "manual" },
  steps: [],
  overlap: "skip",
};

function renderPane(
  options: {
    defaultAllowEdits?: boolean;
    prefill?: { id: number; text: string } | null;
  } = {},
) {
  const dispatch = mock(() => {});
  const adapter = workflowCopilotAdapter({
    workflowId: "wf-1",
    getDraft: () => definition,
    dispatch,
    agents: [],
  });
  const view = render(
    <ComposerPane
      workspaceId="ws-1"
      adapter={adapter}
      {...(options.defaultAllowEdits !== undefined
        ? { defaultAllowEdits: options.defaultAllowEdits }
        : {})}
      {...(options.prefill !== undefined ? { prefill: options.prefill } : {})}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
    />,
  );
  return { view, dispatch, adapter };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

/** The composer chunk is lazy — poll for the mount instead of sleeping. */
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

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ── Tests ───────────────────────────────────────────────────────────────────

test("the pane cannot collapse: no pill, no collapse control, socket up immediately", () => {
  renderPane();
  // The socket exists without any open gesture — the pane is always on.
  expect(FakeWebSocket.instances.length).toBe(1);
  expect(lastSocket().url).toContain("/workspaces/ws-1/copilot");
  expect(q().queryByRole("button", { name: "Open Copilot" })).toBeNull();
  expect(q().queryByRole("button", { name: "Collapse Copilot" })).toBeNull();
  // The thread and the header switch are both up.
  expect(q().getByLabelText("Copilot conversation")).toBeTruthy();
  expect(q().getByRole("switch", { name: "Auto-apply edits" })).toBeTruthy();
});

test("defaultAllowEdits OFF: switch unchecked, no banner, flag omitted from the frame", async () => {
  renderPane();
  const socket = lastSocket();
  act(() => socket.open());
  const control = q().getByRole("switch", { name: "Auto-apply edits" });
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(q().queryByTestId("copilot-auto-apply-banner")).toBeNull();

  const box = await waitForComposer();
  pasteInto(box, "Hello");
  pressEnter(box);
  const frame = socket.frames().at(-1)!;
  expect(frame.type).toBe("user_message");
  expect(frame.allowEdits).toBeUndefined();
}, 30_000);

test("defaultAllowEdits ON (never-published draft): checked, banner up, flag rides the frame", async () => {
  renderPane({ defaultAllowEdits: true });
  const socket = lastSocket();
  act(() => socket.open());
  const control = q().getByRole("switch", { name: "Auto-apply edits" });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(q().getByTestId("copilot-auto-apply-banner").textContent).toContain(
    "without asking",
  );
  expect(
    q().queryByRole("button", { name: "Send to copilot (auto-apply on)" }),
  ).not.toBeNull();

  const box = await waitForComposer();
  pasteInto(box, "Build it");
  pressEnter(box);
  expect(socket.frames().at(-1)!.allowEdits).toBe(true);

  // Still a session-scoped toggle: flipping it off works like the dock's.
  fireEvent.click(control);
  expect(control.getAttribute("aria-checked")).toBe("false");
}, 30_000);

test("prefill seeds the composer", async () => {
  const { view, adapter } = renderPane();
  await waitForComposer();
  view.rerender(
    <ComposerPane
      workspaceId="ws-1"
      adapter={adapter}
      prefill={{ id: 1, text: "Fix the trigger config" }}
      createWebSocket={createWebSocket}
      backoffBaseMs={1}
    />,
  );
  // The prefill flows through the value prop into the (already mounted)
  // editor document.
  for (let attempt = 0; attempt < 300; attempt++) {
    if (q().getByLabelText("Ask copilot").textContent === "Fix the trigger config") {
      break;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(q().getByLabelText("Ask copilot").textContent).toBe(
    "Fix the trigger config",
  );
}, 30_000);

test("streams into the shared thread (delta renders in the log)", () => {
  renderPane();
  const socket = lastSocket();
  act(() => socket.open());
  // Chip sends ride the same thread; simulate a turn instead (no composer
  // needed): a delta lands in the role="log" thread.
  act(() => {
    socket.message({ type: "delta", text: "Planning the pipeline" });
  });
  const thread = q().getByLabelText("Copilot conversation");
  expect(thread.getAttribute("role")).toBe("log");
  expect(thread.textContent).toContain("Planning the pipeline");
});
