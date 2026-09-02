/**
 * Pure tests for the strip's structural-edit helpers (components/pipeline/
 * tree.ts): position derivation, the head-of-lane fallback (the one spot the
 * shared StepPosition grammar cannot express), duplicate cloning (fresh ids,
 * tree-unique slugs), and sibling reorders.
 */
import { describe, expect, test } from "bun:test";
import {
  STEP_ID_PATTERN,
  walkSteps,
  type BranchStep,
  type ForEachStep,
  type PipelineStep,
  type ToolStep,
} from "@invisible-string/shared";

import { insertStepAt } from "../lib/builder/model";

import {
  cloneStepWithNewIds,
  duplicateOf,
  insertPositionFor,
  isWithinSubtree,
  laneHeadFallback,
  positionAfter,
  siblingMove,
  type StepListParent,
} from "../components/pipeline/tree";

let n = 0;
function id(): string {
  n += 1;
  return `st_${String(n).padStart(16, "0")}`;
}

function tool(slug: string): ToolStep {
  return {
    id: id(),
    slug,
    kind: "tool",
    connectionId: "",
    tool: "",
    args: {},
    sideEffect: "at_least_once",
  };
}

function loop(slug: string, steps: PipelineStep[]): ForEachStep {
  return {
    id: id(),
    slug,
    kind: "for_each",
    items: { $ref: "steps.search.result" },
    steps,
    maxItems: 100,
    onItemError: "halt",
  };
}

function branch(slug: string, lanes: PipelineStep[][], elseSteps?: PipelineStep[]): BranchStep {
  return {
    id: id(),
    slug,
    kind: "branch",
    branches: lanes.map((steps) => ({ when: { truthy: { $ref: "now" } }, steps })),
    ...(elseSteps !== undefined ? { else: elseSteps } : {}),
  };
}

// ── insertPositionFor ───────────────────────────────────────────────────────

describe("insertPositionFor", () => {
  test("top level: head and after-sibling", () => {
    const a = tool("a");
    const b = tool("b");
    expect(insertPositionFor([a, b], 0, null)).toEqual({ after: null });
    expect(insertPositionFor([a, b], 1, null)).toEqual({ after: a.id });
    expect(insertPositionFor([a, b], 2, null)).toEqual({ after: b.id });
  });

  test("for_each body head is expressible", () => {
    const child = tool("child");
    const container = loop("loop", [child]);
    const parent: StepListParent = { step: container, slot: "body", laneIndex: 0 };
    expect(insertPositionFor(container.steps, 0, parent)).toEqual({
      after: null,
      parent: { stepId: container.id, slot: "body" },
    });
  });

  test("head of a then-lane beyond the first is NOT expressible", () => {
    const laneStep = tool("x");
    const container = branch("br", [[], [laneStep]]);
    const lane1: StepListParent = { step: container, slot: "then", laneIndex: 1 };
    expect(insertPositionFor([laneStep], 0, lane1)).toBeNull();
    // …but after the lane's own step it is.
    expect(insertPositionFor([laneStep], 1, lane1)).toEqual({
      after: laneStep.id,
      parent: { stepId: container.id, slot: "then" },
    });
    // and lane 0's head is (after:null resolves to the first lane).
    const lane0: StepListParent = { step: container, slot: "then", laneIndex: 0 };
    expect(insertPositionFor([], 0, lane0)).toEqual({
      after: null,
      parent: { stepId: container.id, slot: "then" },
    });
  });
});

// ── laneHeadFallback ────────────────────────────────────────────────────────

test("laneHeadFallback splices the new step into the right lane of a replacement container", () => {
  const laneStep = tool("x");
  const container = branch("br", [[], [laneStep]]);
  const added = tool("new");
  const fallback = laneHeadFallback(
    { step: container, slot: "then", laneIndex: 1 },
    [laneStep],
    0,
    added,
  );
  expect(fallback).not.toBeNull();
  expect(fallback!.containerId).toBe(container.id);
  const replacement = fallback!.replacement as BranchStep;
  expect(replacement.branches[1]!.steps.map((s) => s.slug)).toEqual(["new", "x"]);
  // Lane 0 untouched.
  expect(replacement.branches[0]!.steps).toEqual([]);
});

