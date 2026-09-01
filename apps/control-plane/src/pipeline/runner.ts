/**
 * Pipeline runner — the control-plane interpreter for v2 workflow configs
 * (TRIGGER → STEPS). One `runs` row per pipeline run (`mode: 'pipeline'`, no
 * eve session); one `run_steps` row per step INSTANCE; `pipeline.*` events
 * beside eve events under one monotonic seq (events.ts). The workflow itself
 * still builds nothing — agent steps spawn CHILD runs through the ordinary
 * dispatch machinery.
 *
 * Ordering guarantees mirror dispatchTriggerRun: the run row lands inside an
 * advisory-locked cap transaction BEFORE any execution (a crash mid-run
 * leaves a visible, recoverable row — never untracked work), and slack-origin
 * runs with an `onComplete.slackReply` are born owing a reply
 * (`delivery_status = pending`) that the DeliveryService settles off the
 * terminal status.
 *
 * DRIVER SHAPE. Sequential, `for_each` concurrency 1. Per instance: claim the
 * `(run_id, path)` ledger row → render input against the scope (shared
 * pipeline-template) → execute (tool/infer/agent via the injected
 * StepExecutor registry; filter/branch/for_each/state interpreted HERE) →
 * persist output → extend the scope → append events. The driver holds a
 * SESSION-level `pg_advisory_lock('pipeline:'||run_id)` for its lifetime, so
 * boot recovery adopts only runs whose lock is free (schedule-ticker
 * pattern; no new single-instance dependency).
 *
 * CRASH RECOVERY is replay: a rebooted driver walks the config from the top
 * and every claim that returns an existing row is ADOPTED — terminal outputs
 * rebuild the scope without re-execution, and only the frontier truly runs.
 * Interrupted `tool` steps retry (the at-least-once stance of runs/delivery)
 * unless `sideEffect: "at_most_once"`, which fails `interrupted` — the
 * honest option; `infer` retries; `agent` steps re-attach to their child run
 * by `child_run_id`.
 *
 * CANCELLATION is cooperative at step boundaries (eve's stance): cancel sets
 * a flag + aborts the in-flight attempt's signal; remaining steps are left
 * unwritten and the run lands `canceled` — a user decision, never an error.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type postgres from "postgres";
import { schema } from "@invisible-string/db";
import {
  evaluateCondition,
  renderMarkdownTemplate,
  renderTemplateRecord,
  resolveScopePath,
  buildStepOutputPreview,
  workflowConfigSchema,
  type Logger,
  type PipelineScope,
  type PipelineStep,
  type SessionOrigin,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import type { Db } from "../db";
import type { RunEventBus } from "../runs/bus";
import type { DeliveryService } from "../runs/delivery";
import type { RunStore } from "../runs/store";
import { ACTIVE_RUN_STATUSES, assertUnderRunCap, lockWorkspaceRunCap } from "../runtime/caps";
import {
  createPipelineEventAppender,
  publishRunStatus,
  type PipelineEventAppender,
} from "./events";
import {
  buildPipelinePlan,
  stepInstancePath,
  type StepParentFrame,
} from "./plan";
import type {
  RunStepRow,
  RunStepStore,
  WorkflowStateStore,
} from "./step-store";
import {
  WORKFLOW_STATE_MAX_KEYS,
  WORKFLOW_STATE_MAX_VALUE_BYTES,
} from "./step-store";
import type {
  PipelineExecutorDeps,
  StepExecuteContext,
  StepExecutor,
  StepOutcome,
} from "./types";

export type RunRow = typeof schema.runs.$inferSelect;

// ── Config knobs ────────────────────────────────────────────────────────────

/** PIPELINE_MAX_WALL_CLOCK_MS default — the whole run's budget. */
export const DEFAULT_PIPELINE_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

/** PIPELINE_MAX_STEPS_PER_RUN default — executed step INSTANCES per run. */
export const DEFAULT_MAX_EXECUTED_STEPS_PER_RUN = 200;

/** PIPELINE_MAX_STEP_OUTPUT_BYTES default — serialized per-step output cap. */
export const DEFAULT_MAX_STEP_OUTPUT_BYTES = 256 * 1024;

/** PIPELINE_CHILD_POLL_MS default — parked agent-step child-run poll cadence. */
export const DEFAULT_PIPELINE_CHILD_POLL_MS = 5_000;

export interface PipelineRunnerConfig {
  maxWallClockMs: number;
  maxExecutedStepsPerRun: number;
  maxStepOutputBytes: number;
  childPollMs: number;
}

/**
 * Parse the pipeline knobs from env (PIPELINE_MAX_WALL_CLOCK_MS,
 * PIPELINE_MAX_STEPS_PER_RUN, PIPELINE_MAX_STEP_OUTPUT_BYTES,
 * PIPELINE_CHILD_POLL_MS). Unset/invalid values fall back to defaults —
 * these are tuning knobs, not required config (runtime/config.ts owns the
 * fail-fast set).
 */
export function loadPipelineRunnerConfig(
  env: Record<string, string | undefined> = process.env,
): PipelineRunnerConfig {
  const parse = (raw: string | undefined, fallback: number): number => {
    const value = raw?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxWallClockMs: parse(
      env.PIPELINE_MAX_WALL_CLOCK_MS,
      DEFAULT_PIPELINE_MAX_WALL_CLOCK_MS,
    ),
    maxExecutedStepsPerRun: parse(
      env.PIPELINE_MAX_STEPS_PER_RUN,
      DEFAULT_MAX_EXECUTED_STEPS_PER_RUN,
    ),
    maxStepOutputBytes: parse(
      env.PIPELINE_MAX_STEP_OUTPUT_BYTES,
      DEFAULT_MAX_STEP_OUTPUT_BYTES,
    ),
    childPollMs: parse(
      env.PIPELINE_CHILD_POLL_MS,
      DEFAULT_PIPELINE_CHILD_POLL_MS,
    ),
  };
}

// ── Retry policy ────────────────────────────────────────────────────────────

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 60_000;

/**
 * Exponential backoff before retry `attempt + 1`: 2s·2^(attempt−1) capped at
 * 60s, with half-jitter (deterministic under an injected `random`).
 */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Default attempt timeout for tool steps (config `timeoutMs` overrides). */
export const DEFAULT_TOOL_STEP_TIMEOUT_MS = 60_000;

/** Fixed attempt timeout for infer steps. */
export const DEFAULT_INFER_STEP_TIMEOUT_MS = 120_000;

/**
 * Per-kind attempt budgets: tool 3 (config `retry.maxAttempts` overrides),
 * infer 2 (its internal schema-repair retry is the EXECUTOR's), agent 2 —
 * but the runner only retries outcomes the executor classified `retryable`,
 * which for agent steps means dispatch-phase failures (`session_busy`) and
 * never a failed turn. Control verbs are deterministic: 1.
 */
