/**
 * Fixture-mode smoke test: the canned session list mounts (agent-titled rows
 * + trigger provenance chips), every session — streaming / parked / done /
 * failed / STOPPED / CLEARED / session-limit — renders its thread without a
 * backend, and the New chat button opens the agent picker into the
 * first-message composer.
 *
 * The backend-free preview is only useful if it stays honest, so the eve 0.31
 * states are asserted here too: a stopped run must NOT read as an error, and
 * a session-limit prompt must not masquerade as a tool approval.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, within } from "@testing-library/react";

import { renderWithRouter } from "../test/router";

ensureDomForThisFile();

// The thread is virtualized — give happy-dom a measurable viewport.
beforeEach(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
  Element.prototype.getBoundingClientRect = rect;
  HTMLElement.prototype.getBoundingClientRect = rect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
});
afterEach(cleanup);

const { FixtureChatShell } = await import("../components/chat/FixtureChatShell");

test("fixture shell lists every canned session by agent name with provenance chips", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // RouterProvider resolves its initial route asynchronously.
  await view.findAllByText("Executive assistant");
  // All four fixture sessions appear, titled by their agent.
  for (const name of ["Executive assistant", "Support triager", "Data analyst"]) {
    expect(view.getAllByText(name).length).toBeGreaterThan(0);
  }
  // The webhook-origin session shows its origin chip + workflow provenance.
  expect(view.getByText("webhook")).toBeTruthy();
  expect(view.getByText("Nightly metrics digest")).toBeTruthy();
});

test("selecting the parked fixture session shows its approval card", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // Both Executive assistant sessions render; the parked one is the second
  // row (list order: live, parked). Index 0/1 are list rows — the active
  // thread's header chip comes after them in DOM order.
  fireEvent.click((await view.findAllByText("Executive assistant"))[1]!);
  expect(view.getByText(/Approve tool call: gmail_send/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
});

/**
 * Pick a session row by agent + its liveness dot. The list is bucketed by
 * recency, so row ORDER is not the fixture array order — addressing by the
 * state under test keeps these specs from breaking when a fixture's age
 * changes.
 */
function openSession(
  view: ReturnType<typeof renderWithRouter>,
  agentName: string,
  liveness: string,
): void {
  const panel = view.getByLabelText("Chat sessions");
  const rows = within(panel as HTMLElement).getAllByRole("button", {
    name: new RegExp(agentName),
  });
  const row = rows.find(
    (candidate) => within(candidate).queryByTitle(liveness) !== null,
  );
  if (row === undefined) {
    throw new Error(`no "${agentName}" session row with liveness "${liveness}"`);
  }
  fireEvent.click(row);
}

test("the stopped fixture session renders a cancellation, not a failure", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  await view.findAllByText("Support triager");
  openSession(view, "Support triager", "Stopped");

  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  // The load-bearing assertion: cancellation carries no error banner.
  expect(view.queryByRole("alert")).toBeNull();
  // Whatever streamed before the stop is still readable.
  expect(view.getByText(/started grouping them by area/)).toBeTruthy();
  // The header reads the neutral "Stopped" liveness, never "Failed".
  expect(view.getAllByTitle("Stopped").length).toBeGreaterThan(0);
});

test("the cleared fixture session shows the neutral context marker", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  await view.findAllByText("Data analyst");
  // The other Data analyst session is the failed webhook one.
  openSession(view, "Data analyst", "Idle");
  expect(view.getByText("Context cleared")).toBeTruthy();
  // Clearing only drops the AGENT's memory — the transcript stays.
  expect(view.getByText(/self-serve upgrades/)).toBeTruthy();
});

test("the session-limit fixture renders its own card, not a tool approval", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  await view.findAllByText("Executive assistant");
  // Both parked Executive assistant sessions read "Waiting for input"; the
  // session-limit one is the later row (list order within a recency bucket).
  const panel = view.getByLabelText("Chat sessions");
  const waiting = within(panel as HTMLElement)
    .getAllByRole("button", { name: /Executive assistant/ })
    .filter((row) => within(row).queryByTitle("Waiting for input") !== null);
  fireEvent.click(waiting[waiting.length - 1]!);
  expect(view.getByRole("group", { name: "Session limit reached" })).toBeTruthy();
  expect(view.queryByText("session_limit_continuation")).toBeNull();
  expect(view.getByText("Grant a fresh token budget")).toBeTruthy();
});

test("fixture mode can actually stop a running run (backend-free preview)", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // The first session is the live streaming run.
  const stop = await view.findByRole("button", { name: "Stop" });
  fireEvent.click(stop);
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("fixture mode can apply a context control from the session menu", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  await view.findAllByText("Support triager");
  // Move off the live run — controls are blocked while a run is in flight.
  openSession(view, "Support triager", "Idle");
  fireEvent.click(view.getByRole("button", { name: "Session actions" }));
  fireEvent.click(view.getByText("Compact context"));
  expect(view.getByText("Context compacted")).toBeTruthy();
});

test("New chat opens the agent picker and picking shows the composer", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  fireEvent.click(await view.findByRole("button", { name: /New chat/ }));

  const dialog = view.getByRole("dialog", { name: "Start a new chat" });
  const picker = within(dialog as HTMLElement);
  // Published fixture agents only — the draft-only Release bot is absent.
  expect(picker.getByText("Executive assistant")).toBeTruthy();
  expect(picker.getByText("Support triager")).toBeTruthy();
  expect(picker.getByText("Data analyst")).toBeTruthy();
  expect(picker.queryByText("Release bot")).toBeNull();
  // The Support triager's model override rides its row chip.
  expect(picker.getByText("deepseek/deepseek-v4-pro")).toBeTruthy();

  fireEvent.click(picker.getByText("Support triager"));
  expect(view.getByText("New chat with Support triager")).toBeTruthy();
  // Tiptap hangs the placeholder off the empty paragraph, not a `placeholder`
  // attribute, so `getByPlaceholderText` cannot see it.
  expect(
    view
      .getByLabelText("Message")
      .querySelector("[data-placeholder]")
      ?.getAttribute("data-placeholder"),
  ).toBe("Message Support triager…");
});
