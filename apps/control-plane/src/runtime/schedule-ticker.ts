/**
 * Schedule ticker (agents-first §5.6) — fires cron-scheduled workflows from
 * the control plane. Compiled schedules were dead code in production (they
 * only fired under `eve start`, which workers never run — spike finding 6);
 * scheduling is now a platform concern:
 *
 * - Workflow publish syncs the trigger row's `cron` + `next_fire_at`.
 * - Every SCHEDULE_TICK_MS (default 30s) the ticker scans for DUE triggers
 *   (`next_fire_at <= now`, trigger enabled, workflow enabled + published).
 * - Each due trigger is CLAIMED in its own transaction under a per-trigger
 *   `pg_advisory_xact_lock`: re-read + re-check, then advance `next_fire_at`
 *   from NOW (no backfill — a control plane that was down over three windows
 *   fires ONCE, then resumes cadence) BEFORE dispatching. Multiple control
 *   planes are safe: the lock serializes claimers and the loser's re-check
 *   sees the advanced cursor.
 * - The dispatch itself is the ordinary workflow dispatch (origin/triggerType
 *   "schedule", `data.scheduledFor` = the window that fired, empty message —
 *   instructions carry the content). Scheduled runs are ordinary sessions:
 *   they can park on HITL approvals like any other run.
 *
 * A dispatch failure NEVER un-advances the cursor (the claim already
 * committed) — a broken schedule fires-and-fails once per window instead of
 * hot-looping. An unparseable cron (or one that can never fire again) clears
 * `next_fire_at`, disarming the trigger until the next publish rewrites it.
 *
 * index.ts wiring (start/stop next to the worker sweeper) belongs to the
 * integrator; this module only exposes the factory.
 */
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger } from "@invisible-string/shared";

import type { Db } from "../db";
import { CronParseError, nextFire } from "./cron";
import {
  dispatchTriggerRun,
  resolveWorkflowDispatchTarget,
} from "./dispatch";
import { isRuntimeApiError } from "./errors";
import type { RuntimeDeps } from "./routes";

/** Default tick cadence; overridden by SCHEDULE_TICK_MS (see .env.example). */
export const DEFAULT_SCHEDULE_TICK_MS = 30_000;

/** One claimed schedule window, ready to dispatch. */
export interface DueScheduleFire {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  /** The window that fired (the pre-advance `next_fire_at`). */
  scheduledFor: Date;
}

export interface ScheduleTickOutcome {
  /** Due rows the scan found. */
  due: number;
  /** Claims lost to a concurrent ticker (or re-check) — normal, not an error. */
  skipped: number;
  dispatched: number;
  failed: number;
}

export type ScheduleDispatchFn = (due: DueScheduleFire) => Promise<void>;

export interface ScheduleTicker {
  /** Begin the periodic scan (idempotent). */
  start(): void;
  /** Stop scanning and wait for an in-flight tick to finish. */
  stop(): Promise<void>;
  /** One scan-claim-dispatch pass (exposed for tests + acceptance proofs). */
  tick(): Promise<ScheduleTickOutcome>;
}

/**
 * Claim one due schedule fire: advisory-locked re-check + cursor advance in
 * a single transaction. Returns the claimed window, or null when the trigger
 * is no longer due (another instance won, the trigger was disabled, or the
 * cron disarmed). Exported for focused DB-gated tests.
 */
export async function claimDueScheduleFire(
  db: Db,
  triggerId: string,
  now: Date,
  logger?: Logger,
): Promise<{ scheduledFor: Date } | null> {
  return db.transaction(async (tx) => {
    // Namespaced away from the slack-thread lock keyspace (dispatch.ts).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`schedule:${triggerId}`})::bigint)`,
    );
    const rows = await tx
      .select({
        cron: schema.triggers.cron,
        nextFireAt: schema.triggers.nextFireAt,
        enabled: schema.triggers.enabled,
        type: schema.triggers.type,
      })
      .from(schema.triggers)
      .where(eq(schema.triggers.id, triggerId))
      .limit(1);
    const trigger = rows[0];
    if (
      !trigger ||
      trigger.type !== "schedule" ||
      !trigger.enabled ||
      trigger.cron === null ||
      trigger.nextFireAt === null ||
      trigger.nextFireAt.getTime() > now.getTime()
    ) {
      return null;
    }

    // Advance from NOW (no backfill), BEFORE any dispatch happens.
    let next: Date | null;
    try {
      next = nextFire(trigger.cron, now);
    } catch (error) {
      if (!(error instanceof CronParseError)) throw error;
      logger?.warn("schedule.disarmed", {
        fields: { triggerId, reason: error.message },
      });
      next = null;
    }
    await tx
      .update(schema.triggers)
      .set({ nextFireAt: next })
      .where(eq(schema.triggers.id, triggerId));

    return { scheduledFor: trigger.nextFireAt };
  });
}