export function attemptBudget(step: PipelineStep): number {
  switch (step.kind) {
    case "tool":
      return step.retry?.maxAttempts ?? 3;
    case "infer":
      return 2;
    case "agent":
      return 2;
    default:
      return 1;
  }
}

function stepAttemptTimeoutMs(step: PipelineStep): number | null {
  switch (step.kind) {
    case "tool":
      return step.timeoutMs ?? DEFAULT_TOOL_STEP_TIMEOUT_MS;
    case "infer":
      return DEFAULT_INFER_STEP_TIMEOUT_MS;
    default:
      // Agent steps are bounded by the child run's own wall clock plus the
      // pipeline's remaining wall clock (applied by the attempt runner).
      return null;
  }
}

// ── Advisory run lock (session-level, driver lifetime) ──────────────────────

export interface PipelineRunLock {
  release(): Promise<void>;
}

export interface PipelineLockFactory {
  /** Null when another driver (this or another instance) holds the run. */
  tryAcquire(runId: string): Promise<PipelineRunLock | null>;
}

/**
 * `pg_try_advisory_lock(hashtext('pipeline:'||run_id))` on a RESERVED
 * postgres-js connection: session-level locks live on one physical
 * connection, and the pool rotates connections per query — so the lock (and
 * its unlock) must ride a connection reserved for the driver's lifetime.
 */
export function createPgPipelineLockFactory(
  sql: postgres.Sql,
): PipelineLockFactory {
  return {
    async tryAcquire(runId) {
      const key = `pipeline:${runId}`;
      const reserved = await sql.reserve();
      let locked = false;
      try {
        const rows =
          await reserved`select pg_try_advisory_lock(hashtext(${key})::bigint) as locked`;
        locked = rows[0]?.["locked"] === true;
      } finally {
        if (!locked) reserved.release();
      }
      if (!locked) return null;
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await reserved`select pg_advisory_unlock(hashtext(${key})::bigint)`;
          } finally {
            reserved.release();
          }
        },
      };
    },
  };
}

// ── Run creation (overlap + cap, dispatchTriggerRun's ordering) ─────────────

export interface CreatePipelineRunInput {
  organizationId: string;
  workflowId: string;
  overlap: WorkflowConfig["overlap"];
  triggerEvent: TriggerEvent;
  /** True ⇒ the run is born owing a reply (`delivery_status = pending`). */
  deliveryPending: boolean;
}

export type CreatePipelineRunResult =
  | { run: RunRow }
  | { skippedOverlap: true };

export interface PipelineRunCreator {
  create(input: CreatePipelineRunInput): Promise<CreatePipelineRunResult>;
}

/**
 * The production run creator: one advisory-locked transaction takes the
 * workspace cap lock, applies `overlap: "skip"` (another live run of THIS
 * workflow ⇒ skip — protects cursor semantics against a slow run overlapping
 * the next trigger window), asserts the workspace run cap, and inserts the
 * sessionless pipeline run row — all BEFORE any execution.
 */
export function createDrizzlePipelineRunCreator(
  db: Db,
  opts: { workspaceRunCap: number },
): PipelineRunCreator {
  return {
    async create(input) {
      return db.transaction(async (tx) => {
        await lockWorkspaceRunCap(tx, input.organizationId);
        if (input.overlap === "skip") {
          const live = await tx
            .select({ value: count() })
            .from(schema.runs)
            .where(
              and(
                eq(schema.runs.workflowId, input.workflowId),
                eq(schema.runs.mode, "pipeline"),
                inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
              ),
            );
          if ((live[0]?.value ?? 0) > 0) return { skippedOverlap: true };
        }
        await assertUnderRunCap(tx, input.organizationId, opts.workspaceRunCap);
        const inserted = await tx
          .insert(schema.runs)
          .values({
            agentSessionId: null,
            organizationId: input.organizationId,
            workflowId: input.workflowId,
            mode: "pipeline",
            triggerEvent: input.triggerEvent as unknown as Record<
              string,
              unknown
            >,
            taskMessage: null,
            deliveryStatus: input.deliveryPending ? "pending" : null,
            status: "queued",
          })
          .returning();
        return { run: inserted[0]! };
      });
    },
  };
}

// ── Runner surface ──────────────────────────────────────────────────────────

/** By-kind executor registry — tool/infer/agent live in `pipeline/steps/`. */
export type StepExecutorRegistry = Partial<
  Record<"tool" | "infer" | "agent", StepExecutor>
>;

export interface PipelineRunHandle {
  readonly runId: string;
  readonly workflowId: string;
  /** Settles when the driver exits (any terminal, or a shutdown interrupt). */
  readonly done: Promise<void>;
}

export interface StartPipelineRunInput {
  organizationId: string;
  workflow: { id: string; config: WorkflowConfig };
  /** The normalized envelope (provenance; `data` is the `@trigger.*` scope). */
  triggerEvent: TriggerEvent;
  origin: SessionOrigin;
}

export type StartPipelineRunResult =
  | { started: true; run: RunRow }
  | { started: false; reason: "overlap_skipped" };

export interface PipelineRunnerDeps {
  /**
   * Product DB — required unless EVERY drizzle-backed seam below
   * (`runCreator`, `locks`, `loadWorkflowConfig`) is injected (unit tests).
   */
  db?: Db;
  runStore: RunStore;
  stepStore: RunStepStore;
  stateStore: WorkflowStateStore;
  bus: RunEventBus;
  logger: Logger;
  executors: StepExecutorRegistry;
  /** What `StepExecuteContext.deps` carries into every executor call. */
  executorDeps: PipelineExecutorDeps;
  config: PipelineRunnerConfig;
  /** MAX_CONCURRENT_RUNS_PER_WORKSPACE (runtime config). */
  workspaceRunCap: number;
  /** Settles `onComplete.slackReply` obligations; optional in fixtures. */
  delivery?: DeliveryService;
  // Seams (production defaults derive from `db`):
  runCreator?: PipelineRunCreator;
  locks?: PipelineLockFactory;
  loadWorkflowConfig?: (workflowId: string) => Promise<WorkflowConfig | null>;
  /** Backoff/park sleeper (tests inject an instant fake). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Jitter source (tests pin it). */
  random?: () => number;
}

// ── Internals ───────────────────────────────────────────────────────────────

interface InternalHandle extends PipelineRunHandle {
  cancelRequested: boolean;
  /** Shutdown drain: exit WITHOUT terminal writes; boot recovery re-adopts. */
  interrupted: boolean;
  activeController: AbortController | null;
  /** Wakes the current backoff/park pause early (cancel/shutdown). */
  wake: (() => void) | null;
  resolveDone: () => void;
}

interface DriveCtx {
  run: RunRow;
  organizationId: string;
  workflowId: string;
  config: WorkflowConfig;
  handle: InternalHandle;
  events: PipelineEventAppender;
  logger: Logger;
  /** Epoch ms after which the run fails `wall_clock_exceeded`. */
  deadlineMs: number;
  /** Executed instance count vs `maxExecutedStepsPerRun`. */
  executed: number;
}

