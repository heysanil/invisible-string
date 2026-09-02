/**
 * Pure step-tree helpers for the pipeline strip's STRUCTURAL edits
 * (insert / duplicate / reorder / drag). The strip never mutates the tree
 * itself — everything lands as one reducer action (`addStep` / `moveStep` /
 * `updateStep`), the same single-writer path copilot proposals ride.
 *
 * One vocabulary wrinkle these helpers absorb: the shared {@link StepPosition}
 * grammar resolves `after: null` in a branch's `then` slot to the FIRST lane
 * (see `insertStepAt`, lib/builder/model.ts), so "head of lane ≥2" is not
 * expressible as a position. Those edits fall back to a whole-container
 * `updateStep` replacement ({@link laneHeadFallback}) — still one action,
 * still the decreed reducer vocabulary.
 */
import {
  newStepId,
  walkSteps,
  type BranchStep,
  type PipelineStep,
  type StepPosition,
  type StepWalkEntry,
} from "@invisible-string/shared";

/** Where a rendered sibling list lives in the tree (null = top level). */
export interface StepListParent {
  step: PipelineStep;
  slot: "body" | "then" | "else";
  /** Lane index when `slot` is "then"; 0 otherwise. */
  laneIndex: number;
}

/** The walk entry for `stepId`, or null when the id is stale. */
export function stepEntryOf(
  steps: readonly PipelineStep[],
  stepId: string,
): StepWalkEntry | null {
  return walkSteps(steps).find((entry) => entry.step.id === stepId) ?? null;
}

/**
 * The {@link StepPosition} that inserts INTO `list` at `index` — or null when
 * the grammar cannot express it (head of a `then` lane other than the first;
 * see the module doc). `after: null` is head-of-list everywhere else.
 */
export function insertPositionFor(
  list: readonly PipelineStep[],
  index: number,
  parent: StepListParent | null,
): StepPosition | null {
  const after = index <= 0 ? null : (list[index - 1]?.id ?? null);
  if (parent === null) return { after };
  if (after === null && parent.slot === "then" && parent.laneIndex > 0) {
    return null;
  }
  return { after, parent: { stepId: parent.step.id, slot: parent.slot } };
}

/** Position immediately AFTER `stepId` in its own sibling list (duplicate target). */
export function positionAfter(
  steps: readonly PipelineStep[],
  stepId: string,
): StepPosition | null {
  const entry = stepEntryOf(steps, stepId);
  if (entry === null) return null;
  const parent = entry.ancestors.at(-1);
  if (parent === undefined || entry.slot === null) return { after: stepId };
  return { after: stepId, parent: { stepId: parent.id, slot: entry.slot } };
}

// ── Duplicate ───────────────────────────────────────────────────────────────

/** Every slug in the tree (uniqueness domain for cloned slugs). */
function slugsOf(steps: readonly PipelineStep[]): Set<string> {
  return new Set(
    walkSteps(steps)
      .map((entry) => entry.step.slug)
      .filter((slug) => slug.length > 0),
  );
}

