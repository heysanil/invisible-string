/**
 * Step-ledger + workflow-state persistence consumed by the pipeline driver.
 * Interface-first so the driver unit-tests against in-memory fakes (the
 * RunStore pattern, runs/store.ts); the drizzle implementations are the
 * production path.
 *
 * The load-bearing operation is {@link RunStepStore.claim}: an INSERT racing
 * on the unique `(run_id, path)` index. `created: false` hands back the row a
 * previous incarnation of this run already wrote — crash recovery's
 * idempotent replay key. A rebooted driver walks the config from the top,
 * ADOPTS every row claim returns (terminal output → scope, no re-execution)
 * and only truly executes at the frontier.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import { newId, type RunStepKind } from "@invisible-string/shared";

import type { Db } from "../db";

/** One `run_steps` row (drizzle select shape — the schema is the contract). */
export type RunStepRow = typeof schema.runSteps.$inferSelect;

export type RunStepStatus = RunStepRow["status"];

/** `rs_` — run-step ledger ids (house nanoid convention). */
export const RUN_STEP_ID_PREFIX = "rs";

export interface ClaimStepInput {
  runId: string;
  organizationId: string;
  stepId: string;
  stepSlug: string;
  path: string;
  parentPath: string | null;
  iteration: number | null;
  kind: RunStepKind;
  /**
   * Initial status: "running" for a real execution claim, "skipped" for the
   * rows a top-level filter writes for the steps it fences off.
   */
  status: "running" | "skipped";
  /** Rendered input snapshot (refs resolved — structurally secret-free). */
  input: unknown;
  startedAt: Date;
  /** Set for "skipped" claims (they are born terminal). */
  completedAt?: Date;
}

export interface FinishStepPatch {
  status: "succeeded" | "failed" | "skipped" | "canceled";
  output?: Record<string, unknown>;
  error?: string;
  errorClass?: string;
  completedAt: Date;
}

export interface RunStepStore {
  /**
   * Idempotent instance claim on unique `(run_id, path)`: inserts and returns
   * `created: true`, or returns the existing row with `created: false` for
   * the driver's adopt-or-resume decision.
   */
  claim(input: ClaimStepInput): Promise<{ created: boolean; row: RunStepRow }>;
  /**
   * (Re)mark an instance running: retry bumps `attempt`, crash-resume also
   * refreshes the re-rendered `input` and `startedAt`.
   */
  markRunning(
    id: string,
    patch: { attempt: number; input?: unknown; startedAt?: Date },
  ): Promise<void>;
  /** Terminal transition. Output is capped by the DRIVER before it gets here. */
  finish(id: string, patch: FinishStepPatch): Promise<void>;
  /** Agent step parked on a parked child run. */
  markWaiting(id: string, childRunId: string): Promise<void>;
  /** The run's whole ledger (stable order) — recovery + the steps routes read it. */
  listForRun(runId: string): Promise<RunStepRow[]>;
}

export function createDrizzleRunStepStore(db: Db): RunStepStore {
  return {
    async claim(input) {
      const inserted = await db
        .insert(schema.runSteps)
        .values({
          id: newId(RUN_STEP_ID_PREFIX),
          runId: input.runId,
          organizationId: input.organizationId,
          stepId: input.stepId,
          stepSlug: input.stepSlug,
          path: input.path,
          parentPath: input.parentPath,
          iteration: input.iteration,
          kind: input.kind,
          status: input.status,
          attempt: 1,
          input: input.input,
          startedAt: input.startedAt,
          completedAt: input.completedAt ?? null,
        })
        .onConflictDoNothing({
          target: [schema.runSteps.runId, schema.runSteps.path],
        })
        .returning();
      const created = inserted[0];
      if (created) return { created: true, row: created };
      const existing = await db
        .select()
        .from(schema.runSteps)
        .where(
          and(
            eq(schema.runSteps.runId, input.runId),
            eq(schema.runSteps.path, input.path),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (!row) {
        // The claim lost the insert race yet the winner's row is gone — only
        // a concurrent run delete does this; surface it as a hard error.
        throw new Error(
          `run_steps claim for ${input.runId} ${input.path} found neither insert nor row`,
        );
      }
      return { created: false, row };
    },

    async markRunning(id, patch) {
      await db
        .update(schema.runSteps)
        .set({
          status: "running",
          attempt: patch.attempt,
          ...(patch.input !== undefined ? { input: patch.input } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        })
        .where(eq(schema.runSteps.id, id));
    },

    async finish(id, patch) {
      await db
        .update(schema.runSteps)
        .set({
          status: patch.status,
          ...(patch.output !== undefined ? { output: patch.output } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.errorClass !== undefined
            ? { errorClass: patch.errorClass }
            : {}),
          completedAt: patch.completedAt,
        })
        .where(eq(schema.runSteps.id, id));
    },

    async markWaiting(id, childRunId) {
      await db
        .update(schema.runSteps)
        .set({ status: "waiting", childRunId })
        .where(eq(schema.runSteps.id, id));
    },

    async listForRun(runId) {
      return db
        .select()
        .from(schema.runSteps)
        .where(eq(schema.runSteps.runId, runId))
        .orderBy(asc(schema.runSteps.createdAt), asc(schema.runSteps.path));
    },
  };
}

// ── Workflow state ──────────────────────────────────────────────────────────

/** App-enforced cap: keys per workflow (the DB stores whatever fits). */
export const WORKFLOW_STATE_MAX_KEYS = 200;

/** App-enforced cap: serialized bytes per value. */
export const WORKFLOW_STATE_MAX_VALUE_BYTES = 64 * 1024;

export interface WorkflowStateWrite {
  workflowId: string;
  organizationId: string;
  /** Provenance — lands on `updated_by_run_id`. */
  runId: string;
  entries: Record<string, unknown>;
}

/**
 * Durable per-workflow key-value state (cursors, dedupe). The driver
 * snapshots it once at run start (`@state.*` resolves against the snapshot)
 * and writes through it on every `state` step — writes are visible to LATER
 * steps of this run and to the next run, last write wins via the PK.
 */
export interface WorkflowStateStore {
  snapshot(workflowId: string): Promise<Record<string, unknown>>;
  countKeys(workflowId: string): Promise<number>;
  set(write: WorkflowStateWrite): Promise<void>;
}

export function createDrizzleWorkflowStateStore(db: Db): WorkflowStateStore {
  return {
    async snapshot(workflowId) {
      const rows = await db
        .select({
          key: schema.workflowState.key,
          // Read as JSON TEXT and parse once ourselves: drizzle's jsonb
          // mapper re-parses any STRING the driver hands back, and
          // postgres-js has already parsed the jsonb — so a bare-string
          // value ('"2.0"') double-parses into the number 2. Objects are
          // immune, bare scalars (cursors!) are not.
          value: sql<string>`${schema.workflowState.value}::text`,
        })
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, workflowId));
      const state: Record<string, unknown> = {};
      for (const row of rows) state[row.key] = JSON.parse(row.value) as unknown;
      return state;
    },

    async countKeys(workflowId) {
      const rows = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.workflowState)
        .where(eq(schema.workflowState.workflowId, workflowId));
      return rows[0]?.value ?? 0;
    },

    async set(write) {
      for (const [key, value] of Object.entries(write.entries)) {
        if (value === undefined) continue;
        // Bind the value as explicit JSON text: state values are often BARE
        // scalars (a cursor string like "173.002"), and drizzle+postgres-js
        // pass a bare string through to a `::jsonb` cast, which re-parses it
        // as JSON — "2.0" comes back as the NUMBER 2, and a non-JSON string
        // fails the insert outright. Objects never hit this, which is why no
        // other jsonb column in the repo needs the guard.
        const jsonText = JSON.stringify(value);
        const boundValue = sql`${jsonText}::jsonb`;
        await db
          .insert(schema.workflowState)
          .values({
            workflowId: write.workflowId,
            key,
            value: boundValue,
            updatedByRunId: write.runId,
            organizationId: write.organizationId,
          })
          .onConflictDoUpdate({
            target: [schema.workflowState.workflowId, schema.workflowState.key],
            set: {
              value: boundValue,
              updatedByRunId: write.runId,
              updatedAt: new Date(),
            },
          });
      }
    },
  };
}