type StepResult =
  | { kind: "ok" }
  | { kind: "filtered" }
  | { kind: "failed"; error: string; errorClass: string }
  | { kind: "canceled" };

type SequenceOutcome =
  | { kind: "completed" }
  | { kind: "filtered" }
  | { kind: "halted"; error: string; errorClass: string }
  | { kind: "canceled" };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : "unexpected non-Error failure";
}

function extractTriggerData(
  triggerEvent: Record<string, unknown>,
): Record<string, unknown> {
  const data = triggerEvent["data"];
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function serializedByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

/**
 * The pipeline interpreter service — one per control-plane process, carried
 * on the runtime graph as `pipelines`. Live drivers register in {@link
 * PipelineRunner.handles} (the tailers-map analogue); `start` is the
 * dispatch entry, `resume` boot recovery's, `cancel` the routes layer's.
 */
export class PipelineRunner {
  readonly config: PipelineRunnerConfig;

  private readonly deps: PipelineRunnerDeps;
  private readonly logger: Logger;
  private readonly runCreator: PipelineRunCreator;
  private readonly locks: PipelineLockFactory;
  private readonly loadConfig: (
    workflowId: string,
  ) => Promise<WorkflowConfig | null>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly internalHandles = new Map<string, InternalHandle>();

  constructor(deps: PipelineRunnerDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.logger = deps.logger;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;

    const db = deps.db;
    const missing = (seam: string): never => {
      throw new Error(
        `PipelineRunner needs either \`db\` or an injected \`${seam}\``,
      );
    };
    this.runCreator =
      deps.runCreator ??
      (db
        ? createDrizzlePipelineRunCreator(db, {
            workspaceRunCap: deps.workspaceRunCap,
          })
        : missing("runCreator"));
    this.locks =
      deps.locks ??
      (db ? createPgPipelineLockFactory(db.$client) : missing("locks"));
    this.loadConfig =
      deps.loadWorkflowConfig ??
      (db
        ? async (workflowId) => {
            const rows = await db
              .select({ published: schema.workflows.published })
              .from(schema.workflows)
              .where(eq(schema.workflows.id, workflowId))
              .limit(1);
            const published = rows[0]?.published;
            if (!published) return null;
            const parsed = workflowConfigSchema.safeParse(published);
            return parsed.success ? parsed.data : null;
          }
        : missing("loadWorkflowConfig"));
  }

  /** Live drivers by run id (read-only outside the runner). */
  get handles(): ReadonlyMap<string, PipelineRunHandle> {
    return this.internalHandles;
  }

  /**
   * Dispatch one trigger event as a pipeline run. The run row (and its
   * delivery obligation) is committed before this resolves; interpretation
   * proceeds in-process (the handle map tracks it, `runs.status` is truth).
   */
  async start(input: StartPipelineRunInput): Promise<StartPipelineRunResult> {
    const config = input.workflow.config;
    const deliveryPending =
      input.origin === "slack" && Boolean(config.onComplete?.slackReply);
    const created = await this.runCreator.create({
      organizationId: input.organizationId,
      workflowId: input.workflow.id,
      overlap: config.overlap,
      triggerEvent: input.triggerEvent,
      deliveryPending,
    });
    if ("skippedOverlap" in created) {
      this.logger.info("pipeline.overlap_skipped", {
        workspaceId: input.organizationId,
        workflowId: input.workflow.id,
        msg: "overlap policy 'skip': a run of this workflow is still live",
      });
      return { started: false, reason: "overlap_skipped" };
    }
    const run = created.run;
    const lock = await this.locks.tryAcquire(run.id);
    if (!lock) {
      // A fresh run id nobody else knows — an unacquirable lock is infra
      // trouble, not contention. Fail visibly rather than execute unlocked.
      const error = "pipeline advisory lock unavailable at start";
      await this.failOutright(run.id, error, "lock_unavailable");
      return {
        started: true,
        run: { ...run, status: "failed", error },
      };
    }
    this.launch(run, config, extractTriggerData(run.triggerEvent), lock);
    return { started: true, run };
  }

  /**
   * Boot-recovery adoption of an orphaned pipeline run (queued/running/
   * waiting): acquire its advisory lock ("locked" when another driver holds
   * it), reload the workflow's published config, and replay the ledger.
   * A run whose workflow/config is gone fails outright ("failed").
   */
  async resume(run: RunRow): Promise<"resumed" | "locked" | "failed"> {
    if (this.internalHandles.has(run.id)) return "locked";
    const lock = await this.locks.tryAcquire(run.id);
    if (!lock) return "locked";
    try {
      if (!run.workflowId || !run.organizationId) {
        await this.failOutright(
          run.id,
          "pipeline run row is missing its workflow/workspace scope",
          "invalid_run",
        );
        await lock.release();
        return "failed";
      }
      const config = await this.loadConfig(run.workflowId);
      if (!config) {
        await this.failOutright(
          run.id,
          "cannot resume: the workflow's published pipeline config is gone",
          "workflow_missing",
        );
        await lock.release();
        return "failed";
      }
      this.launch(run, config, extractTriggerData(run.triggerEvent), lock);
      return "resumed";
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /**
   * Cooperative cancel — a user decision, never an error. Aborts the
   * in-flight attempt's signal, wakes any backoff/park pause, and lets the
   * driver settle the run `canceled` at the next boundary; remaining steps
   * are never executed. False when no live driver holds the run here (the
   * routes layer then falls back to a direct status CAS).
   */
  cancel(runId: string): boolean {
    const handle = this.internalHandles.get(runId);
    if (!handle) return false;
    handle.cancelRequested = true;
    handle.activeController?.abort();
    handle.wake?.();
    return true;
  }

  /**
   * Graceful shutdown: interrupt every driver WITHOUT terminal writes (the
   * runs stay queued/running/waiting for the next boot's recovery — a deploy
   * must not cancel user work), then wait for them to unwind.
   */
  async stopAll(): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const handle of this.internalHandles.values()) {
      handle.interrupted = true;
      handle.activeController?.abort();
      handle.wake?.();
      drains.push(handle.done);
    }
    await Promise.all(drains);
  }

  // ── driver ────────────────────────────────────────────────────────────────

  private launch(
    run: RunRow,
    config: WorkflowConfig,
    triggerData: Record<string, unknown>,
    lock: PipelineRunLock,
  ): void {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const handle: InternalHandle = {
      runId: run.id,
      workflowId: run.workflowId ?? "",
      done,
      resolveDone,
      cancelRequested: false,
      interrupted: false,
      activeController: null,
      wake: null,
    };
    this.internalHandles.set(run.id, handle);
    void this.drive(run, config, triggerData, lock, handle).catch((error) => {
      // drive() is defensive; this is the last-resort belt.
      this.logger.error("pipeline.driver_crashed", {
        runId: run.id,
        err: error,
      });
    });
  }

  private async drive(
    run: RunRow,
    config: WorkflowConfig,
    triggerData: Record<string, unknown>,
    lock: PipelineRunLock,
    handle: InternalHandle,
  ): Promise<void> {
    const runId = run.id;
    const logger = this.logger.child({
      runId,
      ...(run.workflowId ? { workflowId: run.workflowId } : {}),
      ...(run.organizationId ? { workspaceId: run.organizationId } : {}),
    });
    let scope: PipelineScope | null = null;
    let startedAt = this.now();
    try {
      const organizationId = run.organizationId;
      const workflowId = run.workflowId;
      if (!organizationId || !workflowId) {
        await this.failOutright(
          runId,
          "pipeline run row is missing its workflow/workspace scope",
          "invalid_run",
        );
        return;
      }
      const events = await createPipelineEventAppender({
        runStore: this.deps.runStore,
        bus: this.deps.bus,
        runId,
      });
      startedAt = this.now();
      const live = await this.deps.runStore.markRun(runId, {
        status: "running",
        startedAt,
      });
      if (!live) {
        // Already terminal (e.g. canceled while queued) — nothing to drive.
        logger.info("pipeline.run_not_startable", {
          msg: "pipeline run already terminal before the driver started",
        });
        return;
      }
      publishRunStatus(this.deps.bus, runId, "running");
      const plan = buildPipelinePlan(config);
      if (events.baseSeq === 0) {
        await events.emit({
          type: "pipeline.started",
          data: { stepCount: plan.topLevelStepCount },
        });
      }
      scope = {
        trigger: triggerData,
        steps: {},
        state: await this.deps.stateStore.snapshot(workflowId),
        now: startedAt.toISOString(),
      };
      const dctx: DriveCtx = {
        run,
        organizationId,
        workflowId,
        config,
        handle,
        events,
        logger,
        deadlineMs: startedAt.getTime() + this.config.maxWallClockMs,
        executed: 0,
      };
      const outcome = await this.runSequence(dctx, config.steps, scope, null);
      if (handle.interrupted) {
        logger.info("pipeline.interrupted", {
          msg: "shutdown drain — run left for boot recovery",
        });
        return;
      }
      const terminal =
        outcome.kind === "canceled"
          ? { status: "canceled" as const }
          : outcome.kind === "halted"
            ? { status: "failed" as const, error: outcome.error }
            : { status: "succeeded" as const };
      await this.settle(dctx, events, terminal, scope, startedAt);
    } catch (error) {
      if (handle.interrupted) return;
      logger.error("pipeline.driver_error", { err: error });
      try {
        const message = safeErrorMessage(error);
        await this.deps.runStore.markRun(runId, {
          status: "failed",
          error: message,
          completedAt: this.now(),
        });
        publishRunStatus(this.deps.bus, runId, "failed", message);
        await this.deliverOnComplete(run, config, scope, "failed");
      } catch (settleError) {
        logger.error("pipeline.settle_failed", { err: settleError });
      }
    } finally {
      this.internalHandles.delete(runId);
      try {
        await lock.release();
      } catch (releaseError) {
        logger.warn("pipeline.lock_release_failed", { err: releaseError });
      }
      handle.resolveDone();
    }
  }

  private async settle(
    dctx: DriveCtx,
    events: PipelineEventAppender,
    terminal: { status: "succeeded" | "failed" | "canceled"; error?: string },
    scope: PipelineScope,
    startedAt: Date,
  ): Promise<void> {
    const completedAt = this.now();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    await this.deps.runStore.markRun(dctx.run.id, {
      status: terminal.status,
      ...(terminal.error !== undefined ? { error: terminal.error } : {}),
      completedAt,
    });
    try {
      await events.emit({
        type: "pipeline.completed",
        data: { status: terminal.status, durationMs },
      });
    } catch (error) {
      // The status row is truth; a lost completion event is only cosmetic.
      dctx.logger.warn("pipeline.completed_event_failed", { err: error });
    }
    publishRunStatus(
      this.deps.bus,
      dctx.run.id,
      terminal.status,
      terminal.error ?? null,
    );
    await this.deliverOnComplete(dctx.run, dctx.config, scope, terminal.status);
    dctx.logger.info("pipeline.run_finished", {
      durationMs,
      fields: { status: terminal.status, executedSteps: dctx.executed },
    });
  }

  /**
   * Explicit end-of-run delivery: `onComplete.slackReply` renders against
   * the FINAL scope and rides the DeliveryService's CAS machinery (deliver()
   * no-ops unless the run owes a `pending` delivery, so calling it
   * unconditionally is safe; boot recovery re-renders from the replayed
   * scope by construction).
   */
  private async deliverOnComplete(
    run: RunRow,
    config: WorkflowConfig,
    scope: PipelineScope | null,
    status: "succeeded" | "failed" | "canceled",
  ): Promise<void> {
    const delivery = this.deps.delivery;
    if (!delivery) return;
    const template = config.onComplete?.slackReply?.template.markdown;
    if (template === undefined) return;
    try {
      const rendered =
        scope && status === "succeeded"
          ? renderMarkdownTemplate(template, scope)
          : null; // failed/canceled runs settle the ledger without a reply
      await delivery.deliver({
        runId: run.id,
        status,
        lastAssistantMessage: rendered,
      });
    } catch (error) {
      this.logger.warn("pipeline.delivery_failed", {
        runId: run.id,
        err: error,
      });
    }
  }

  /** Fail a run that never got (or can't get) a driver; settles delivery. */
  private async failOutright(
    runId: string,
    error: string,
    errorClass: string,
  ): Promise<void> {
    this.logger.warn("pipeline.run_failed_outright", {
      runId,
      msg: error,
      fields: { errorClass },
    });
    await this.deps.runStore.markRun(runId, {
      status: "failed",
      error,
      completedAt: this.now(),
    });
    publishRunStatus(this.deps.bus, runId, "failed", error);
    try {
      await this.deps.delivery?.deliver({
        runId,
        status: "failed",
        lastAssistantMessage: null,
      });
    } catch {
      // deliver() documents it never throws; belt only.
    }
  }

  // ── sequences ─────────────────────────────────────────────────────────────

  private async runSequence(
    dctx: DriveCtx,
    steps: readonly PipelineStep[],
    scope: PipelineScope,
    parent: StepParentFrame | null,
  ): Promise<SequenceOutcome> {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      if (dctx.handle.interrupted || dctx.handle.cancelRequested) {
        return { kind: "canceled" };
      }
      if (this.now().getTime() > dctx.deadlineMs) {
        return {
          kind: "halted",
          errorClass: "wall_clock_exceeded",
          error: `pipeline exceeded its wall clock (${this.config.maxWallClockMs}ms)`,
        };
      }
      if (dctx.executed >= this.config.maxExecutedStepsPerRun) {
        return {
          kind: "halted",
          errorClass: "step_budget_exceeded",
          error: `pipeline exceeded ${this.config.maxExecutedStepsPerRun} executed step instances`,
        };
      }
      const path = stepInstancePath(parent, step.id);
      const result = await this.executeStep(dctx, step, path, parent, scope);
      switch (result.kind) {
        case "ok":
          continue;
        case "filtered": {
          // A false filter fences the rest of THIS scope. At the top level
          // the remaining steps are visibly `skipped` and the run succeeds;
          // nested scopes propagate up (a for_each body maps it to "item
          // dropped", a branch lane hands it to its own parent).
          if (parent === null) {
            await this.skipRemaining(dctx, steps.slice(index + 1), parent);
          }
          return { kind: "filtered" };
        }
        case "failed":
          return {
            kind: "halted",
            error: result.error,
            errorClass: result.errorClass,
          };
        case "canceled":
          return { kind: "canceled" };
      }
    }
    return { kind: "completed" };
  }

  /** Ledger + timeline rows for steps a top-level filter fenced off. */
  private async skipRemaining(
    dctx: DriveCtx,
    steps: readonly PipelineStep[],
    parent: StepParentFrame | null,
  ): Promise<void> {
    for (const step of steps) {
      const path = stepInstancePath(parent, step.id);
      const at = this.now();
      const { created } = await this.deps.stepStore.claim({
        runId: dctx.run.id,
        organizationId: dctx.organizationId,
        stepId: step.id,
        stepSlug: step.slug,
        path,
        parentPath: parent?.path ?? null,
        iteration: parent?.iteration ?? null,
        kind: step.kind,
        status: "skipped",
        input: null,
        startedAt: at,
        completedAt: at,
      });
      // Adopted rows (a previous incarnation already skipped/ran it) keep
      // their history — no duplicate event.
      if (!created) continue;
      await dctx.events.emit({
        type: "pipeline.step.completed",
        data: {
          stepId: step.id,
          slug: step.slug,
          kind: step.kind,
          path,
          status: "skipped",
          durationMs: 0,
        },
      });
    }
  }

  private executeStep(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    switch (step.kind) {
      case "tool":
      case "infer":
      case "agent":
        return this.executeLeaf(dctx, step, path, parent, scope);
      case "filter":
        return this.executeFilter(dctx, step, path, parent, scope);
      case "branch":
        return this.executeBranch(dctx, step, path, parent, scope);
      case "for_each":
        return this.executeForEach(dctx, step, path, parent, scope);
      case "state":
        return this.executeState(dctx, step, path, parent, scope);
    }
  }

  private claim(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    parent: StepParentFrame | null,
    input: unknown,
  ): Promise<{ created: boolean; row: RunStepRow }> {
    return this.deps.stepStore.claim({
      runId: dctx.run.id,
      organizationId: dctx.organizationId,
      stepId: step.id,
      stepSlug: step.slug,
      path,
      parentPath: parent?.path ?? null,
      iteration: parent?.iteration ?? null,
      kind: step.kind,
      status: "running",
      input,
      startedAt: this.now(),
    });
  }

  private extendScope(
    scope: PipelineScope,
    step: PipelineStep,
    output: Record<string, unknown>,
  ): void {
    if (step.slug.length > 0) scope.steps[step.slug] = output;
  }

  private async emitStarted(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    attempt: number,
    childRunId?: string | null,
  ): Promise<void> {
    await dctx.events.emit({
      type: "pipeline.step.started",
      data: {
        stepId: step.id,
        slug: step.slug,
        kind: step.kind,
        path,
        attempt,
        ...(childRunId ? { childRunId } : {}),
      },
    });
  }

  private async finishFailed(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    rowId: string,
    attempt: number,
    errorClass: string,
    error: string,
  ): Promise<StepResult> {
    await this.deps.stepStore.finish(rowId, {
      status: "failed",
      error,
      errorClass,
      completedAt: this.now(),
    });
    await dctx.events.emit({
      type: "pipeline.step.failed",
      data: {
        stepId: step.id,
        slug: step.slug,
        kind: step.kind,
        path,
        attempt,
        errorClass,
        error,
        willRetry: false,
      },
    });
    return { kind: "failed", error, errorClass };
  }

  private async finishSucceeded(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    rowId: string,
    scope: PipelineScope,
    output: Record<string, unknown>,
    startedAtMs: number,
  ): Promise<void> {
    await this.deps.stepStore.finish(rowId, {
      status: "succeeded",
      output,
      completedAt: this.now(),
    });
    this.extendScope(scope, step, output);
    const preview = buildStepOutputPreview(output);
    await dctx.events.emit({
      type: "pipeline.step.completed",
      data: {
        stepId: step.id,
        slug: step.slug,
        kind: step.kind,
        path,
        status: "succeeded",
        durationMs: Math.max(0, this.now().getTime() - startedAtMs),
        ...(preview !== undefined ? { outputPreview: preview } : {}),
      },
    });
  }

  /** Interruptible pause (backoff / child poll) — cancel/shutdown wake it. */
  private pause(handle: InternalHandle, ms: number): Promise<void> {
    if (handle.cancelRequested || handle.interrupted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        handle.wake = null;
        resolve();
      };
      handle.wake = done;
      void this.sleep(ms).then(done);
    });
  }

  // ── control verbs (interpreted in the driver) ─────────────────────────────

  private async executeFilter(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "filter" }>,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    const claimStart = this.now().getTime();
    const claim = await this.claim(dctx, step, path, parent, null);
    let attempt = 1;
    if (!claim.created) {
      const adopted = this.adoptTerminal(claim.row, step, scope);
      if (adopted) {
        // An adopted filter decision must keep fencing on replay.
        if (adopted.kind === "ok" && claim.row.status === "succeeded") {
          const output = claim.row.output as { matched?: unknown } | null;
          if (output?.matched === false) return { kind: "filtered" };
        }
        return adopted;
      }
      attempt = claim.row.attempt + 1;
      await this.deps.stepStore.markRunning(claim.row.id, {
        attempt,
        startedAt: this.now(),
      });
    }
    dctx.executed += 1;
    await this.emitStarted(dctx, step, path, attempt);
    let matched: boolean;
    try {
      matched = evaluateCondition(step.where, scope);
    } catch (error) {
      return this.finishFailed(
        dctx,
        step,
        path,
        claim.row.id,
        attempt,
        "condition_error",
        safeErrorMessage(error),
      );
    }
    await this.finishSucceeded(
      dctx,
      step,
      path,
      claim.row.id,
      scope,
      { matched },
      claimStart,
    );
    return matched ? { kind: "ok" } : { kind: "filtered" };
  }

  private async executeState(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "state" }>,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    const startMs = this.now().getTime();
    const entries = renderTemplateRecord(step.set, scope);
    const claim = await this.claim(dctx, step, path, parent, { set: entries });
    let attempt = 1;
    if (!claim.created) {
      const adopted = this.adoptTerminal(claim.row, step, scope);
      if (adopted) {
        if (adopted.kind === "ok") {
          // The write was durable; fold the persisted values back into the
          // scope so later refs see them on replay.
          const input = claim.row.input as { set?: unknown } | null;
          const set = input?.set;
          if (set && typeof set === "object" && !Array.isArray(set)) {
            Object.assign(scope.state, set as Record<string, unknown>);
          }
        }
        return adopted;
      }
      attempt = claim.row.attempt + 1;
      await this.deps.stepStore.markRunning(claim.row.id, {
        attempt,
        input: { set: entries },
        startedAt: this.now(),
      });
    }
    dctx.executed += 1;
    await this.emitStarted(dctx, step, path, attempt);
    // App caps (schema comment): ≤200 keys/workflow, ≤64KB per value.
    for (const [key, value] of Object.entries(entries)) {
      const bytes = serializedByteLength(value);
      if (bytes === null || bytes > WORKFLOW_STATE_MAX_VALUE_BYTES) {
        return this.finishFailed(
          dctx,
          step,
          path,
          claim.row.id,
          attempt,
          "state_value_too_large",
          `state value "${key}" exceeds ${WORKFLOW_STATE_MAX_VALUE_BYTES} bytes (or is unserializable)`,
        );
      }
    }
    const resultingKeys = new Set([
      ...Object.keys(scope.state),
      ...Object.keys(entries),
    ]);
    if (resultingKeys.size > WORKFLOW_STATE_MAX_KEYS) {
      return this.finishFailed(
        dctx,
        step,
        path,
        claim.row.id,
        attempt,
        "state_cap_exceeded",
        `workflow state would exceed ${WORKFLOW_STATE_MAX_KEYS} keys`,
      );
    }
    await this.deps.stateStore.set({
      workflowId: dctx.workflowId,
      organizationId: dctx.organizationId,
      runId: dctx.run.id,
      entries,
    });
    Object.assign(scope.state, entries);
    const keys = Object.keys(entries);
    await dctx.events.emit({
      type: "pipeline.state.updated",
      data: { stepId: step.id, path, keys },
    });
    await this.finishSucceeded(
      dctx,
      step,
      path,
      claim.row.id,
      scope,
      { keys },
      startMs,
    );
    return { kind: "ok" };
  }

  private async executeBranch(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "branch" }>,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    const startMs = this.now().getTime();
    const claim = await this.claim(dctx, step, path, parent, null);
    let lane: number | "else" | null;
    if (!claim.created && claim.row.status === "succeeded") {
      // The decision is on record — re-descend into the chosen lane (its
      // children adopt-or-execute idempotently); no duplicate events.
      this.extendScope(scope, step, claim.row.output ?? {});
      lane = readBranchLane(claim.row.output, step);
    } else {
      let attempt = 1;
      if (!claim.created) {
        const adopted = this.adoptTerminal(claim.row, step, scope);
        if (adopted) return adopted;
        attempt = claim.row.attempt + 1;
        await this.deps.stepStore.markRunning(claim.row.id, {
          attempt,
          startedAt: this.now(),
        });
      }
      dctx.executed += 1;
      await this.emitStarted(dctx, step, path, attempt);
      try {
        lane = null;
        for (let index = 0; index < step.branches.length; index += 1) {
          if (evaluateCondition(step.branches[index]!.when, scope)) {
            lane = index;
            break;
          }
        }
        if (lane === null && step.else) lane = "else";
      } catch (error) {
        return this.finishFailed(
          dctx,
          step,
          path,
          claim.row.id,
          attempt,
          "condition_error",
          safeErrorMessage(error),
        );
      }
      await this.finishSucceeded(
        dctx,
        step,
        path,
        claim.row.id,
        scope,
        { lane },
        startMs,
      );
    }
    if (lane === null) return { kind: "ok" };
    const laneSteps =
      lane === "else" ? (step.else ?? []) : (step.branches[lane]?.steps ?? []);
    const outcome = await this.runSequence(dctx, laneSteps, scope, {
      path,
      iteration: null,
    });
    switch (outcome.kind) {
      case "completed":
        return { kind: "ok" };
      case "filtered":
        return { kind: "filtered" };
      case "halted":
        return {
          kind: "failed",
          error: outcome.error,
          errorClass: outcome.errorClass,
        };
      case "canceled":
        return { kind: "canceled" };
    }
  }

  private async executeForEach(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "for_each" }>,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    const startMs = this.now().getTime();
    const itemsRaw = resolveScopePath(scope, step.items.$ref);
    const claim = await this.claim(dctx, step, path, parent, {
      itemsRef: step.items.$ref,
      count: Array.isArray(itemsRaw) ? itemsRaw.length : null,
    });
    let attempt = 1;
    if (!claim.created) {
      const adopted = this.adoptTerminal(claim.row, step, scope);
      if (adopted) return adopted;
      // Interrupted mid-loop: the body claims below adopt every finished
      // item instance, so replay resumes at the frontier — no special case.
      attempt = claim.row.attempt + 1;
      await this.deps.stepStore.markRunning(claim.row.id, {
        attempt,
        startedAt: this.now(),
      });
    }
    dctx.executed += 1;
    await this.emitStarted(dctx, step, path, attempt);
    if (!Array.isArray(itemsRaw)) {
      return this.finishFailed(
        dctx,
        step,
        path,
        claim.row.id,
        attempt,
        "items_not_array",
        `for_each items (${step.items.$ref}) did not resolve to an array`,
      );
    }
    if (itemsRaw.length > step.maxItems) {
      // Silent truncation would corrupt cursor semantics — overflow FAILS.
      return this.finishFailed(
        dctx,
        step,
        path,
        claim.row.id,
        attempt,
        "fan_out_exceeded",
        `for_each resolved ${itemsRaw.length} items, over its maxItems of ${step.maxItems}`,
      );
    }
    const records: {
      index: number;
      status: "succeeded" | "failed" | "skipped";
      error?: string;
      errorClass?: string;
    }[] = [];
    for (let index = 0; index < itemsRaw.length; index += 1) {
      if (dctx.handle.interrupted) return { kind: "canceled" };
      if (dctx.handle.cancelRequested) {
        await this.deps.stepStore.finish(claim.row.id, {
          status: "canceled",
          completedAt: this.now(),
        });
        return { kind: "canceled" };
      }
      // Item isolation: each item sees the shared run scope plus its own
      // body outputs — a COPY of `steps`, so item N's body slugs never leak
      // into item N+1. `state` is the same object on purpose (durable,
      // shared); the loop's aggregate is the only body output that survives.
      const itemScope: PipelineScope = {
        trigger: scope.trigger,
        steps: { ...scope.steps },
        state: scope.state,
        item: itemsRaw[index],
        now: scope.now,
      };
      const outcome = await this.runSequence(dctx, step.steps, itemScope, {
        path,
        iteration: index,
      });
      if (outcome.kind === "completed") {
        records.push({ index, status: "succeeded" });
      } else if (outcome.kind === "filtered") {
        // A false filter inside the body drops the CURRENT item only.
        records.push({ index, status: "skipped" });
      } else if (outcome.kind === "canceled") {
        if (dctx.handle.interrupted) return { kind: "canceled" };
        await this.deps.stepStore.finish(claim.row.id, {
          status: "canceled",
          completedAt: this.now(),
        });
        return { kind: "canceled" };
      } else {
        if (step.onItemError === "halt") {
          return this.finishFailed(
            dctx,
            step,
            path,
            claim.row.id,
            attempt,
            outcome.errorClass,
            `item ${index} failed: ${outcome.error}`,
          );
        }
        records.push({
          index,
          status: "failed",
          error: outcome.error,
          errorClass: outcome.errorClass,
        });
      }
    }
    const aggregate: Record<string, unknown> = {
      total: itemsRaw.length,
      succeeded: records.filter((r) => r.status === "succeeded").length,
      failed: records.filter((r) => r.status === "failed").length,
      skipped: records.filter((r) => r.status === "skipped").length,
      items: records,
    };
    await this.finishSucceeded(
      dctx,
      step,
      path,
      claim.row.id,
      scope,
      aggregate,
      startMs,
    );
    return { kind: "ok" };
  }

  /**
   * Adoption of a row a previous incarnation of this run already wrote:
   * terminal rows short-circuit (success feeds the scope; failure/cancel
   * propagate as if they just happened); null means "not terminal — the
   * caller resumes execution" (running/pending/waiting).
   */
  private adoptTerminal(
    row: RunStepRow,
    step: PipelineStep,
    scope: PipelineScope,
  ): StepResult | null {
    switch (row.status) {
      case "succeeded":
        this.extendScope(scope, step, row.output ?? {});
        return { kind: "ok" };
      case "skipped":
        return { kind: "ok" };
      case "failed":
        return {
          kind: "failed",
          error: row.error ?? "step failed",
          errorClass: row.errorClass ?? "failed",
        };
      case "canceled":
        return { kind: "canceled" };
      default:
        return null;
    }
  }

  // ── leaf steps (tool / infer / agent via the executor registry) ───────────

  private async executeLeaf(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "tool" | "infer" | "agent" }>,
    path: string,
    parent: StepParentFrame | null,
    scope: PipelineScope,
  ): Promise<StepResult> {
    const startMs = this.now().getTime();
    const input = renderLeafInput(step, scope);
    const claim = await this.claim(dctx, step, path, parent, input);
    const row = claim.row;
    let attempt = 1;
    let childRunId: string | undefined;
    if (!claim.created) {
      const adopted = this.adoptTerminal(row, step, scope);
      if (adopted) return adopted;
      if (row.status === "waiting") {
        // Agent step parked on its child when we crashed — re-attach.
        attempt = row.attempt;
        childRunId = row.childRunId ?? undefined;
      } else {
        // running/pending: interrupted mid-attempt. At-least-once retries;
        // `sideEffect: "at_most_once"` fails honest (`interrupted`) instead
        // — the side effect may or may not have happened.
        if (step.kind === "tool" && step.sideEffect === "at_most_once") {
          await this.emitStarted(dctx, step, path, row.attempt);
          return this.finishFailed(
            dctx,
            step,
            path,
            row.id,
            row.attempt,
            "interrupted",
            "interrupted by a control-plane restart mid-execution (sideEffect \"at_most_once\" forbids the retry)",
          );
        }
        attempt = row.attempt + 1;
        childRunId = row.childRunId ?? undefined;
      }
      await this.deps.stepStore.markRunning(row.id, {
        attempt,
        input,
        startedAt: this.now(),
      });
    }
    dctx.executed += 1;
    const budget = Math.max(attemptBudget(step), attempt);

    while (true) {
      if (dctx.handle.interrupted) return { kind: "canceled" };
      if (dctx.handle.cancelRequested) {
        await this.deps.stepStore.finish(row.id, {
          status: "canceled",
          completedAt: this.now(),
        });
        return { kind: "canceled" };
      }
      const remainingMs = dctx.deadlineMs - this.now().getTime();
      if (remainingMs <= 0) {
        return this.finishFailed(
          dctx,
          step,
          path,
          row.id,
          attempt,
          "wall_clock_exceeded",
          `pipeline wall clock exhausted before the step could run`,
        );
      }
      await this.emitStarted(dctx, step, path, attempt, childRunId);
      const outcome = await this.runAttempt(
        dctx,
        step,
        input,
        scope,
        path,
        attempt,
        childRunId,
        remainingMs,
      );
      if (outcome === "interrupted") return { kind: "canceled" };
      if (outcome === "canceled") {
        await this.deps.stepStore.finish(row.id, {
          status: "canceled",
          completedAt: this.now(),
        });
        return { kind: "canceled" };
      }
      if (outcome.status === "waiting") {
        childRunId = outcome.childRunId;
        const parked = await this.parkOnChild(dctx, step, path, row.id, childRunId);
        if (parked === "interrupted") return { kind: "canceled" };
        if (parked === "canceled") {
          await this.deps.stepStore.finish(row.id, {
            status: "canceled",
            completedAt: this.now(),
          });
          return { kind: "canceled" };
        }
        if (parked === "missing") {
          return this.finishFailed(
            dctx,
            step,
            path,
            row.id,
            attempt,
            "child_run_missing",
            "the agent step's child run disappeared while parked",
          );
        }
        await this.deps.stepStore.markRunning(row.id, { attempt });
        continue; // re-invoke with childRunId to extract the child's output
      }
      if (outcome.status === "succeeded") {
        const bytes = serializedByteLength(outcome.output);
        if (bytes === null || bytes > this.config.maxStepOutputBytes) {
          return this.finishFailed(
            dctx,
            step,
            path,
            row.id,
            attempt,
            "output_too_large",
            `step output exceeds ${this.config.maxStepOutputBytes} bytes (or is unserializable)`,
          );
        }
        await this.finishSucceeded(
          dctx,
          step,
          path,
          row.id,
          scope,
          outcome.output,
          startMs,
        );
        return { kind: "ok" };
      }
      // failed
      const willRetry =
        outcome.retryable &&
        attempt < budget &&
        !dctx.handle.cancelRequested &&
        this.now().getTime() < dctx.deadlineMs;
      await dctx.events.emit({
        type: "pipeline.step.failed",
        data: {
          stepId: step.id,
          slug: step.slug,
          kind: step.kind,
          path,
          attempt,
          errorClass: outcome.errorClass,
          error: outcome.error,
          willRetry,
        },
      });
      if (!willRetry) {
        await this.deps.stepStore.finish(row.id, {
          status: "failed",
          error: outcome.error,
          errorClass: outcome.errorClass,
          completedAt: this.now(),
        });
        return {
          kind: "failed",
          error: outcome.error,
          errorClass: outcome.errorClass,
        };
      }
      await this.pause(dctx.handle, backoffDelayMs(attempt, this.random));
      attempt += 1;
      await this.deps.stepStore.markRunning(row.id, { attempt });
    }
  }

  /** One executor attempt under timeout + cancellation. */
  private async runAttempt(
    dctx: DriveCtx,
    step: Extract<PipelineStep, { kind: "tool" | "infer" | "agent" }>,
    input: unknown,
    scope: PipelineScope,
    path: string,
    attempt: number,
    childRunId: string | undefined,
    remainingWallClockMs: number,
  ): Promise<StepOutcome | "canceled" | "interrupted"> {
    const executor: StepExecutor | undefined = this.deps.executors[step.kind];
    if (!executor) {
      return {
        status: "failed",
        errorClass: "executor_unavailable",
        error: `no executor registered for "${step.kind}" steps`,
        retryable: false,
      };
    }
    const handle = dctx.handle;
    const controller = new AbortController();
    handle.activeController = controller;
    const base = stepAttemptTimeoutMs(step);
    const timeoutMs = Math.min(
      base ?? Number.POSITIVE_INFINITY,
      remainingWallClockMs,
    );
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
    const ctx: StepExecuteContext = {
      deps: this.deps.executorDeps,
      orgId: dctx.organizationId,
      run: { id: dctx.run.id, workflowId: dctx.workflowId },
      step,
      input,
      scope,
      signal: controller.signal,
      attempt,
      path,
      ...(childRunId ? { childRunId } : {}),
    };
    try {
      const execPromise: Promise<StepOutcome> = Promise.resolve()
        .then(() => executor(ctx))
        .catch((error): StepOutcome => {
          // A THROW is an executor bug — outcomes are the contract. Log the
          // real error (redaction-safe logger); persist only name+message.
          dctx.logger.error("pipeline.executor_error", {
            err: error,
            fields: { stepId: step.id, path, kind: step.kind },
          });
          return {
            status: "failed",
            errorClass: "executor_error",
            error: safeErrorMessage(error),
            retryable: false,
          };
        });
      const abortPromise = new Promise<"aborted">((resolve) => {
        if (controller.signal.aborted) resolve("aborted");
        else {
          controller.signal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }
      });
      const raced = await Promise.race([execPromise, abortPromise]);
      if (raced === "aborted") {
        // Non-cooperative executor: don't wait for it. The dangling promise
        // must not surface as an unhandled rejection.
        execPromise.catch(() => {});
        if (handle.interrupted) return "interrupted";
        if (handle.cancelRequested) return "canceled";
        return {
          status: "failed",
          errorClass: "timeout",
          error: `step attempt timed out after ${Math.round(timeoutMs)}ms`,
          // Agent-step retries are dispatch-phase only (plan) — a timed-out
          // child turn is not retried; tool/infer timeouts are.
          retryable: step.kind !== "agent",
        };
      }
      if (handle.interrupted) return "interrupted";
      if (handle.cancelRequested && raced.status !== "succeeded") {
        return "canceled";
      }
      void timedOut; // executor beat the abort listener — its outcome wins
      return raced;
    } finally {
      if (timer) clearTimeout(timer);
      handle.activeController = null;
    }
  }

  /**
   * The agent step's child run parked `waiting` — the parent step and run
   * park with it. Wakes on any child bus frame or the poll cadence; returns
   * once the child leaves `waiting` (running again, or terminal), marking
   * the parent run back to `running`.
   */
  private async parkOnChild(
    dctx: DriveCtx,
    step: PipelineStep,
    path: string,
    rowId: string,
    childRunId: string,
  ): Promise<"resumed" | "canceled" | "interrupted" | "missing"> {
    await this.deps.stepStore.markWaiting(rowId, childRunId);
    await dctx.events.emit({
      type: "pipeline.step.waiting",
      data: { stepId: step.id, slug: step.slug, path, childRunId },
    });
    await this.deps.runStore.markRun(dctx.run.id, { status: "waiting" });
    publishRunStatus(this.deps.bus, dctx.run.id, "waiting");
    const handle = dctx.handle;
    try {
      while (true) {
        if (handle.interrupted) return "interrupted";
        if (handle.cancelRequested) return "canceled";
        const status = await this.deps.runStore.getRunStatus(childRunId);
        if (!status) return "missing";
        if (status.status !== "waiting") return "resumed";
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            unsubscribe();
            handle.wake = null;
            resolve();
          };
          const unsubscribe = this.deps.bus.subscribe(childRunId, () => done());
          handle.wake = done;
          void this.sleep(this.config.childPollMs).then(done);
        });
      }
    } finally {
      // Whatever ended the park, the parent is active again from the
      // platform's perspective (terminal transitions overwrite this later).
      const resumed = await this.deps.runStore.markRun(dctx.run.id, {
        status: "running",
      });
      if (resumed) publishRunStatus(this.deps.bus, dctx.run.id, "running");
    }
  }
}

