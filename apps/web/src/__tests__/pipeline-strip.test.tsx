/**
 * DOM tests for the pipeline strip (components/pipeline): card rendering and
 * selection, the connector's insert menu (minted ids through `addStep`), the
 * overflow menu's structural edits, roving-tabindex keyboard nav, ghost
 * proposals, run-density overlays, nested lanes and the designed empty state.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import {
  STEP_ID_PATTERN,
  type BranchStep,
  type ForEachStep,
  type PipelineStep,
  type ToolStep,
} from "@invisible-string/shared";

import { PipelineStrip } from "../components/pipeline/PipelineStrip";
import { TriggerCard } from "../components/pipeline/TriggerCard";
import type { BuilderAction } from "../lib/builder/model";
import type { StepSummaryContext } from "../lib/builder/summary";

ensureDomForThisFile();
afterEach(cleanup);

let n = 0;
function id(): string {
  n += 1;
  return `st_${String(n).padStart(16, "0")}`;
}

function tool(slug: string, name?: string): ToolStep {
  return {
    id: id(),
    slug,
    ...(name !== undefined ? { name } : {}),
    kind: "tool",
    connectionId: "cn_slack",
    tool: "search_messages",
    args: { query: "@team-exec" },
    sideEffect: "at_least_once",
  };
}

const CTX: StepSummaryContext = {
  connections: [{ id: "cn_slack", name: "Slack" }],
  agents: [],
};

// ── rendering + selection ───────────────────────────────────────────────────

test("renders cards (title · kind · chip · summary) and selects on click", () => {
  const a = tool("search", "Search Slack");
  const b = tool("create");
  const onSelectStep = mock(() => {});
  const view = render(
    <PipelineStrip steps={[a, b]} ctx={CTX} onSelectStep={onSelectStep} />,
  );

  const cards = view.getAllByTestId("step-card");
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText("Search Slack")).toBeTruthy();
  expect(within(cards[0]!).getByText("Tool call")).toBeTruthy();
  expect(within(cards[0]!).getByTestId("step-chip").textContent).toBe("Slack");
  expect(
    within(cards[0]!).getByText("search_messages · 1 arg"),
  ).toBeTruthy();

  fireEvent.click(
    view.getByRole("button", { name: /create — Tool call step/ }),
  );
  expect(onSelectStep).toHaveBeenCalledWith(b.id);
});

test("diagnostics land on the owning card as an issue badge", () => {
  const a = tool("search");
  const view = render(
    <PipelineStrip
      steps={[a]}
      ctx={CTX}
      diagnostics={{
        trigger: [],
        byStep: { [a.id]: [{ severity: "error", message: "Broken." }] },
        general: [],
      }}
    />,
  );
  expect(view.getByTestId("step-issue-badge").textContent).toContain("1 issue");
});

// ── insert via connector ────────────────────────────────────────────────────

test("connector + menu mints a step and dispatches addStep at the gap", () => {
  const a = tool("search");
  const dispatch = mock((_action: BuilderAction) => {});
  const onSelectStep = mock(() => {});
  const view = render(
    <PipelineStrip
      steps={[a]}
      ctx={CTX}
      dispatch={dispatch}
      onSelectStep={onSelectStep}
    />,
  );

  // First gap: before the only card.
  fireEvent.click(view.getByRole("button", { name: /Add a step before/ }));
  fireEvent.click(view.getByRole("menuitem", { name: /Infer/ }));

  expect(dispatch).toHaveBeenCalledTimes(1);
  const action = dispatch.mock.calls[0]![0] as Extract<
    BuilderAction,
    { type: "addStep" }
  >;
  expect(action.type).toBe("addStep");
  expect(action.position).toEqual({ after: null });
  expect(action.step.kind).toBe("infer");
  expect(action.step.id).toMatch(STEP_ID_PATTERN);
  expect(action.step.slug).toBe("infer-1");
  // The freshly added step becomes the selection.
  expect(onSelectStep).toHaveBeenCalledWith(action.step.id);
});

test("no nested for_each: connectors inside a loop body omit the loop kind", () => {
  const child = tool("child");
  const loop: ForEachStep = {
    id: id(),
    slug: "each",
    kind: "for_each",
    items: { $ref: "steps.search.result" },
    steps: [child],
    maxItems: 100,
    onItemError: "halt",
  };
  const dispatch = mock(() => {});
  const view = render(
    <PipelineStrip steps={[loop]} ctx={CTX} dispatch={dispatch} />,
  );

  // A gap INSIDE the body ("before “child”").
  fireEvent.click(view.getByRole("button", { name: /Add a step before “child”/ }));
  const menu = view.getByRole("menu", { name: "Add a step" });
  expect(within(menu).queryByRole("menuitem", { name: /For each/ })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: /Branch/ })).toBeTruthy();
});

// ── overflow menu edits ─────────────────────────────────────────────────────

test("overflow menu: Remove dispatches removeStep, Duplicate a fresh-id addStep", () => {
  const a = tool("search");
  const b = tool("create");
  const dispatch = mock((_action: BuilderAction) => {});
  const view = render(
    <PipelineStrip steps={[a, b]} ctx={CTX} dispatch={dispatch} />,
  );

  fireEvent.click(view.getByRole("button", { name: "Step actions for search" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
  expect(dispatch).toHaveBeenCalledWith({ type: "removeStep", stepId: a.id });

  fireEvent.click(view.getByRole("button", { name: "Step actions for search" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Duplicate" }));
  const duplicate = dispatch.mock.calls
    .map((call) => call[0])
    .find(
      (action): action is Extract<BuilderAction, { type: "addStep" }> =>
        action.type === "addStep",
    );
  expect(duplicate).toBeDefined();
  expect(duplicate!.step.id).not.toBe(a.id);
  expect(duplicate!.step.slug).toBe("search-2");
  expect(duplicate!.position).toEqual({ after: a.id });
});

test("overflow menu: Move down dispatches moveStep after the next sibling", () => {
  const a = tool("search");
  const b = tool("create");
  const dispatch = mock((_action: BuilderAction) => {});
  const view = render(
    <PipelineStrip steps={[a, b]} ctx={CTX} dispatch={dispatch} />,
  );

  fireEvent.click(view.getByRole("button", { name: "Step actions for search" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Move down" }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "moveStep",
    stepId: a.id,
    position: { after: b.id },
  });
});

// ── keyboard nav ────────────────────────────────────────────────────────────

test("roving tabindex: one tab stop, arrows move focus across cards", () => {
  const a = tool("search");
  const b = tool("create");
  const view = render(<PipelineStrip steps={[a, b]} ctx={CTX} />);

  const cardButtons = [
    view.getByRole("button", { name: /search — Tool call step/ }),
    view.getByRole("button", { name: /create — Tool call step/ }),
  ];
  expect(cardButtons[0]!.tabIndex).toBe(0);
  expect(cardButtons[1]!.tabIndex).toBe(-1);

  act(() => cardButtons[0]!.focus());
  fireEvent.keyDown(view.getByRole("group", { name: "Pipeline steps" }), {
    key: "ArrowDown",
  });
  expect(document.activeElement).toBe(cardButtons[1]!);

  fireEvent.keyDown(view.getByRole("group", { name: "Pipeline steps" }), {
    key: "Home",
  });
  expect(document.activeElement).toBe(cardButtons[0]!);
});

// ── ghosts ──────────────────────────────────────────────────────────────────

test("an add ghost renders a dashed placeholder at its target gap", () => {
  const a = tool("search");
  const b = tool("create");
  const view = render(
    <PipelineStrip
      steps={[a, b]}
      ctx={CTX}
      ghosts={[
        {
          key: "prop-1",
          mode: "add",
          kind: "infer",
          title: "Summarize",
          summary: "Summarize each message",
          position: { after: a.id },
        },
      ]}
    />,
  );
  const ghost = view.getByTestId("ghost-step-card");
  expect(ghost.dataset["ghostMode"]).toBe("add");
  expect(within(ghost).getByText("Summarize")).toBeTruthy();
});

test("update/remove ghosts mark the targeted card", () => {
  const a = tool("search");
  const view = render(
    <PipelineStrip
      steps={[a]}
      ctx={CTX}
      ghosts={[
        {
          key: "prop-2",
          mode: "remove",
          kind: "tool",
          title: "search",
          targetStepId: a.id,
        },
      ]}
    />,
  );
  const card = view.getByRole("button", { name: /search — Tool call step/ });
  expect(card.dataset["ghost"]).toBe("remove");
});

// ── run density ─────────────────────────────────────────────────────────────

test("run overlay: status badges render and editing affordances disappear", () => {
  const a = tool("search");
  const b = tool("create");
  const view = render(
    <PipelineStrip
      steps={[a, b]}
      ctx={CTX}
      dispatch={mock(() => {})}
      runStates={
        new Map([
          [a.id, { status: "succeeded" as const, durationMs: 1200 }],
          [b.id, { status: "running" as const, attempt: 2 }],
        ])
      }
    />,
  );
  expect(view.getByText("Done")).toBeTruthy();
  expect(view.getByText(/Running/)).toBeTruthy();
  expect(view.getByText(/try 2/)).toBeTruthy();
  expect(view.getByText("1.2s")).toBeTruthy();
  expect(view.queryByRole("button", { name: /Step actions/ })).toBeNull();
  expect(view.queryByRole("button", { name: /Add a step/ })).toBeNull();
});

// ── nesting ─────────────────────────────────────────────────────────────────

test("branch lanes stack with labels; else renders when present", () => {
  const x = tool("notify");
  const container: BranchStep = {
    id: id(),
    slug: "route",
    kind: "branch",
    branches: [{ when: { truthy: { $ref: "trigger.urgent" } }, steps: [x] }],
    else: [],
  };
  const view = render(
    <PipelineStrip steps={[container as PipelineStep]} ctx={CTX} />,
  );
  const lanes = view.getAllByTestId("nested-lane");
  expect(lanes).toHaveLength(2);
  expect(within(lanes[0]!).getByText("When")).toBeTruthy();
  expect(within(lanes[0]!).getByText("@trigger.urgent")).toBeTruthy();
  expect(within(lanes[1]!).getByText("Else")).toBeTruthy();
  expect(within(lanes[0]!).getByText("notify")).toBeTruthy();
});

// ── inline inspector + empty state ──────────────────────────────────────────

test("the selected card expands the inline inspector", () => {
  const a = tool("search");
  const view = render(
    <PipelineStrip
      steps={[a]}
      ctx={CTX}
      selectedStepId={a.id}
      renderInspector={(step) => <p>inspector for {step.slug}</p>}
    />,
  );
  expect(view.getByText("inspector for search")).toBeTruthy();
});

// ── TriggerCard ─────────────────────────────────────────────────────────────

test("TriggerCard: collapsed summary header, expands to the real TriggerEditor + live slot", () => {
  const dispatch = mock((_action: BuilderAction) => {});
  const onToggle = mock(() => {});
  const definition = {
    version: 2 as const,
    trigger: { type: "schedule" as const, cron: "0 9 * * 1" },
    steps: [],
    overlap: "skip" as const,
  };

  const collapsed = render(
    <TriggerCard
      definition={definition}
      dispatch={dispatch}
      expanded={false}
      onToggle={onToggle}
      live={<p>live slot</p>}
    />,
  );
  expect(collapsed.getByText("Schedule")).toBeTruthy();
  expect(collapsed.getByText(/0 9 \* \* 1/)).toBeTruthy();
  expect(collapsed.queryByText("live slot")).toBeNull();
  fireEvent.click(collapsed.getByRole("button", { name: /Trigger/ }));
  expect(onToggle).toHaveBeenCalled();
  cleanup();

  const expanded = render(
    <TriggerCard
      definition={definition}
      dispatch={dispatch}
      expanded
      onToggle={onToggle}
      live={<p>live slot</p>}
      diagnostics={[{ severity: "warning", message: "Check the cron." }]}
    />,
  );
  // The EXISTING TriggerEditor body (its radio group), not a fork.
  expect(
    expanded.getByRole("radiogroup", { name: "Trigger type" }),
  ).toBeTruthy();
  expect(expanded.getByText("live slot")).toBeTruthy();
  expect(expanded.getByText("Check the cron.")).toBeTruthy();
  fireEvent.click(expanded.getByRole("radio", { name: /Webhook/ }));
  expect(dispatch).toHaveBeenCalledWith({
    type: "setTriggerType",
    triggerType: "webhook",
  });
});

test("empty pipeline: designed empty state with the inline add menu", () => {
  const dispatch = mock((_action: BuilderAction) => {});
  const view = render(
    <PipelineStrip
      steps={[]}
      ctx={CTX}
      dispatch={dispatch}
      onDescribeInstead={mock(() => {})}
    />,
  );
  expect(view.getByText("No steps yet")).toBeTruthy();
  fireEvent.click(view.getByRole("menuitem", { name: /Tool call/ }));
  const action = dispatch.mock.calls[0]![0] as Extract<
    BuilderAction,
    { type: "addStep" }
  >;
  expect(action.type).toBe("addStep");
  expect(action.step.kind).toBe("tool");
  expect(action.position).toEqual({ after: null });
});