// ── positionAfter / duplicateOf ─────────────────────────────────────────────

describe("duplicate", () => {
  test("positionAfter carries the innermost parent slot", () => {
    const child = tool("child");
    const container = loop("loop", [child]);
    expect(positionAfter([container], child.id)).toEqual({
      after: child.id,
      parent: { stepId: container.id, slot: "body" },
    });
    expect(positionAfter([container], container.id)).toEqual({
      after: container.id,
    });
    expect(positionAfter([container], "st_missing")).toBeNull();
  });

  test("cloneStepWithNewIds re-mints every id and uniquifies every slug", () => {
    const child = tool("child");
    const container = loop("loop", [child]);
    const taken = new Set(["loop", "child"]);
    const clone = cloneStepWithNewIds(container, taken) as ForEachStep;
    expect(clone.id).not.toBe(container.id);
    expect(clone.id).toMatch(STEP_ID_PATTERN);
    expect(clone.slug).toBe("loop-2");
    expect(clone.steps[0]!.id).not.toBe(child.id);
    expect(clone.steps[0]!.slug).toBe("child-2");
    // The original tree is untouched.
    expect(container.steps[0]!.slug).toBe("child");
  });

  test("duplicateOf inserts right after the original and the reducer accepts it", () => {
    const a = tool("a");
    const b = tool("b");
    const dup = duplicateOf([a, b], a.id);
    expect(dup).not.toBeNull();
    expect(dup!.position).toEqual({ after: a.id });
    expect(dup!.step.slug).toBe("a-2");
    const next = insertStepAt([a, b], dup!.step, dup!.position);
    expect(next).not.toBeNull();
    expect(walkSteps(next!).map((entry) => entry.step.slug)).toEqual([
      "a",
      "a-2",
      "b",
    ]);
  });
});

// ── siblingMove ─────────────────────────────────────────────────────────────

describe("siblingMove", () => {
  test("down/up at the top level yields moveStep positions", () => {
    const a = tool("a");
    const b = tool("b");
    const c = tool("c");
    const list = [a, b, c];
    expect(siblingMove(list, 0, 1, null)).toEqual({
      kind: "move",
      position: { after: b.id },
    });
    expect(siblingMove(list, 2, -1, null)).toEqual({
      kind: "move",
      position: { after: a.id },
    });
    // to the head
    expect(siblingMove(list, 1, -1, null)).toEqual({
      kind: "move",
      position: { after: null },
    });
    // edges no-op
    expect(siblingMove(list, 0, -1, null)).toBeNull();
    expect(siblingMove(list, 2, 1, null)).toBeNull();
  });

  test("moving to the head of a non-first lane falls back to a container replacement", () => {
    const x = tool("x");
    const y = tool("y");
    const container = branch("br", [[], [x, y]]);
    const parent: StepListParent = { step: container, slot: "then", laneIndex: 1 };
    const move = siblingMove([x, y], 1, -1, parent);
    expect(move).not.toBeNull();
    expect(move!.kind).toBe("replace");
    if (move!.kind === "replace") {
      expect(move!.containerId).toBe(container.id);
      const replacement = move!.replacement as BranchStep;
      expect(replacement.branches[1]!.steps.map((s) => s.slug)).toEqual(["y", "x"]);
    }
  });
});

// ── isWithinSubtree ─────────────────────────────────────────────────────────

test("isWithinSubtree guards dropping a container into itself", () => {
  const child = tool("child");
  const container = loop("loop", [child]);
  const outside = tool("outside");
  const steps = [container, outside];
  expect(isWithinSubtree(steps, container.id, child.id)).toBe(true);
  expect(isWithinSubtree(steps, container.id, container.id)).toBe(true);
  expect(isWithinSubtree(steps, container.id, outside.id)).toBe(false);
});