/** Construct the runner (index.ts wiring; tests inject the seams). */
export function createPipelineRunner(deps: PipelineRunnerDeps): PipelineRunner {
  return new PipelineRunner(deps);
}

/**
 * Decreed dispatch entry: trigger ingress, the schedule ticker, Slack
 * routing and manual "Run now" all funnel here.
 */
export function startPipelineRun(
  runner: PipelineRunner,
  input: StartPipelineRunInput,
): Promise<StartPipelineRunResult> {
  return runner.start(input);
}

/**
 * Decreed cancel entry for the routes layer. False ⇒ no live driver in this
 * process (orphaned run) — the caller falls back to a direct status CAS and
 * lets boot recovery reconcile the ledger.
 */
export function cancelPipelineRun(
  runner: PipelineRunner,
  runId: string,
): boolean {
  return runner.cancel(runId);
}

function renderLeafInput(
  step: Extract<PipelineStep, { kind: "tool" | "infer" | "agent" }>,
  scope: PipelineScope,
): unknown {
  // DECREED shapes — each executor validates its own
  // (`toolStepRenderedInputSchema` / `inferStepRenderedInputSchema`; the
  // agent step mirrors them with `{ instructions }`).
  switch (step.kind) {
    case "tool":
      return { args: renderTemplateRecord(step.args, scope) };
    case "infer":
      return { prompt: renderMarkdownTemplate(step.prompt.markdown, scope) };
    case "agent":
      return {
        instructions: renderMarkdownTemplate(step.instructions.markdown, scope),
      };
  }
}

function readBranchLane(
  output: Record<string, unknown> | null,
  step: Extract<PipelineStep, { kind: "branch" }>,
): number | "else" | null {
  const lane = output?.["lane"];
  if (typeof lane === "number" && step.branches[lane] !== undefined) return lane;
  if (lane === "else" && step.else) return "else";
  return null;
}
