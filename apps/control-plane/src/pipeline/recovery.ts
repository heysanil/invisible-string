/**
 * Boot recovery for pipeline runs — the pipeline arm of
 * `reconcileInterruptedRuns` (runtime/reconcile.ts). A control-plane crash
 * leaves interpreted runs stuck in queued/running/waiting with their cap
 * slots held and their ledgers mid-flight; unlike agent runs there is no
 * worker to re-tail, so recovery RE-DRIVES them.
 *
 * Adoption is guarded by the driver's session-level advisory lock
 * (`pg_advisory_lock('pipeline:'||run_id)`): only runs whose lock is
 * acquirable are adopted, so a second control-plane instance (or this one's
 * own live drivers) are never double-driven — the schedule-ticker pattern,
 * no new single-instance dependency.
 *
 * The actual resume semantics live in the driver's claim-adopt replay
 * (runner.ts): scope rebuilds from the `run_steps` ledger's terminal
 * outputs; an interrupted `tool` step retries unless
 * `sideEffect: "at_most_once"` (fails `interrupted`); `infer` retries;
 * `agent` steps re-attach to their child run via `child_run_id`. A run whose
 * workflow or published config is gone fails outright (its delivery ledger
 * is settled).
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger } from "@invisible-string/shared";

import type { Db } from "../db";
import type { PipelineRunner, RunRow } from "./runner";

/** Type alias (not interface) so it logs as a structured `fields` value. */
export type PipelineRecoveryOutcome = {
  /** Adopted and re-driven from the ledger frontier. */
  resumed: number;
  /** Advisory lock unavailable — a live driver already owns the run. */
  locked: number;
  /** Unresumable (workflow/config gone) — failed with the slot freed. */
  failed: number;
};

export interface RecoverPipelineRunsDeps {
  /** Required unless `listRuns` is injected (unit tests). */
  db?: Db;
  runner: PipelineRunner;
  logger: Logger;
  /** Seam over the non-settled-pipeline-runs query. */
  listRuns?: () => Promise<RunRow[]>;
}

/**
 * Sweep every non-settled pipeline run and hand the acquirable ones back to
 * the driver. `waiting` is included on purpose: a parked parent's driver
 * died with the process, and re-driving re-attaches to the child run (the
 * park loop polls it) — the child itself is an ordinary agent run that the
 * agent-run sweeps handle.
 */
export async function recoverPipelineRuns(
  deps: RecoverPipelineRunsDeps,
): Promise<PipelineRecoveryOutcome> {
  const outcome: PipelineRecoveryOutcome = { resumed: 0, locked: 0, failed: 0 };
  const listRuns =
    deps.listRuns ??
    (() => {
      const db = deps.db;
      if (!db) {
        throw new Error(
          "recoverPipelineRuns needs either `db` or an injected `listRuns`",
        );
      }
      return db
        .select()
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.mode, "pipeline"),
            inArray(schema.runs.status, ["queued", "running", "waiting"]),
          ),
        );
    });
  const rows = await listRuns();
  for (const run of rows) {
    // A driver already live in THIS process (normal operation) is left
    // alone — recovery only adopts orphans.
    if (deps.runner.handles.has(run.id)) {
      outcome.locked += 1;
      continue;
    }
    try {
      const result = await deps.runner.resume(run);
      if (result === "resumed") outcome.resumed += 1;
      else if (result === "locked") outcome.locked += 1;
      else outcome.failed += 1;
    } catch (error) {
      // One unresumable run must not strand the rest of the sweep.
      deps.logger.error("pipeline.recovery_error", {
        runId: run.id,
        err: error,
      });
      outcome.failed += 1;
    }
  }
  if (outcome.resumed > 0 || outcome.failed > 0) {
    deps.logger.info("pipeline.recovered", {
      msg: `pipeline recovery: resumed ${outcome.resumed}, failed ${outcome.failed}, locked ${outcome.locked}`,
      fields: { ...outcome },
    });
  }
  return outcome;
}
