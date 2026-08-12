/**
 * Copilot thread reducer (2026-08-11 spec D7.1/D7.2) — the pure frame →
 * thread reduction behind the dock: thoughts and steps collecting into
 * rail-in-box work segments, speech and cards sealing them, upserts landing in
 * place wherever the row already lives, and the turn-end settles (abort,
 * error, dropped socket) that must never leave a step spinning forever.
 */
import { describe, expect, test } from "bun:test";
import type { CopilotProposal, CopilotServerFrame } from "@invisible-string/shared";

import {
  appendNotice,
  appendUserMessage,
  decideSuggestion,
  proposalIdsOf,
  reduceCopilotFrame,
  settleCopilotTurn,
  visibleTimelineItems,
  type CopilotStepItem,
  type CopilotThreadItem,
} from "../lib/copilot/thread";

function run(frames: CopilotServerFrame[], from: CopilotThreadItem[] = []) {
  return frames.reduce<CopilotThreadItem[]>(
    (items, frame) => reduceCopilotFrame(items, frame),
    from,
  );
}

const kinds = (items: readonly CopilotThreadItem[]) => items.map((i) => i.kind);

function work(items: readonly CopilotThreadItem[], index = 0) {
  const boxes = items.filter(
    (item): item is Extract<CopilotThreadItem, { kind: "work" }> =>
      item.kind === "work",
  );
  const box = boxes[index];
  if (!box) throw new Error(`no work box at ${index} (found ${boxes.length})`);
  return box;
}

const personaProposal: CopilotProposal = {
  id: "call-1",
  tool: "setPersona",
  params: { markdown: "You are careful." },
  rationale: "It needs a persona.",
};

describe("thoughts and steps", () => {
  test("a thought opens a work box and later frames REPLACE it (text is cumulative)", () => {
    const items = run([
      { type: "thought", key: "step:0", text: "Look", streaming: true },
      { type: "thought", key: "step:0", text: "Looking at the draft", streaming: true },
      { type: "thought", key: "step:0", text: "Looking at the draft", streaming: false },
    ]);
    expect(kinds(items)).toEqual(["work"]);
    expect(work(items).items).toEqual([
      {
        kind: "thought",
        key: "step:0",
        text: "Looking at the draft",
        streaming: false,
      },
    ]);
  });

  test("steps humanize their tool name and upsert by key in place", () => {
    const items = run([
      { type: "step", key: "call-1", toolName: "setPersona", state: "pending", resultPreview: null },
      { type: "step", key: "call-1", toolName: "setPersona", state: "ok", resultPreview: "Applied to the draft" },
    ]);
    expect(work(items).items).toEqual([
      {
        kind: "step",
        key: "call-1",
        toolName: "setPersona",
        label: "Set persona",
        state: "ok",
        resultPreview: "Applied to the draft",
      },
    ]);
  });

  test("speech SEALS the box; later work opens a new one below it", () => {
    const items = run([
      { type: "thought", key: "step:0", text: "Thinking", streaming: true },
      { type: "delta", text: "Here is what I found." },
      { type: "step", key: "call-1", toolName: "setModel", state: "pending", resultPreview: null },
    ]);
    expect(kinds(items)).toEqual(["work", "message", "work"]);
    expect(work(items, 0).sealed).toBe(true);
    expect(work(items, 1).sealed).toBe(false);
  });

  test("a sealing thought frame lands in the box it belongs to, not a new one", () => {
    // The server seals a step's reasoning AFTER that step's text deltas, so
    // this frame legitimately arrives once the box is already closed.
    const items = run([
      { type: "thought", key: "step:0", text: "Half a thought", streaming: true },
      { type: "delta", text: "Speaking now." },
      { type: "thought", key: "step:0", text: "A whole thought", streaming: false },
    ]);
    expect(kinds(items)).toEqual(["work", "message"]);
    expect(work(items).items[0]).toMatchObject({
      text: "A whole thought",
      streaming: false,
    });
  });
});

