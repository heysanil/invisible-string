/**
 * Pipeline run progress — the SINGLE absorption point for the `pipeline.*`
 * run-stream vocabulary (packages/shared/pipeline-events.ts): a pure fold
 * from events (and/or the persisted `run_steps` ledger) into the
 * `Record<stepId, StepRunState>` the strip renders in "run" density. Both the
 * Runs detail view and the editor's just-triggered-run overlay consume it, so
 * the two surfaces can never read the same event stream in two dialects.
 *
 * Cards key on the CONFIG step's stable id, so a step that runs many times
 * (a `for_each` body) folds all of its instances into one card state:
 * - status: last event wins (the driver is sequential — instances never
 *   overlap), except a hard instance failure which STICKS for the ledger view
 *   (`onItemError: "continue"` records item failures the operator must see).
 * - `willRetry` failures stay "running": the step is between attempts, not
 *   settled — the retry's `step.started` bumps the visible attempt.
 * - a loop's `iterations` ride the SEQUENTIAL-driver guarantee: when item n
 *   (0-based) is in flight, items 0…n-1 are finished, so `done = n` while
 *   running and `done = total = n + 1` once the loop's own instance lands.
 *   `total` stays null (unknown) until the loop settles — the fan-out is
 *   dynamic and the events never announce a plan.
 *
 * Everything here is deterministic and side-effect free (the FrameStore
 * discipline of lib/chat/run-view.ts): the same fold serves the live SSE
 * stream, the replayed ledger, and tests.
 */
import type {
  PipelineStreamEvent,
  RunStepDto,
  RunStepStatus,
} from "@invisible-string/shared";

import type { StepRunState } from "../../components/pipeline";

/** Statuses a step instance can no longer leave. */
const TERMINAL_STEP_STATUSES: ReadonlySet<RunStepStatus> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);

