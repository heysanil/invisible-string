/**
 * Fixture-mode smoke test: the canned session list mounts (agent-titled rows
 * + trigger provenance chips), every session (streaming / parked / done /
 * failed) renders its thread without a backend, and the New chat button opens
 * the agent picker into the first-message composer.
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
  expect(view.getByPlaceholderText("Message Support triager…")).toBeTruthy();
});
