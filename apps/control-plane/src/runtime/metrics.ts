/**
 * Fleet metrics (docs/PLAN.md Phase 3 task 5): `GET /internal/metrics`.
 *
 * Two halves:
 * - {@link MetricsRegistry} — in-process counters/gauges the hot paths poke:
 *   per-trigger-type counts (dispatch), run-duration histogram (tailer on run
 *   finish), and build-cache hits/misses (publish). No Prometheus dependency;
 *   plain in-memory counters. Reset only on process restart (documented).
 * - {@link collectMetrics} — folds the registry with a DB read
 *   ({@link MetricsDbReader}: scheduler queue depth, active runs, runs-by-status,
 *   active sessions, per-worker utilization across the fleet) into the shared
 *   {@link InternalMetricsResponse} contract.
 *
 * Exposition: JSON by default (the contract), or a minimal Prometheus-style
 * text format with `?format=text` (documented in {@link renderMetricsText}).
 *
 * The endpoint is worker-plane-guarded (the same timing-safe `x-worker-secret`
 * shared secret that fronts every other `/internal/*` surface) — it is NEVER
 * public: it enumerates the whole fleet and its backlog.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { count, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  buildCacheHitRate,
  computeUtilization,
  emptyRunDurationHistogram,
  emptyRunsByStatus,
  emptyTriggerCounts,
  recordRunDuration as recordRunDurationPure,
  type ApiErrorBody,
  type BuildCacheStats,
  type InternalMetricsResponse,
  type RunDurationHistogram,
  type RunStatus,
  type TriggerCounts,
  type WorkerUtilizationDto,
} from "@invisible-string/shared";

import type { Db } from "../db";

/** Outcome bucket a trigger observation lands in. */
export type TriggerOutcome = keyof TriggerCounts; // "received" | "dispatched" | "failed"

/**
 * Process-lifetime counters/gauges. All mutations are cheap and synchronous;
 * the histogram is stored as the immutable shared value and replaced on record.
 */
export class MetricsRegistry {
  private runDurationHistogram = emptyRunDurationHistogram();
  private readonly triggers = new Map<string, TriggerCounts>();
  private cacheHits = 0;
  private cacheMisses = 0;

  /** One trigger observation, keyed by type (manual|form|webhook|slack|…). */
  recordTrigger(triggerType: string, outcome: TriggerOutcome): void {
    const current = this.triggers.get(triggerType) ?? emptyTriggerCounts();
    this.triggers.set(triggerType, { ...current, [outcome]: current[outcome] + 1 });
  }

  /** One completed-run wall-clock observation (ms). NaN is ignored (see shared). */
  recordRunDuration(ms: number): void {
    this.runDurationHistogram = recordRunDurationPure(this.runDurationHistogram, ms);
  }

  /** One build outcome: cache hit (skipped `eve build`) or miss (fresh build). */
  recordBuildCache(hit: boolean): void {
    if (hit) this.cacheHits += 1;
    else this.cacheMisses += 1;
  }

  runDuration(): RunDurationHistogram {
    return this.runDurationHistogram;
  }

  triggerCounts(): Record<string, TriggerCounts> {
    return Object.fromEntries(
      [...this.triggers.entries()].map(([type, counts]) => [type, { ...counts }]),
    );
  }

  buildCache(): BuildCacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: buildCacheHitRate(this.cacheHits, this.cacheMisses),
    };
  }
}

// ── DB-derived portion ───────────────────────────────────────────────────────

/** One worker row the metrics view needs (subset of `workers`). */
export interface MetricsWorkerRow {
  id: string;
  status: "live" | "draining" | "dead";
  capacity: Record<string, unknown>;
  lastHeartbeatAt: Date;
}

/**
 * The DB reads the metrics snapshot needs. Interface-first so the collector
 * unit-tests against a fake (no live Postgres); the drizzle impl is production.
 */
export interface MetricsDbReader {
  runsByStatus(): Promise<Record<RunStatus, number>>;
  activeSessions(): Promise<number>;
  workers(): Promise<MetricsWorkerRow[]>;
}

export function createDrizzleMetricsReader(db: Db): MetricsDbReader {
  return {
    async runsByStatus() {
      const rows = await db
        .select({ status: schema.runs.status, value: count() })
        .from(schema.runs)
        .groupBy(schema.runs.status);
      const out = emptyRunsByStatus();
      for (const row of rows) out[row.status] = row.value;
      return out;
    },
    async activeSessions() {
      const rows = await db
        .select({ value: count() })
        .from(schema.agentSessions)
        .where(inArray(schema.agentSessions.status, ["active", "waiting"]));
      return rows[0]?.value ?? 0;
    },
    async workers() {
      // Fleet utilization excludes deregistered (dead) workers.
      const rows = await db
        .select({
          id: schema.workers.id,
          status: schema.workers.status,
          capacity: schema.workers.capacity,
          lastHeartbeatAt: schema.workers.lastHeartbeatAt,
        })
        .from(schema.workers)
        .where(inArray(schema.workers.status, ["live", "draining"]));
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        capacity: row.capacity,
        lastHeartbeatAt: row.lastHeartbeatAt,
      }));
    },
  };
}

