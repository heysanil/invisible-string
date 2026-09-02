/**
 * Pipeline plan — the pure bridge from a published v2 WorkflowConfig to the
 * shapes the driver executes against: the instance-path grammar (the
 * `run_steps` claim key), the step index, and the ledger→scope rebuild used
 * by crash recovery.
 *
 * INSTANCE PATHS. One config step can yield many run instances (`for_each`
 * bodies). A path is the step ids from the root joined with "/", with a
 * numeric ITERATION segment inserted under each for_each container:
 *
 *   st_a                    top-level step
 *   st_loop/3/st_b          step st_b, item 3 of loop st_loop
 *   st_loop/3/st_br/st_c    st_c inside branch st_br inside item 3
 *
 * Iteration segments are the ONLY all-digit segments (step ids are `st_…`),
 * which is what {@link pathHasIteration} leans on: a path without one is a
 * single-instance step whose terminal output is addressable as
 * `@steps.<slug>` for the rest of the run — exactly the rows scope rebuild
 * replays after a crash. Loop-body outputs are item-scoped and die with the
 * item; the loop's aggregate output represents them.
 */
import type {
  PipelineStep,
  WorkflowConfig,
} from "@invisible-string/shared";
import { walkSteps } from "@invisible-string/shared";

import type { RunStepRow } from "./step-store";

/** Separator in `run_steps.path` instance paths. */
export const STEP_PATH_SEPARATOR = "/";

/**
 * The parent frame a nested sequence executes under: the container step's own
 * instance path, plus the item index when the container is a `for_each`
 * (branch lanes carry no iteration — their children are single-instance).
 */
export interface StepParentFrame {
  path: string;
  /** for_each item index; null for branch lanes. */
  iteration: number | null;
}

/**
 * The instance path for one step under a parent frame (null = top level).
 * `st_a` · `st_loop/3/st_b` · `st_br/st_c`.
 */
export function stepInstancePath(
  parent: StepParentFrame | null,
  stepId: string,
): string {
  if (parent === null) return stepId;
  return parent.iteration === null
    ? `${parent.path}${STEP_PATH_SEPARATOR}${stepId}`
    : `${parent.path}${STEP_PATH_SEPARATOR}${parent.iteration}${STEP_PATH_SEPARATOR}${stepId}`;
}

/**
 * True when the path crosses a for_each item boundary (contains an
 * all-digit iteration segment) — such instances are item-scoped and never
 * contribute to the run-level `@steps.*` scope.
 */
export function pathHasIteration(path: string): boolean {
  return path
    .split(STEP_PATH_SEPARATOR)
    .some((segment) => /^\d+$/.test(segment));
}

/** The executable view of one published pipeline config. */
export interface PipelinePlan {
  steps: readonly PipelineStep[];
  /** Declared TOP-LEVEL step count — `pipeline.started`'s stepCount. */
  topLevelStepCount: number;
  /** Every declared step (all nesting levels) by stable id. */
  byId: ReadonlyMap<string, PipelineStep>;
}

/** Build the plan for a parsed config (pure; no validation beyond the parse). */
export function buildPipelinePlan(
  config: Pick<WorkflowConfig, "steps">,
): PipelinePlan {
  const byId = new Map<string, PipelineStep>();
  for (const entry of walkSteps(config.steps)) {
    byId.set(entry.step.id, entry.step);
  }
  return {
    steps: config.steps,
    topLevelStepCount: config.steps.length,
    byId,
  };
}

/**
 * Rebuild the run-level `@steps.*` scope record from a `run_steps` ledger:
 * every SUCCEEDED single-instance row (no iteration segment) with a slug
 * contributes its persisted output under that slug. This is the read the
 * ledger persists `output` FOR — crash recovery replays the config against
 * it instead of re-executing finished steps. (The driver's claim-adopt walk
 * produces the same record incrementally; this helper is the one-shot form
 * for consumers that need the final scope without driving, e.g. onComplete
 * re-rendering.)
 */
export function rebuildScopeSteps(
  rows: readonly RunStepRow[],
): Record<string, Record<string, unknown>> {
  const steps: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (row.status !== "succeeded") continue;
    if (row.stepSlug.length === 0) continue;
    if (pathHasIteration(row.path)) continue;
    steps[row.stepSlug] = row.output ?? {};
  }
  return steps;
}
