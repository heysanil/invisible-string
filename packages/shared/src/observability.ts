/**
 * Observability contract (docs/PLAN.md Phase 3 task 5; INITIAL-SPEC.md §13
 * cross-cutting "observability"). Two shapes both planes agree on:
 *
 * 1. {@link StructuredLogEvent} — one structured log line carrying the
 *    correlation ids that thread a request across control plane ⇄ worker ⇄
 *    agent: workspace / workflow / (version) / session / run / worker. Emitted
 *    as JSON; a log pipeline can pivot on any id. SECRETS DISCIPLINE: `fields`
 *    is for redaction-safe structured context only — never provider keys, MCP
 *    tokens, JWT secrets, or raw trigger payloads (INITIAL-SPEC.md §11 "never
 *    log plaintext"). Compiled agents must not receive this type; it is
 *    platform-plane only.
 *
 * 2. {@link InternalMetricsResponse} — the body of `GET /internal/metrics`
 *    (shared-secret guarded, never public): scheduler queue depth, a run
 *    duration histogram, per-worker utilization, and per-trigger counts.
 */
import { z } from "zod";

import { runStatusSchema, type RunStatus } from "./api";

// ── Structured logs ──────────────────────────────────────────────────────────

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Stable event slugs the platform emits. Open union: unknown slugs stay valid
 * (`string`), but these keep autocomplete and document the taxonomy. Grouped
 * `<area>.<verb>` so a pipeline can filter by prefix.
 */
export const KNOWN_LOG_EVENTS = [
  // dispatch / ingress
  "trigger.received",
  "trigger.rejected",
  "dispatch.started",
  "dispatch.delivered",
  "dispatch.failed",
  // runs
  "run.created",
  "run.started",
  "run.waiting",
  "run.succeeded",
  "run.failed",
  "run.canceled",
  // sessions
  "session.created",
  "session.continued",
  // scheduler / workers
  "scheduler.assigned",
  "scheduler.no_worker",
  "worker.registered",
  "worker.heartbeat",
  "worker.deregistered",
  "worker.unreachable",
  // builds
  "build.started",
  "build.succeeded",
  "build.failed",
] as const;

export type KnownLogEvent = (typeof KNOWN_LOG_EVENTS)[number];
/** Open union: known slugs autocomplete, novel slugs stay valid. */
export type LogEventName = KnownLogEvent | (string & {});

/** JSON-safe structured field values (no secrets — see module doc). */
export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | LogFieldValue[]
  | { [key: string]: LogFieldValue };

const logFieldValueSchema: z.ZodType<LogFieldValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(logFieldValueSchema),
    z.record(z.string(), logFieldValueSchema),
  ]),
);

/**
 * The correlation ids. Every field is optional — a worker-registration log has
 * only `workerId`; a run log carries the full chain. Emitters SHOULD include
 * every id they know so cross-plane joins work.
 */
export const logCorrelationSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  workflowVersionId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
});
export type LogCorrelation = z.infer<typeof logCorrelationSchema>;

export const structuredLogEventSchema = logCorrelationSchema.extend({
  /** ISO-8601 emission time. */
  at: z.string().min(1),
  level: logLevelSchema,
  /** Stable slug — see {@link KNOWN_LOG_EVENTS}. */
  event: z.string().min(1),
  /** Optional human-readable one-liner. */
  msg: z.string().optional(),
  /** Redaction-safe structured context (NO secrets). */
  fields: z.record(z.string(), logFieldValueSchema).optional(),
});
export type StructuredLogEvent = z.infer<typeof structuredLogEventSchema>;

export interface MakeLogEventInput extends LogCorrelation {
  level: LogLevel;
  event: LogEventName;
  msg?: string;
  fields?: Record<string, LogFieldValue>;
  /** Emission time; injected for tests. Defaults to `new Date()`. */
  at?: Date;
}

/**
 * Assemble a {@link StructuredLogEvent}, dropping undefined correlation ids so
 * the emitted JSON stays sparse. Pure given `at`. Does NOT scrub secrets — the
 * caller owns what goes into `fields` (see module doc).
 */
export function makeLogEvent(input: MakeLogEventInput): StructuredLogEvent {
  const {
    level,
    event,
    msg,
    fields,
    at,
    workspaceId,
    workflowId,
    workflowVersionId,
    sessionId,
    runId,
    workerId,
  } = input;
  const base: StructuredLogEvent = {
    at: (at ?? new Date()).toISOString(),
    level,
    event,
  };
  if (msg !== undefined) base.msg = msg;
  if (workspaceId !== undefined) base.workspaceId = workspaceId;
  if (workflowId !== undefined) base.workflowId = workflowId;
  if (workflowVersionId !== undefined) base.workflowVersionId = workflowVersionId;
  if (sessionId !== undefined) base.sessionId = sessionId;
  if (runId !== undefined) base.runId = runId;
  if (workerId !== undefined) base.workerId = workerId;
  if (fields !== undefined && Object.keys(fields).length > 0) base.fields = fields;
  return base;
}