function intField(capacity: Record<string, unknown>, key: string): number {
  const value = capacity[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function workerDto(row: MetricsWorkerRow): WorkerUtilizationDto {
  const maxAgents = intField(row.capacity, "maxAgents");
  const runningAgents = intField(row.capacity, "runningAgents");
  const activeRequests = intField(row.capacity, "activeRequests");
  return {
    workerId: row.id,
    status: row.status,
    maxAgents,
    runningAgents,
    activeRequests,
    utilization: computeUtilization(runningAgents, maxAgents),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
  };
}

/** Fold the registry + a DB read into the shared metrics contract. */
export async function collectMetrics(opts: {
  registry: MetricsRegistry;
  reader: MetricsDbReader;
  now?: Date;
}): Promise<InternalMetricsResponse> {
  const { registry, reader } = opts;
  const now = opts.now ?? new Date();
  const [runsByStatus, activeSessions, workerRows] = await Promise.all([
    reader.runsByStatus(),
    reader.activeSessions(),
    reader.workers(),
  ]);
  return {
    generatedAt: now.toISOString(),
    queueDepth: runsByStatus.queued,
    activeRuns: runsByStatus.running,
    runsByStatus,
    activeSessions,
    runDuration: registry.runDuration(),
    workers: workerRows.map(workerDto),
    triggers: registry.triggerCounts(),
    buildCache: registry.buildCache(),
  };
}

// ── Text exposition ──────────────────────────────────────────────────────────

/**
 * Minimal Prometheus-style text exposition (`?format=text`). One metric per
 * line, `metric_name{labels} value`. Not a full OpenMetrics document (no HELP/
 * TYPE preamble) — enough for a scrape or an eyeball. The JSON body is the
 * authoritative contract; this is a convenience.
 */
export function renderMetricsText(snapshot: InternalMetricsResponse): string {
  const lines: string[] = [];
  lines.push(`is_scheduler_queue_depth ${snapshot.queueDepth}`);
  lines.push(`is_active_runs ${snapshot.activeRuns}`);
  lines.push(`is_active_sessions ${snapshot.activeSessions}`);
  for (const [status, value] of Object.entries(snapshot.runsByStatus)) {
    lines.push(`is_runs_total{status="${status}"} ${value}`);
  }
  const h = snapshot.runDuration;
  let cumulative = 0;
  for (let i = 0; i < h.boundariesMs.length; i += 1) {
    cumulative += h.counts[i] ?? 0;
    lines.push(`is_run_duration_ms_bucket{le="${h.boundariesMs[i]}"} ${cumulative}`);
  }
  cumulative += h.counts[h.boundariesMs.length] ?? 0;
  lines.push(`is_run_duration_ms_bucket{le="+Inf"} ${cumulative}`);
  lines.push(`is_run_duration_ms_sum ${h.sumMs}`);
  lines.push(`is_run_duration_ms_count ${h.count}`);
  for (const [type, counts] of Object.entries(snapshot.triggers)) {
    lines.push(`is_triggers_total{type="${type}",outcome="received"} ${counts.received}`);
    lines.push(`is_triggers_total{type="${type}",outcome="dispatched"} ${counts.dispatched}`);
    lines.push(`is_triggers_total{type="${type}",outcome="failed"} ${counts.failed}`);
  }
  lines.push(`is_build_cache_hits_total ${snapshot.buildCache.hits}`);
  lines.push(`is_build_cache_misses_total ${snapshot.buildCache.misses}`);
  lines.push(`is_build_cache_hit_rate ${snapshot.buildCache.hitRate}`);
  for (const w of snapshot.workers) {
    const labels = `worker="${w.workerId}",status="${w.status}"`;
    lines.push(`is_worker_running_agents{${labels}} ${w.runningAgents}`);
    lines.push(`is_worker_max_agents{${labels}} ${w.maxAgents}`);
    lines.push(`is_worker_active_requests{${labels}} ${w.activeRequests}`);
    lines.push(`is_worker_utilization{${labels}} ${w.utilization}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── The guarded route ────────────────────────────────────────────────────────

function secretsEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export interface MetricsPluginDeps {
  registry: MetricsRegistry;
  reader: MetricsDbReader;
  /** Shared secret gating the endpoint (`x-worker-secret`, timing-safe). */
  workerSharedSecret: string;
  /** Injected clock for tests. */
  now?: () => Date;
}

export function metricsPlugin(deps: MetricsPluginDeps) {
  return new Elysia({ name: "internal-metrics" }).get(
    "/internal/metrics",
    async ({ request, query, set }) => {
      const provided = request.headers.get("x-worker-secret");
      if (provided === null || !secretsEqual(provided, deps.workerSharedSecret)) {
        set.status = 401;
        return errorBody("unauthorized", "missing or invalid x-worker-secret header");
      }
      const snapshot = await collectMetrics({
        registry: deps.registry,
        reader: deps.reader,
        now: deps.now?.(),
      });
      const wantsText =
        query.format === "text" ||
        (request.headers.get("accept") ?? "").includes("text/plain");
      if (wantsText) {
        set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
        return renderMetricsText(snapshot);
      }
      return snapshot;
    },
  );
}
