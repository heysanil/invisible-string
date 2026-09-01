/**
 * The vertical pipeline strip — the workflow's step tree as a single readable
 * column: cards joined by hairline connectors, containers indenting their
 * children ({@link NestedSteps}; branch lanes stack, never column), pending
 * copilot proposals rendered as dashed ghosts at their target positions.
 *
 * The strip renders in two modes:
 * - EDIT (a `dispatch` is provided): connectors grow hover-"+" inserts, cards
 *   get overflow menus and drag handles, and the selected card can expand an
 *   inline inspector (`renderInspector` — the accordion; the shell mounts at
 *   most ONE Tiptap-bearing inspector this way, per the repo invariant).
 * - RUN (`runStates` provided, no dispatch): the SAME strip is the timeline —
 *   cards in "run" density with status badges, the connector feeding the
 *   running step pulsing.
 *
 * Every structural edit lands as ONE reducer action through `dispatch`
 * (`addStep`/`moveStep`/`removeStep`, with the whole-container `updateStep`
 * fallback for the head-of-lane positions the shared grammar cannot express —
 * see tree.ts). Ids are minted client-side via `newStep`, exactly like
 * copilot's validate.ts mints them server-side.
 *
 * Keyboard: ONE tab stop (roving tabindex over the cards in document order);
 * ArrowUp/ArrowDown/Home/End move focus, Enter/Space select (native button
 * activation). Reordering is on each card's handle/menu, not the strip.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus, Workflow } from "lucide-react";
import {
  walkSteps,
  type PipelineStep,
  type PipelineStepKind,
  type StepPosition,
} from "@invisible-string/shared";

import type { BuilderAction } from "../../lib/builder/model";
import { newStep } from "../../lib/builder/model";
import type { BuilderDiagnostics } from "../../lib/builder/diagnostics";
import {
  describeCondition,
  type StepSummaryContext,
} from "../../lib/builder/summary";
import { stepDisplayTitle } from "../../lib/copilot/mutations";
import { cn } from "../../lib/cn";
import { Popover } from "../ui/Popover";
import { AddStepMenu } from "./AddStepMenu";
import { GhostStepCard } from "./GhostStepCard";
import { NestedSteps, type NestedLane } from "./NestedSteps";
import { StepCard, type StepRunState } from "./StepCard";
import { StepConnector } from "./StepConnector";
import {
  duplicateOf,
  insertPositionFor,
  isWithinSubtree,
  laneHeadFallback,
  siblingMove,
  type StepListParent,
} from "./tree";

// ── Ghost proposals ─────────────────────────────────────────────────────────

/**
 * One pending copilot proposal, projected for the strip (the shell derives
 * these from the dock's pending step proposals; `title`/`summary` come from
 * the same display helpers the suggestion cards use, so ghost and card speak
 * one dialect).
 */