describe("proposals", () => {
  test("a card seals the open box and opens PENDING under the accept gate", () => {
    const items = run([
      { type: "thought", key: "step:0", text: "Thinking", streaming: true },
      { type: "proposal", proposal: personaProposal },
    ]);
    expect(kinds(items)).toEqual(["work", "suggestion"]);
    expect(work(items).sealed).toBe(true);
    expect(items[1]).toMatchObject({ status: "pending", autoApplied: false });
  });

  test("autoApplied opens the card already APPLIED — the audit trail survives", () => {
    const items = run([{ type: "proposal", proposal: personaProposal, autoApplied: true }]);
    expect(items[0]).toMatchObject({
      kind: "suggestion",
      status: "applied",
      autoApplied: true,
    });
  });

  test("a mutation step's rail row is suppressed — its card is the richer view", () => {
    const items = run([
      { type: "step", key: "call-1", toolName: "setPersona", state: "pending", resultPreview: null },
      { type: "proposal", proposal: personaProposal },
      { type: "step", key: "call-1", toolName: "setPersona", state: "ok", resultPreview: "Applied" },
      // An INVALID call never becomes a proposal — it must stay visible.
      { type: "step", key: "call-2", toolName: "addContext", state: "error", resultPreview: "unknown connection id" },
    ]);
    const hidden = proposalIdsOf(items);
    expect(hidden.has("call-1")).toBe(true);
    const visible = items
      .filter((item) => item.kind === "work")
      .flatMap((item) =>
        visibleTimelineItems(
          (item as Extract<CopilotThreadItem, { kind: "work" }>).items,
          hidden,
        ),
      );
    expect(visible.map((row) => (row as CopilotStepItem).key)).toEqual(["call-2"]);
  });

  test("decideSuggestion settles exactly one card", () => {
    const items = decideSuggestion(
      run([{ type: "proposal", proposal: personaProposal }]),
      "call-1",
      "dismissed",
    );
    expect(items[0]).toMatchObject({ status: "dismissed" });
  });
});

describe("turn ends", () => {
  const inFlight: CopilotServerFrame[] = [
    { type: "thought", key: "step:0", text: "Thinking", streaming: true },
    { type: "step", key: "call-9", toolName: "setModel", state: "pending", resultPreview: null },
  ];

  test("a COMPLETED turn seals without inventing a cancellation", () => {
    const items = run([...inFlight, { type: "done", reason: "completed" }]);
    const box = work(items);
    expect(box.sealed).toBe(true);
    expect(box.items[0]).toMatchObject({ streaming: false });
    // Still pending: the server resolves every step it opens, so a pending one
    // here is a server bug worth SEEING, not one to paper over.
    expect(box.items[1]).toMatchObject({ state: "pending" });
  });

  test("an ABORTED turn retires steps that will never resolve", () => {
    const items = run([...inFlight, { type: "done", reason: "aborted" }]);
    expect(work(items).items[1]).toMatchObject({ state: "canceled" });
  });

  test("turn_in_progress does not stop the turn that is still running", () => {
    const items = run([
      ...inFlight,
      { type: "error", code: "turn_in_progress", message: "a turn is already running" },
    ]);
    const box = work(items);
    expect(box.sealed).toBe(false);
    expect(box.items[0]).toMatchObject({ streaming: true });
    expect(box.items[1]).toMatchObject({ state: "pending" });
    expect(items.at(-1)).toMatchObject({ kind: "error" });
    expect((items.at(-1) as { text: string }).text).toContain("still working");
  });

  test("any other error settles the turn and humanizes the code", () => {
    const items = run([
      ...inFlight,
      { type: "error", code: "llm_error", message: "the copilot model call failed — try again" },
    ]);
    const box = work(items);
    expect(box.sealed).toBe(true);
    expect(box.items[1]).toMatchObject({ state: "canceled" });
    expect((items.at(-1) as { text: string }).text).toBe(
      "the copilot model call failed — try again",
    );
  });

  test("a dropped socket settles the same way (settleCopilotTurn + notice)", () => {
    const items = appendNotice(
      settleCopilotTurn(run(inFlight), { cancelPendingSteps: true }),
      "Connection lost — this response was cut short. Ask again to continue.",
    );
    expect(work(items).items[1]).toMatchObject({ state: "canceled" });
    expect(items.at(-1)).toMatchObject({ kind: "notice" });
  });
});

test("a user message seals the previous turn's box", () => {
  const items = appendUserMessage(
    run([{ type: "thought", key: "step:0", text: "Thinking", streaming: false }]),
    "and now this",
  );
  expect(kinds(items)).toEqual(["work", "message"]);
  expect(work(items).sealed).toBe(true);
});
