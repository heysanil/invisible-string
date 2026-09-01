/**
 * Plan unit tests: the instance-path grammar, iteration detection, the plan
 * index, and ledger→scope rebuilding.
 */
import { describe, expect, test } from "bun:test";

import { newStepId, type PipelineStep } from "@invisible-string/shared";

import {
  buildPipelinePlan,
  pathHasIteration,
  rebuildScopeSteps,
  stepInstancePath,
} from "./plan";
import { createMemoryRunStepStore } from "./step-store";

const toolStep = (slug: string): PipelineStep => ({
  id: newStepId(),
  slug,
  kind: "tool",
  connectionId: "cn_x",
  tool: "t",
  args: {},
  sideEffect: "at_least_once",
});

describe("stepInstancePath", () => {
  test("top level is the bare step id", () => {
    expect(stepInstancePath(null, "st_a")).toBe("st_a");
  });

  test("branch lanes nest without an iteration segment", () => {
    expect(stepInstancePath({ path: "st_br", iteration: null }, "st_c")).toBe(
      "st_br/st_c",
    );
  });

  test("for_each bodies insert the item index", () => {
    expect(stepInstancePath({ path: "st_loop", iteration: 3 }, "st_b")).toBe(
      "st_loop/3/st_b",
    );
  });

  test("branch inside a loop item composes both", () => {
    const branchPath = stepInstancePath({ path: "st_loop", iteration: 3 }, "st_br");
    expect(stepInstancePath({ path: branchPath, iteration: null }, "st_c")).toBe(
      "st_loop/3/st_br/st_c",
    );
  });
});

describe("pathHasIteration", () => {
  test("detects the all-digit iteration segment and nothing else", () => {
    expect(pathHasIteration("st_a")).toBeFalse();
    expect(pathHasIteration("st_br/st_c")).toBeFalse();
    expect(pathHasIteration("st_loop/0/st_b")).toBeTrue();
    expect(pathHasIteration("st_loop/12/st_br/st_c")).toBeTrue();
  });
});

describe("buildPipelinePlan", () => {
  test("indexes every nesting level; stepCount is top-level only", () => {
    const body = toolStep("body");
    const loop: PipelineStep = {
      id: newStepId(),
      slug: "loop",
      kind: "for_each",
      items: { $ref: "trigger.items" },
      steps: [body],
      maxItems: 100,
      onItemError: "halt",
    };
    const top = toolStep("top");
    const plan = buildPipelinePlan({ steps: [top, loop] });
    expect(plan.topLevelStepCount).toBe(2);
    expect(plan.byId.get(body.id)).toBe(body);
    expect(plan.byId.get(loop.id)).toBe(loop);
  });
});

describe("rebuildScopeSteps", () => {
  test("succeeded single-instance rows contribute; loop items and failures do not", async () => {
    const store = createMemoryRunStepStore();
    const runId = "run-1";
    const base = {
      runId,
      organizationId: "org-1",
      parentPath: null,
      iteration: null,
      status: "running" as const,
      input: null,
      startedAt: new Date(),
    };
    const a = await store.claim({
      ...base,
      stepId: "st_a",
      stepSlug: "search",
      path: "st_a",
      kind: "tool",
    });
    await store.finish(a.row.id, {
      status: "succeeded",
      output: { messages: [1, 2] },
      completedAt: new Date(),
    });
    const b = await store.claim({
      ...base,
      stepId: "st_b",
      stepSlug: "broken",
      path: "st_b",
      kind: "infer",
    });
    await store.finish(b.row.id, {
      status: "failed",
      error: "nope",
      errorClass: "x",
      completedAt: new Date(),
    });
    const item = await store.claim({
      ...base,
      stepId: "st_c",
      stepSlug: "per-item",
      path: "st_loop/0/st_c",
      parentPath: "st_loop",
      iteration: 0,
      kind: "tool",
    });
    await store.finish(item.row.id, {
      status: "succeeded",
      output: { itemScoped: true },
      completedAt: new Date(),
    });
    const unslugged = await store.claim({
      ...base,
      stepId: "st_d",
      stepSlug: "",
      path: "st_d",
      kind: "state",
    });
    await store.finish(unslugged.row.id, {
      status: "succeeded",
      output: { keys: [] },
      completedAt: new Date(),
    });

    const steps = rebuildScopeSteps(await store.listForRun(runId));
    expect(steps).toEqual({ search: { messages: [1, 2] } });
  });
});
