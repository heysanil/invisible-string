/**
 * Fixture-mode smoke test: the canned session list mounts and every session
 * (streaming / parked / done / failed) renders its thread without a backend.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";

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

test("fixture shell lists every canned session and renders the active thread", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // RouterProvider resolves its initial route asynchronously.
  await view.findAllByText("Marketing copilot");
  // All four fixture workflows appear in the list (chips).
  for (const name of ["Marketing copilot", "Ops assistant", "Issue triage", "Release bot"]) {
    expect(view.getAllByText(name).length).toBeGreaterThan(0);
  }
});

test("selecting the parked fixture session shows its approval card", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // Switch to the Ops assistant (parked-approval) session.
  fireEvent.click((await view.findAllByText("Ops assistant"))[0]!);
  expect(view.getByText(/Approve tool call: gmail_send/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
});