/** `search` → `search-2` → `search-3` … first free variant. */
function uniquifySlug(slug: string, taken: Set<string>): string {
  if (slug === "" || !taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

/**
 * Deep-clone `step` with FRESH ids and tree-unique slugs on every node
 * (slugs are the `@steps.*` handles — a byte-identical clone would shadow
 * the original everywhere). `taken` accumulates so sibling clones in one
 * container never collide with each other either.
 */
export function cloneStepWithNewIds(
  step: PipelineStep,
  taken: Set<string>,
): PipelineStep {
  const slug = uniquifySlug(step.slug, taken);
  if (slug.length > 0) taken.add(slug);
  const base = { id: newStepId(), slug };
  switch (step.kind) {
    case "for_each":
      return {
        ...step,
        ...base,
        steps: step.steps.map((child) => cloneStepWithNewIds(child, taken)),
      };
    case "branch": {
      const branches = step.branches.map((branch) => ({
        ...branch,
        steps: branch.steps.map((child) => cloneStepWithNewIds(child, taken)),
      }));
      const elseSteps = step.else?.map((child) =>
        cloneStepWithNewIds(child, taken),
      );
      return {
        ...step,
        ...base,
        branches,
        ...(elseSteps !== undefined ? { else: elseSteps } : {}),
      };
    }
    default:
      return { ...step, ...base };
  }
}

/** The duplicate of `stepId` plus where it goes; null when the id is stale. */
export function duplicateOf(
  steps: readonly PipelineStep[],
  stepId: string,
): { step: PipelineStep; position: StepPosition } | null {
  const entry = stepEntryOf(steps, stepId);
  const position = positionAfter(steps, stepId);
  if (entry === null || position === null) return null;
  return { step: cloneStepWithNewIds(entry.step, slugsOf(steps)), position };
}

// ── Reorder within a sibling list ───────────────────────────────────────────

export interface SiblingMove {
  /** Expressible as `moveStep` — the preferred, copilot-parity action. */
  kind: "move";
  position: StepPosition;
}

export interface ContainerReplaceMove {
  /** Head-of-lane fallback: replace the whole branch container. */
  kind: "replace";
  containerId: string;
  replacement: PipelineStep;
}

/**
 * How to move the step at `index` in `list` one slot up or down — a
 * `moveStep` position when the grammar can say it, a container `updateStep`
 * replacement for the head-of-lane gap, or null at the list's edge.
 */
export function siblingMove(
  list: readonly PipelineStep[],
  index: number,
  direction: -1 | 1,
  parent: StepListParent | null,
): SiblingMove | ContainerReplaceMove | null {
  const target = index + direction;
  if (index < 0 || index >= list.length) return null;
  if (target < 0 || target >= list.length) return null;
  const step = list[index];
  if (step === undefined) return null;

  // The element that will PRECEDE the moved step after the reorder.
  const afterStep =
    direction === -1 ? (target === 0 ? null : list[target - 1]) : list[target];
  const after = afterStep?.id ?? null;

  if (parent === null) return { kind: "move", position: { after } };
  if (after === null && parent.slot === "then" && parent.laneIndex > 0) {
    // Inexpressible head-of-lane — reorder the lane and replace the container.
    if (parent.step.kind !== "branch") return null;
    const replacement = withLaneSteps(
      parent.step,
      parent.laneIndex,
      reorder(list, index, target),
    );
    return { kind: "replace", containerId: parent.step.id, replacement };
  }
  return {
    kind: "move",
    position: { after, parent: { stepId: parent.step.id, slot: parent.slot } },
  };
}

function reorder(
  list: readonly PipelineStep[],
  from: number,
  to: number,
): PipelineStep[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** `container` with lane `laneIndex`'s steps replaced. */
export function withLaneSteps(
  container: BranchStep,
  laneIndex: number,
  steps: PipelineStep[],
): BranchStep {
  const branches = container.branches.map((branch, index) =>
    index === laneIndex ? { ...branch, steps } : branch,
  );
  return { ...container, branches };
}

/**
 * Head-of-lane INSERT fallback (see module doc): the branch container with
 * `step` spliced into lane `laneIndex` at `index`, for `updateStep`.
 */
export function laneHeadFallback(
  parent: StepListParent,
  list: readonly PipelineStep[],
  index: number,
  step: PipelineStep,
): ContainerReplaceMove | null {
  if (parent.step.kind !== "branch") return null;
  const steps = [...list];
  steps.splice(Math.max(0, index), 0, step);
  return {
    kind: "replace",
    containerId: parent.step.id,
    replacement: withLaneSteps(parent.step, parent.laneIndex, steps),
  };
}

/** True when `candidateId` is inside `rootId`'s subtree (drop-guard). */
export function isWithinSubtree(
  steps: readonly PipelineStep[],
  rootId: string,
  candidateId: string,
): boolean {
  if (rootId === candidateId) return true;
  const entry = stepEntryOf(steps, candidateId);
  return entry?.ancestors.some((ancestor) => ancestor.id === rootId) ?? false;
}