// ── In-memory fakes (unit tests + executable spec of the semantics) ─────────

export interface MemoryRunStepStore extends RunStepStore {
  rows: RunStepRow[];
}

/**
 * Reference implementation of {@link RunStepStore} — same claim/transition
 * semantics as the drizzle store, no DB. The driver's unit suites run
 * entirely against this (the tailer's memoryStore precedent).
 */
export function createMemoryRunStepStore(): MemoryRunStepStore {
  const rows: RunStepRow[] = [];
  const byId = (id: string): RunStepRow => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no run_steps row ${id}`);
    return row;
  };
  return {
    rows,
    async claim(input) {
      const existing = rows.find(
        (r) => r.runId === input.runId && r.path === input.path,
      );
      if (existing) return { created: false, row: existing };
      const row: RunStepRow = {
        id: newId(RUN_STEP_ID_PREFIX),
        runId: input.runId,
        organizationId: input.organizationId,
        stepId: input.stepId,
        stepSlug: input.stepSlug,
        path: input.path,
        parentPath: input.parentPath,
        iteration: input.iteration,
        kind: input.kind,
        status: input.status,
        attempt: 1,
        input: input.input,
        output: null,
        error: null,
        errorClass: null,
        childRunId: null,
        startedAt: input.startedAt,
        completedAt: input.completedAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return { created: true, row };
    },
    async markRunning(id, patch) {
      const row = byId(id);
      row.status = "running";
      row.attempt = patch.attempt;
      if (patch.input !== undefined) row.input = patch.input;
      if (patch.startedAt !== undefined) row.startedAt = patch.startedAt;
    },
    async finish(id, patch) {
      const row = byId(id);
      row.status = patch.status;
      if (patch.output !== undefined) row.output = patch.output;
      if (patch.error !== undefined) row.error = patch.error;
      if (patch.errorClass !== undefined) row.errorClass = patch.errorClass;
      row.completedAt = patch.completedAt;
    },
    async markWaiting(id, childRunId) {
      const row = byId(id);
      row.status = "waiting";
      row.childRunId = childRunId;
    },
    async listForRun(runId) {
      return rows.filter((r) => r.runId === runId);
    },
  };
}

export interface MemoryWorkflowStateStore extends WorkflowStateStore {
  state: Map<string, Map<string, unknown>>;
}

/** In-memory {@link WorkflowStateStore} for the driver's unit suites. */
export function createMemoryWorkflowStateStore(): MemoryWorkflowStateStore {
  const state = new Map<string, Map<string, unknown>>();
  const forWorkflow = (workflowId: string): Map<string, unknown> => {
    let map = state.get(workflowId);
    if (!map) {
      map = new Map();
      state.set(workflowId, map);
    }
    return map;
  };
  return {
    state,
    async snapshot(workflowId) {
      return Object.fromEntries(forWorkflow(workflowId));
    },
    async countKeys(workflowId) {
      return forWorkflow(workflowId).size;
    },
    async set(write) {
      const map = forWorkflow(write.workflowId);
      for (const [key, value] of Object.entries(write.entries)) {
        map.set(key, value);
      }
    },
  };
}
