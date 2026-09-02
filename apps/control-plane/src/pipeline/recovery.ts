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
 * no new single-instance dependency. The lock reserves from the DEDICATED
 * pipeline lock pool (db.ts `$pipelineLockClient`, never the root pool) with
 * a bounded wait: an exhausted pool leaves the orphan un-adopted (counted
 * `locked`, logged `pipeline.recovery_lock_pool_exhausted`) for the next
 * sweep rather than queueing behind live drivers.
 *
 * The actual resume semantics live in the driver's claim-adopt replay
 * (runner.ts): scope rebuilds from the `run_steps` ledger's terminal
 * outputs; an interrupted `tool` step retries unless
 * `sideEffect: "at_most_once"` (fails `interrupted`); `infer` retries;
 * `agent` steps re-attach to their child run via `child_run_id`. A run whose
 * workflow or published config is gone fails outright (its delivery ledger
 * is settled).
 *
 * The sweep is NOT boot-only. "Un-adopted until the next sweep" was an empty
 * promise while the only sweep was boot reconciliation: a `locked` orphan
 * (pool exhausted at boot, or a driver in another replica that has since
 * died) stayed active — holding its workspace-cap slot, its SSE followers on
 * heartbeats — until the next restart. {@link createPipelineRecoverySweeper}
 * re-runs this sweep every `PIPELINE_RECOVERY_SWEEP_MS` in a HEALTHY process,
 * on the remote-cancel sweeper's pattern (runtime/reconcile.ts): one replica
 * per instant is elected by a transaction-scoped advisory try-lock, and the
 * body is safe to run repeatedly because adoption is already lock-gated — an
 * acquirable per-run lock PROVES no live driver anywhere owns the run, and a
 * run this process drives is skipped by its handle before any lock probe.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger } from "@invisible-string/shared";

import type { Db } from "../db";
import type { PipelineRunner, RunRow } from "./runner";

/** Type alias (not interface) so it logs as a structured `fields` value. */
export type PipelineRecoveryOutcome = {
  /** Adopted and re-driven from the ledger frontier. */
  resumed: number;
  /**
   * Advisory lock unavailable — a live driver already owns the run, or the
   * pipeline lock pool was exhausted (transient; re-swept next time).
   */
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

// ── The periodic pipeline-recovery sweeper ──────────────────────────────────

/** Default periodic sweep cadence; overridden by PIPELINE_RECOVERY_SWEEP_MS. */
export const DEFAULT_PIPELINE_RECOVERY_SWEEP_MS = 60_000;

/** Advisory key that elects one replica's scan per instant (a try-lock). */
const PIPELINE_RECOVERY_SWEEP_LOCK_KEY = "pipeline-recovery-sweep";

export interface PipelineRecoverySweeper {
  /** Begin the periodic sweep (idempotent). */
  start(): void;
  /** Stop sweeping and wait for an in-flight tick to finish. */
  stop(): Promise<void>;
  /**
   * One sweep pass (exposed for tests + acceptance proofs). Null when this
   * tick lost the replica election (another instance is scanning right now).
   */
  tick(): Promise<PipelineRecoveryOutcome | null>;
}

export interface PipelineRecoverySweeperDeps extends RecoverPipelineRunsDeps {
  /**
   * Replica election seam (unit fixtures without a db). Production leaves it
   * unset and elects through `pg_try_advisory_xact_lock` on `db`; a sweeper
   * with neither `db` nor `elect` is a construction error, never a silently
   * always-elected one.
   */
  elect?: () => Promise<boolean>;
}

/**
 * Re-runs {@link recoverPipelineRuns} every `intervalMs` (module doc). Each
 * tick first takes a short transaction-scoped advisory TRY-lock to elect one
 * scanning replica per instant — the remote-cancel sweeper's election — and
 * the real double-drive guard stays per run: the driver's own advisory lock,
 * try-acquired by `resume`, which an orphan's dead driver released with its
 * connection and a live driver (here or elsewhere) still holds. No pool
 * resource is held across the tick's work: the election lock ends with its
 * transaction before any adoption runs. A pool still exhausted simply counts
 * `locked` again; the next tick is the retry.
 *
 * index.ts wiring (start/stop beside the other tickers) belongs to the
 * integrator; this module only exposes the factory.
 */
export function createPipelineRecoverySweeper(
  deps: PipelineRecoverySweeperDeps,
  options: { intervalMs?: number } = {},
): PipelineRecoverySweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_PIPELINE_RECOVERY_SWEEP_MS;
  const { logger } = deps;
  const db = deps.db;
  if (!db && !deps.elect) {
    throw new Error(
      "createPipelineRecoverySweeper needs either `db` or an injected `elect`",
    );
  }
  const elect =
    deps.elect ??
    (async (): Promise<boolean> =>
      db!.transaction(async (tx) => {
        const rows = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${PIPELINE_RECOVERY_SWEEP_LOCK_KEY})::bigint) as elected`,
        );
        const row = (rows as unknown as Array<{ elected?: boolean }>)[0];
        return row?.elected === true;
      }));

  async function tick(): Promise<PipelineRecoveryOutcome | null> {
    if (!(await elect())) return null;
    // `recoverPipelineRuns` logs `pipeline.recovered` itself when anything
    // was adopted or failed; a quiet tick (nothing, or only `locked`) stays
    // silent — live drivers in this and other replicas count `locked` on
    // every pass and must not become log noise.
    return recoverPipelineRuns(deps);
  }

  // setTimeout chain (not setInterval): ticks never overlap themselves, and a
  // slow tick delays the next one instead of stacking.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick()
        .catch((error) => {
          logger.error("pipeline.recovery_sweep_failed", { err: error });
        })
        .finally(scheduleNext);
    }, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      scheduleNext();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    },
    tick,
  };
}