export function isTerminalStepStatus(status: RunStepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

/**
 * The fold's accumulator. `states` is what the strip consumes; `paths` and
 * `lastIteration` are the bookkeeping that lets body-step events advance
 * their enclosing loop's counter (paths nest — `st_loop/3/st_b`).
 */
export interface PipelineRunProgress {
  /** Per-step display state, keyed by the config step's stable `st_` id. */
  states: ReadonlyMap<string, StepRunState>;
  /** Each step's own instance path, learned from its first event. */
  paths: ReadonlyMap<string, string>;
  /** Last 0-based iteration index seen per loop step id. */
  lastIteration: ReadonlyMap<string, number>;
}

export function emptyRunProgress(): PipelineRunProgress {
  return { states: new Map(), paths: new Map(), lastIteration: new Map() };
}

interface MutableProgress {
  states: Map<string, StepRunState>;
  paths: Map<string, string>;
  lastIteration: Map<string, number>;
}

function thaw(progress: PipelineRunProgress): MutableProgress {
  return {
    states: new Map(progress.states),
    paths: new Map(progress.paths),
    lastIteration: new Map(progress.lastIteration),
  };
}

/**
 * Advance every KNOWN ancestor loop whose instance path prefixes `path`.
 * The segment right after the loop's own path is the iteration index
 * (`st_loop/3/st_b` → 3); non-numeric segments (branch lanes) are ignored.
 */
function noteIteration(progress: MutableProgress, path: string): void {
  for (const [stepId, ownPath] of progress.paths) {
    if (!path.startsWith(`${ownPath}/`)) continue;
    const next = path.slice(ownPath.length + 1).split("/")[0] ?? "";
    if (!/^\d+$/.test(next)) continue;
    const iteration = Number(next);
    const last = progress.lastIteration.get(stepId);
    if (last !== undefined && last >= iteration) continue;
    progress.lastIteration.set(stepId, iteration);
    const existing = progress.states.get(stepId);
    // While item n runs, items 0…n-1 are done (sequential driver).
    progress.states.set(stepId, {
      status: existing?.status ?? "running",
      ...(existing?.attempt !== undefined ? { attempt: existing.attempt } : {}),
      ...(existing?.durationMs !== undefined
        ? { durationMs: existing.durationMs }
        : {}),
      iterations: { done: iteration, total: null },
    });
  }
}

/** Pure: fold ONE pipeline event into the accumulator (unknown types no-op). */
export function applyPipelineEvent(
  progress: PipelineRunProgress,
  event: PipelineStreamEvent,
): PipelineRunProgress {
  switch (event.type) {
    case "pipeline.step.started": {
      const next = thaw(progress);
      const { stepId, path, attempt } = event.data;
      if (!next.paths.has(stepId)) next.paths.set(stepId, path);
      noteIteration(next, path);
      const existing = next.states.get(stepId);
      next.states.set(stepId, {
        status: "running",
        attempt,
        ...(existing?.iterations !== undefined
          ? { iterations: existing.iterations }
          : {}),
      });
      return next;
    }

    case "pipeline.step.completed": {
      const next = thaw(progress);
      const { stepId, path, status, durationMs } = event.data;
      if (!next.paths.has(stepId)) next.paths.set(stepId, path);
      noteIteration(next, path);
      const existing = next.states.get(stepId);
      const last = next.lastIteration.get(stepId);
      // The loop's OWN instance landing finalizes its counter: every item ran.
      const iterations =
        last !== undefined && status === "succeeded"
          ? { done: last + 1, total: last + 1 }
          : existing?.iterations;
      next.states.set(stepId, {
        status,
        durationMs,
        ...(existing?.attempt !== undefined ? { attempt: existing.attempt } : {}),
        ...(iterations !== undefined ? { iterations } : {}),
      });
      return next;
    }

    case "pipeline.step.failed": {
      const next = thaw(progress);
      const { stepId, path, attempt, willRetry } = event.data;
      if (!next.paths.has(stepId)) next.paths.set(stepId, path);
      noteIteration(next, path);
      const existing = next.states.get(stepId);
      next.states.set(stepId, {
        // Between attempts the step is still working, not settled.
        status: willRetry ? "running" : "failed",
        attempt,
        ...(existing?.iterations !== undefined
          ? { iterations: existing.iterations }
          : {}),
      });
      return next;
    }

    case "pipeline.step.waiting": {
      const next = thaw(progress);
      const { stepId, path } = event.data;
      if (!next.paths.has(stepId)) next.paths.set(stepId, path);
      const existing = next.states.get(stepId);
      next.states.set(stepId, {
        status: "waiting",
        ...(existing?.attempt !== undefined ? { attempt: existing.attempt } : {}),
        ...(existing?.iterations !== undefined
          ? { iterations: existing.iterations }
          : {}),
      });
      return next;
    }

    // Run-level bookends and state-write notices carry no per-step display.
    case "pipeline.started":
    case "pipeline.state.updated":
    case "pipeline.completed":
      return progress;
  }
}

/** Fold many events (oldest first). */
export function applyPipelineEvents(
  progress: PipelineRunProgress,
  events: readonly PipelineStreamEvent[],
): PipelineRunProgress {
  let next = progress;
  for (const event of events) next = applyPipelineEvent(next, event);
  return next;
}

function durationOf(row: RunStepDto): number | undefined {
  if (row.startedAt === null || row.completedAt === null) return undefined;
  const ms = Date.parse(row.completedAt) - Date.parse(row.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Seed the accumulator from the persisted `run_steps` ledger (rows ascending
 * in claim order, per the API contract). Instance rows fold per stepId with a
 * hard-failure stick: a step with ANY failed instance reads failed even when
 * later items succeeded (`onItemError: "continue"` must stay visible).
 * Loop iteration counters are derived from the numeric segment after the
 * loop's own path; `total` fills in only once the loop's own row is terminal.
 */
export function progressFromLedger(
  rows: readonly RunStepDto[],
): PipelineRunProgress {
  const next: MutableProgress = {
    states: new Map(),
    paths: new Map(),
    lastIteration: new Map(),
  };
  const failedSticky = new Set<string>();

  // First pass: own paths (a step's FIRST row carries its instance path; the
  // loop's own row is its container path for the iteration scan below).
  for (const row of rows) {
    if (!next.paths.has(row.stepId)) next.paths.set(row.stepId, row.path);
  }

  for (const row of rows) {
    if (row.status === "failed") failedSticky.add(row.stepId);
    const existing = next.states.get(row.stepId);
    const duration = durationOf(row);
    next.states.set(row.stepId, {
      status: failedSticky.has(row.stepId) ? "failed" : row.status,
      attempt: Math.max(existing?.attempt ?? 1, row.attempt),
      ...(duration !== undefined
        ? { durationMs: duration }
        : existing?.durationMs !== undefined
          ? { durationMs: existing.durationMs }
          : {}),
      ...(existing?.iterations !== undefined
        ? { iterations: existing.iterations }
        : {}),
    });
  }

  // Iteration counters per loop (kind === "for_each" rows are the loops).
  for (const loop of rows.filter((row) => row.kind === "for_each")) {
    const prefix = `${loop.path}/`;
    const iterationRows = new Map<number, RunStepDto[]>();
    for (const row of rows) {
      if (!row.path.startsWith(prefix)) continue;
      const segment = row.path.slice(prefix.length).split("/")[0] ?? "";
      if (!/^\d+$/.test(segment)) continue;
      const iteration = Number(segment);
      const bucket = iterationRows.get(iteration) ?? [];
      bucket.push(row);
      iterationRows.set(iteration, bucket);
    }
    if (iterationRows.size === 0) continue;
    const done = [...iterationRows.values()].filter((bucket) =>
      bucket.every((row) => isTerminalStepStatus(row.status)),
    ).length;
    const total = isTerminalStepStatus(loop.status) ? iterationRows.size : null;
    const last = Math.max(...iterationRows.keys());
    next.lastIteration.set(loop.stepId, last);
    const existing = next.states.get(loop.stepId);
    if (existing !== undefined) {
      next.states.set(loop.stepId, {
        ...existing,
        iterations: { done, total },
      });
    }
  }

  return next;
}

/**
 * The strip's `runStates` view of the accumulator. Steps the run never
 * reached carry no entry — the run-density card then renders without a badge
 * (in flight) — unless `settled` is true, in which case the CALLER may map
 * absent config steps to a skipped state itself (it knows the config; this
 * module deliberately does not).
 */
export function runStatesOf(
  progress: PipelineRunProgress,
): ReadonlyMap<string, StepRunState> {
  return progress.states;
}