// ── Metrics (GET /internal/metrics) ──────────────────────────────────────────

/**
 * Upper-bound edges (ms) of the run-duration histogram, ascending. Bucket `i`
 * counts runs with `boundaries[i-1] < d <= boundaries[i]`; the final overflow
 * bucket (index === boundaries.length) counts `d > last boundary`. So a
 * histogram has `boundaries.length + 1` counts.
 */
export const RUN_DURATION_BUCKET_BOUNDARIES_MS = [
  100, 500, 1_000, 5_000, 15_000, 60_000, 300_000, 600_000,
] as const;

export const runDurationHistogramSchema = z.object({
  /** Bucket upper-bound edges in ms (matches {@link RUN_DURATION_BUCKET_BOUNDARIES_MS}). */
  boundariesMs: z.array(z.number().positive()),
  /** Per-bucket counts; length === boundariesMs.length + 1 (overflow bucket). */
  counts: z.array(z.number().int().nonnegative()),
  /** Sum of all observed durations (ms) — enables average = sum / count. */
  sumMs: z.number().nonnegative(),
  /** Total observations. */
  count: z.number().int().nonnegative(),
});
export type RunDurationHistogram = z.infer<typeof runDurationHistogramSchema>;

/** A zeroed histogram over {@link RUN_DURATION_BUCKET_BOUNDARIES_MS}. Pure. */
export function emptyRunDurationHistogram(): RunDurationHistogram {
  const boundariesMs = [...RUN_DURATION_BUCKET_BOUNDARIES_MS];
  return {
    boundariesMs,
    counts: new Array(boundariesMs.length + 1).fill(0),
    sumMs: 0,
    count: 0,
  };
}

/**
 * Index of the bucket a duration falls in. Negative/zero clamp to bucket 0;
 * durations past the last edge land in the overflow bucket. Pure.
 */
export function bucketIndexForDuration(
  ms: number,
  boundariesMs: readonly number[] = RUN_DURATION_BUCKET_BOUNDARIES_MS,
): number {
  for (let i = 0; i < boundariesMs.length; i += 1) {
    if (ms <= boundariesMs[i]!) return i;
  }
  return boundariesMs.length;
}

/**
 * Return a NEW histogram with one duration recorded (immutable update). Pure.
 * NaN durations are ignored (returns the input unchanged).
 */
export function recordRunDuration(
  histogram: RunDurationHistogram,
  ms: number,
): RunDurationHistogram {
  if (Number.isNaN(ms)) return histogram;
  const idx = bucketIndexForDuration(ms, histogram.boundariesMs);
  const counts = histogram.counts.slice();
  counts[idx] = (counts[idx] ?? 0) + 1;
  return {
    boundariesMs: histogram.boundariesMs,
    counts,
    sumMs: histogram.sumMs + Math.max(0, ms),
    count: histogram.count + 1,
  };
}

/** Per-worker utilization snapshot. `utilization` = runningAgents / maxAgents. */
export const workerUtilizationDtoSchema = z.object({
  workerId: z.string().min(1),
  status: z.enum(["live", "draining", "dead"]),
  maxAgents: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
  activeRequests: z.number().int().nonnegative(),
  /** 0..1; 0 when maxAgents is 0. */
  utilization: z.number().min(0).max(1),
  lastHeartbeatAt: z.string().min(1),
});
export type WorkerUtilizationDto = z.infer<typeof workerUtilizationDtoSchema>;

/** Compute `utilization` safely (0 when capacity is 0). Pure. */
export function computeUtilization(
  runningAgents: number,
  maxAgents: number,
): number {
  if (maxAgents <= 0) return 0;
  return Math.min(1, Math.max(0, runningAgents / maxAgents));
}

/** Counts for one trigger type, split by ingress outcome. */
export const triggerCountsSchema = z.object({
  received: z.number().int().nonnegative(),
  dispatched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type TriggerCounts = z.infer<typeof triggerCountsSchema>;

/** Body of `GET /internal/metrics`. */
export const internalMetricsResponseSchema = z.object({
  /** ISO-8601 time the snapshot was computed. */
  generatedAt: z.string().min(1),
  /** Runs queued but not yet dispatched (scheduler backlog). */
  queueDepth: z.number().int().nonnegative(),
  /** Runs currently in-flight (status running). */
  activeRuns: z.number().int().nonnegative(),
  /** Run counts by status (mirrors run_status). */
  runsByStatus: z.record(runStatusSchema, z.number().int().nonnegative()),
  runDuration: runDurationHistogramSchema,
  workers: z.array(workerUtilizationDtoSchema),
  /** Keyed by trigger type ("manual" | "form" | "webhook" | "slack" | …). */
  triggers: z.record(z.string(), triggerCountsSchema),
});
export type InternalMetricsResponse = z.infer<
  typeof internalMetricsResponseSchema
>;

/** Convenience: a zeroed run-status tally for every known status. Pure. */
export function emptyRunsByStatus(): Record<RunStatus, number> {
  return {
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
  };
}