export interface ScheduleTickerOptions {
  /** Tick cadence in ms (SCHEDULE_TICK_MS). */
  tickMs?: number;
  /** Injected clock (tests). */
  now?: () => Date;
  /**
   * Dispatch override (tests exercise claim mechanics without a worker
   * fleet). Production uses the built-in workflow dispatch.
   */
  dispatch?: ScheduleDispatchFn;
}

export function createScheduleTicker(
  deps: RuntimeDeps,
  options: ScheduleTickerOptions = {},
): ScheduleTicker {
  const { db, logger } = deps;
  const tickMs = options.tickMs ?? DEFAULT_SCHEDULE_TICK_MS;
  const clock = options.now ?? (() => new Date());

  /** The real dispatch: resolve the workflow's agent, render, run. */
  const dispatchDue: ScheduleDispatchFn =
    options.dispatch ??
    (async (due) => {
      const workflows = await db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.id, due.workflowId))
        .limit(1);
      const workflow = workflows[0];
      if (!workflow) return;
      const target = await resolveWorkflowDispatchTarget(deps, workflow);
      await dispatchTriggerRun(deps, {
        organizationId: workflow.organizationId,
        workflow: { id: workflow.id, snapshot: target.snapshot },
        agent: target.agent,
        origin: "schedule",
        triggerType: "schedule",
        principal: { workspaceId: workflow.organizationId, source: "schedule" },
        ingress: {
          // Instructions carry the task; the window rides as trigger data
          // (`@trigger.scheduledFor` resolvable from instructions).
          message: "",
          data: { scheduledFor: due.scheduledFor.toISOString() },
        },
      });
    });

  async function tick(): Promise<ScheduleTickOutcome> {
    const outcome: ScheduleTickOutcome = {
      due: 0,
      skipped: 0,
      dispatched: 0,
      failed: 0,
    };
    const now = clock();

    // Due scan (rides the partial index on next_fire_at): enabled schedule
    // triggers of enabled, PUBLISHED workflows only — unpublished or
    // kill-switched workflows never fire, and their cursor keeps advancing
    // only at the next publish.
    const due = await db
      .select({
        triggerId: schema.triggers.id,
        workflowId: schema.workflows.id,
        organizationId: schema.workflows.organizationId,
      })
      .from(schema.triggers)
      .innerJoin(schema.workflows, eq(schema.triggers.workflowId, schema.workflows.id))
      .where(
        and(
          eq(schema.triggers.type, "schedule"),
          eq(schema.triggers.enabled, true),
          isNotNull(schema.triggers.nextFireAt),
          lte(schema.triggers.nextFireAt, now),
          eq(schema.workflows.enabled, true),
          isNotNull(schema.workflows.published),
        ),
      );
    outcome.due = due.length;

    for (const row of due) {
      deps.metrics.recordSchedule("due");
      let claim: { scheduledFor: Date } | null;
      try {
        claim = await claimDueScheduleFire(db, row.triggerId, now, logger);
      } catch (error) {
        outcome.failed += 1;
        deps.metrics.recordSchedule("failed");
        logger.error("schedule.claim_failed", {
          workspaceId: row.organizationId,
          workflowId: row.workflowId,
          err: error,
          fields: { triggerId: row.triggerId },
        });
        continue;
      }
      if (!claim) {
        outcome.skipped += 1;
        continue;
      }

      try {
        await dispatchDue({
          triggerId: row.triggerId,
          workflowId: row.workflowId,
          organizationId: row.organizationId,
          scheduledFor: claim.scheduledFor,
        });
        outcome.dispatched += 1;
        deps.metrics.recordSchedule("dispatched");
        logger.info("schedule.fired", {
          workspaceId: row.organizationId,
          workflowId: row.workflowId,
          fields: {
            triggerId: row.triggerId,
            scheduledFor: claim.scheduledFor.toISOString(),
          },
        });
      } catch (error) {
        // Cursor already advanced — one failure per window, never a hot loop.
        outcome.failed += 1;
        deps.metrics.recordSchedule("failed");
        const level = isRuntimeApiError(error) ? "warn" : "error";
        logger.emit(level, "dispatch.failed", {
          workspaceId: row.organizationId,
          workflowId: row.workflowId,
          err: error,
          fields: { source: "schedule", triggerId: row.triggerId },
        });
      }
    }
    return outcome;
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
          logger.error("schedule.tick_failed", { err: error });
        })
        .finally(scheduleNext);
    }, tickMs);
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