export interface PipelineGhost {
  /** Stable key (the proposal id). */
  key: string;
  mode: "add" | "update" | "remove" | "move";
  kind: PipelineStepKind;
  title: string;
  summary?: string;
  /** Target position (add, and move's destination). */
  position?: StepPosition;
  /** The existing step the proposal targets (update/remove). */
  targetStepId?: string;
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface PipelineStripProps {
  steps: readonly PipelineStep[];
  ctx: StepSummaryContext;
  /** Editing dispatch; omit for the read-only run view. */
  dispatch?: ((action: BuilderAction) => void) | undefined;
  diagnostics?: BuilderDiagnostics | undefined;
  selectedStepId?: string | null;
  onSelectStep?: ((stepId: string) => void) | undefined;
  /** Pending copilot proposals to ghost into the strip. */
  ghosts?: readonly PipelineGhost[];
  /** Per-step run overlay (step id → state); switches cards to "run" density. */
  runStates?: ReadonlyMap<string, StepRunState> | null;
  /** Applied-proposal flash target (pillar-flash on that card). */
  flashStepId?: string | null;
  /** "Describe it instead →" — focus the copilot composer. */
  onDescribeInstead?: (() => void) | undefined;
  /** Inline inspector under the selected card (edit mode's accordion). */
  renderInspector?: ((step: PipelineStep) => ReactNode) | undefined;
  className?: string;
}

export function PipelineStrip({
  steps,
  ctx,
  dispatch,
  diagnostics,
  selectedStepId = null,
  onSelectStep,
  ghosts = [],
  runStates = null,
  flashStepId = null,
  onDescribeInstead,
  renderInspector,
  className,
}: PipelineStripProps) {
  const editable = dispatch !== undefined && runStates === null;
  const rootRef = useRef<HTMLDivElement>(null);
  // Roving tabindex: the last card the user focused (falls back to the
  // selected card, then the first card in document order).
  const [focusedStepId, setFocusedStepId] = useState<string | null>(null);

  const order = walkSteps(steps).map((entry) => entry.step.id);
  const tabbableId =
    (focusedStepId !== null && order.includes(focusedStepId) ? focusedStepId : null) ??
    (selectedStepId !== null && order.includes(selectedStepId) ? selectedStepId : null) ??
    order[0] ??
    null;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const root = rootRef.current;
    if (root === null) return;
    const cards = Array.from(
      root.querySelectorAll<HTMLButtonElement>("[data-step-id]"),
    );
    if (cards.length === 0) return;
    const active = document.activeElement;
    const index = cards.findIndex((card) => card === active);
    // Only steer when focus is on a card — form fields keep their arrows.
    if (index === -1 && (event.key === "ArrowDown" || event.key === "ArrowUp")) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : Math.min(
              cards.length - 1,
              Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
            );
    cards[next]?.focus();
  }, []);

  // ── structural edits (single reducer action each — see tree.ts) ──────────

  const addAt = useCallback(
    (
      kind: PipelineStepKind,
      list: readonly PipelineStep[],
      index: number,
      parent: StepListParent | null,
    ) => {
      if (dispatch === undefined) return;
      const step = newStep(kind, steps);
      const position = insertPositionFor(list, index, parent);
      if (position !== null) {
        dispatch({ type: "addStep", step, position });
      } else if (parent !== null) {
        const fallback = laneHeadFallback(parent, list, index, step);
        if (fallback !== null) {
          dispatch({
            type: "updateStep",
            stepId: fallback.containerId,
            step: fallback.replacement,
          });
        }
      }
      onSelectStep?.(step.id);
    },
    [dispatch, steps, onSelectStep],
  );

  const dropAt = useCallback(
    (
      draggedId: string,
      list: readonly PipelineStep[],
      index: number,
      parent: StepListParent | null,
    ) => {
      if (dispatch === undefined) return;
      // Dropping a container into its own subtree would orphan it — the
      // reducer no-ops on that too, but don't even dispatch.
      if (parent !== null && isWithinSubtree(steps, draggedId, parent.step.id)) return;
      const position = insertPositionFor(list, index, parent);
      if (position === null) return;
      dispatch({ type: "moveStep", stepId: draggedId, position });
    },
    [dispatch, steps],
  );

  const moveBy = useCallback(
    (
      list: readonly PipelineStep[],
      index: number,
      direction: -1 | 1,
      parent: StepListParent | null,
    ) => {
      if (dispatch === undefined) return;
      const move = siblingMove(list, index, direction, parent);
      if (move === null) return;
      const step = list[index];
      if (step === undefined) return;
      if (move.kind === "move") {
        dispatch({ type: "moveStep", stepId: step.id, position: move.position });
      } else {
        dispatch({
          type: "updateStep",
          stepId: move.containerId,
          step: move.replacement,
        });
      }
    },
    [dispatch],
  );

  const duplicate = useCallback(
    (stepId: string) => {
      if (dispatch === undefined) return;
      const dup = duplicateOf(steps, stepId);
      if (dup === null) return;
      dispatch({ type: "addStep", step: dup.step, position: dup.position });
      onSelectStep?.(dup.step.id);
    },
    [dispatch, steps, onSelectStep],
  );

  // ── ghosts ────────────────────────────────────────────────────────────────

  /** Ghost cards landing at gap `index` of the given list. */
  function ghostsAtGap(
    list: readonly PipelineStep[],
    index: number,
    parent: StepListParent | null,
  ): PipelineGhost[] {
    return ghosts.filter((ghost) => {
      if (ghost.mode !== "add" && ghost.mode !== "move") return false;
      const position = ghost.position;
      if (position === undefined) return false;
      // Same list?
      if (parent === null) {
        if (position.parent !== undefined) return false;
      } else {
        if (position.parent === undefined) return false;
        if (position.parent.stepId !== parent.step.id) return false;
        if (position.parent.slot !== parent.slot) return false;
        if (parent.slot === "then") {
          // `after: null` resolves to the FIRST lane (shared grammar).
          const inLane =
            position.after === null
              ? parent.laneIndex === 0
              : list.some((sibling) => sibling.id === position.after);
          if (!inLane) return false;
        }
      }
      const at =
        position.after === null
          ? 0
          : list.findIndex((sibling) => sibling.id === position.after) + 1;
      // An anchor this list doesn't contain (stale proposal) renders nowhere.
      if (position.after !== null && at === 0) return false;
      return at === index;
    });
  }

  const ghostMarkFor = (stepId: string): "update" | "remove" | null => {
    for (const ghost of ghosts) {
      if (ghost.targetStepId !== stepId) continue;
      if (ghost.mode === "update") return "update";
      if (ghost.mode === "remove") return "remove";
    }
    return null;
  };

  // ── recursive list rendering ──────────────────────────────────────────────

  function renderList(
    list: readonly PipelineStep[],
    parent: StepListParent | null,
    insideForEach: boolean,
  ): ReactNode {
    const allowForEach = !insideForEach;
    const nodes: ReactNode[] = [];

    const gap = (index: number): void => {
      for (const ghost of ghostsAtGap(list, index, parent)) {
        nodes.push(
          <GhostStepCard
            key={`ghost-${ghost.key}`}
            kind={ghost.kind}
            title={ghost.title}
            summary={ghost.summary}
            mode={ghost.mode === "move" ? "move" : "add"}
          />,
        );
      }
      const position = insertPositionFor(list, index, parent);
      const before = list[index];
      const nextRun =
        runStates !== null && before !== undefined
          ? runStates.get(before.id)
          : undefined;
      const canInsert =
        editable && (position !== null || (parent !== null && parent.step.kind === "branch"));
      nodes.push(
        <StepConnector
          key={`gap-${index}`}
          active={nextRun?.status === "running"}
          allowForEach={allowForEach}
          positionLabel={
            before !== undefined
              ? `before “${stepDisplayTitle(before)}”`
              : "at the end"
          }
          onAdd={canInsert ? (kind) => addAt(kind, list, index, parent) : undefined}
          onDescribe={canInsert ? onDescribeInstead : undefined}
          onDropStep={
            editable && position !== null
              ? (stepId) => dropAt(stepId, list, index, parent)
              : undefined
          }
        />,
      );
    };

    list.forEach((step, index) => {
      gap(index);
      nodes.push(renderStep(step, list, index, parent, insideForEach));
    });
    gap(list.length);

    // An empty nested list gets a visible add affordance instead of a bare
    // hover-only "+" (designed empty state).
    if (list.length === 0 && editable) {
      nodes.push(
        <EmptyListAdd
          key="empty-add"
          allowForEach={allowForEach}
          onPick={(kind) => addAt(kind, list, 0, parent)}
          onDescribe={onDescribeInstead}
        />,
      );
    }

    return nodes;
  }

  function renderStep(
    step: PipelineStep,
    list: readonly PipelineStep[],
    index: number,
    parent: StepListParent | null,
    insideForEach: boolean,
  ): ReactNode {
    const issues = diagnostics?.byStep[step.id] ?? [];
    const run = runStates?.get(step.id) ?? null;
    const density = runStates !== null ? "run" : "default";
    const selected = step.id === selectedStepId;
    const canMoveUp = index > 0 ? () => moveBy(list, index, -1, parent) : null;
    const canMoveDown =
      index < list.length - 1 ? () => moveBy(list, index, 1, parent) : null;

    const card = (
      <StepCard
        step={step}
        ctx={ctx}
        density={density}
        selected={selected}
        tabbable={step.id === tabbableId}
        issueCount={issues.length}
        hasError={issues.some((issue) => issue.severity === "error")}
        run={run}
        ghostMode={ghostMarkFor(step.id)}
        flash={step.id === flashStepId}
        onSelect={onSelectStep === undefined ? undefined : () => onSelectStep(step.id)}
        onDuplicate={editable ? () => duplicate(step.id) : undefined}
        onRemove={
          editable && dispatch !== undefined
            ? () => dispatch({ type: "removeStep", stepId: step.id })
            : undefined
        }
        onMoveUp={editable ? canMoveUp : undefined}
        onMoveDown={editable ? canMoveDown : undefined}
      />
    );

    let children: ReactNode = null;
    if (step.kind === "for_each") {
      children = (
        <NestedSteps
          lanes={[
            {
              key: "body",
              label: "For each item",
              children: renderList(
                step.steps,
                { step, slot: "body", laneIndex: 0 },
                true,
              ),
            },
          ]}
        />
      );
    } else if (step.kind === "branch") {
      const lanes: NestedLane[] = step.branches.map((branch, laneIndex) => ({
        key: `then-${laneIndex}`,
        label: "When",
        detail: describeCondition(branch.when),
        children: renderList(
          branch.steps,
          { step, slot: "then", laneIndex },
          insideForEach,
        ),
      }));
      if (step.else !== undefined) {
        lanes.push({
          key: "else",
          label: "Else",
          children: renderList(
            step.else,
            { step, slot: "else", laneIndex: 0 },
            insideForEach,
          ),
        });
      }
      children = <NestedSteps lanes={lanes} />;
    }

    return (
      <div key={step.id} className="flex flex-col">
        {card}
        {selected && renderInspector !== undefined ? (
          <div className="panel-enter mt-1">{renderInspector(step)}</div>
        ) : null}
        {children}
      </div>
    );
  }

  // ── empty pipeline (designed, not accidental) ─────────────────────────────

  if (steps.length === 0) {
    return (
      <div
        ref={rootRef}
        data-testid="pipeline-strip"
        className={cn(
          "flex flex-col items-center gap-4 rounded-card-lg border border-dashed border-black/15 px-5 py-7 text-center",
          className,
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
          <Workflow size={17} aria-hidden="true" />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <p className="text-[13.5px] font-medium text-ink">No steps yet</p>
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            A pipeline runs its steps in order when the trigger fires. Pick a
            first step, or describe the whole thing to copilot.
          </p>
        </div>
        {editable ? (
          <div className="w-full max-w-xs text-left">
            <AddStepMenu
              onPick={(kind) => addAt(kind, steps, 0, null)}
              onDescribe={onDescribeInstead}
            />
          </div>
        ) : null}
        {ghosts.length > 0
          ? ghostsAtGap(steps, 0, null).map((ghost) => (
              <GhostStepCard
                key={`ghost-${ghost.key}`}
                kind={ghost.kind}
                title={ghost.title}
                summary={ghost.summary}
                mode={ghost.mode === "move" ? "move" : "add"}
                className="w-full text-left"
              />
            ))
          : null}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="pipeline-strip"
      role="group"
      aria-label="Pipeline steps"
      onKeyDown={onKeyDown}
      onFocusCapture={(event) => {
        const stepId = (event.target as HTMLElement).dataset?.["stepId"];
        if (stepId !== undefined) setFocusedStepId(stepId);
      }}
      className={cn("flex flex-col", className)}
    >
      {renderList(steps, null, false)}
    </div>
  );
}

/** Dashed "Add step" affordance for an empty nested lane. */
function EmptyListAdd({
  allowForEach,
  onPick,
  onDescribe,
}: {
  allowForEach: boolean;
  onPick: (kind: PipelineStepKind) => void;
  onDescribe?: (() => void) | undefined;
}) {
  return (
    <Popover
      label="Add a step"
      trigger={
        <button
          type="button"
          className="lift flex w-full items-center justify-center gap-1.5 rounded-card border border-dashed border-black/15 px-3 py-2 text-[12px] font-medium text-ink-3 hover:border-black/25 hover:text-ink"
        >
          <Plus size={12} aria-hidden="true" />
          Add step
        </button>
      }
    >
      {({ close }) => (
        <AddStepMenu
          allowForEach={allowForEach}
          onPick={(kind) => {
            close();
            onPick(kind);
          }}
          onDescribe={
            onDescribe === undefined
              ? undefined
              : () => {
                  close();
                  onDescribe();
                }
          }
        />
      )}
    </Popover>
  );
}
