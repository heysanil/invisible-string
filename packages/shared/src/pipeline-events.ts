/**
 * Pipeline run-stream events (`pipeline.*`) — the step-lifecycle vocabulary
 * the runner appends into the parent run's `run_events` BESIDE eve events,
 * under the same monotonic `seq`. SSE resume (Last-Event-ID) therefore
 * carries step timelines with zero transport changes; the SPA's
 * `run-progress` reducer is the primary consumer.
 *
 * Every type is prefixed `pipeline.` so nothing collides with eve's own
 * `step.*` vocabulary in a mixed stream, and consumers MUST default-ignore
 * unknown event types (old bundles meeting new events, and vice versa).
 *
 * Shapes are plain interfaces like eve-events.ts — run_events rows are
 * trusted platform writes, not re-parsed. Two content rules the PRODUCERS
 * own: `outputPreview` is capped at
 * {@link PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES} (use
 * {@link buildStepOutputPreview}), and `pipeline.state.updated` carries KEYS
 * ONLY — state values never enter the event stream. `error` strings must be
 * scrubbed (probe `scrubSecrets` discipline) before they reach an event.
 */
import type { RunStepKind } from "./pipeline-config";

/** The run's pipeline started interpreting. */
export interface PipelineStartedEvent {
  readonly type: "pipeline.started";
  readonly data: {
    /** Declared TOP-LEVEL step count (for_each expansion is dynamic). */
    readonly stepCount: number;
  };
}

/** One step INSTANCE began an attempt. */
export interface PipelineStepStartedEvent {
  readonly type: "pipeline.step.started";
  readonly data: {
    readonly stepId: string;
    readonly slug: string;
    readonly kind: RunStepKind;
    /** Instance path, e.g. "st_loop/3/st_b" — unique per (run, instance). */
    readonly path: string;
    /** 1-based attempt counter (retries re-emit with the next attempt). */
    readonly attempt: number;
    /** The child run an agent step re-attached to, when already known. */
    readonly childRunId?: string;
  };
}

/** One step instance reached a terminal non-failure status. */
export interface PipelineStepCompletedEvent {
  readonly type: "pipeline.step.completed";
  readonly data: {
    readonly stepId: string;
    readonly slug: string;
    readonly kind: RunStepKind;
    readonly path: string;
    readonly status: "succeeded" | "skipped";
    readonly durationMs: number;
    /** Capped JSON preview of the output (may be cut mid-token). */
    readonly outputPreview?: string;
  };
}

/** One attempt failed. Terminal for the step only when `willRetry` is false. */
export interface PipelineStepFailedEvent {
  readonly type: "pipeline.step.failed";
  readonly data: {
    readonly stepId: string;
    readonly slug: string;
    readonly kind: RunStepKind;
    readonly path: string;
    readonly attempt: number;
    /** Stable classification (e.g. "tool_error", "unreachable", "validation_failed"). */
    readonly errorClass: string;
    /** Human-readable message — SCRUBBED by the producer, never raw. */
    readonly error: string;
    readonly willRetry: boolean;
  };
}

/** An agent step's child run parked `waiting`; the parent run parks with it. */
export interface PipelineStepWaitingEvent {
  readonly type: "pipeline.step.waiting";
  readonly data: {
    readonly stepId: string;
    readonly slug: string;
    readonly path: string;
    /** Where `POST /runs/:id/input` resumes the pipeline. */
    readonly childRunId: string;
  };
}

/** A state step wrote. KEYS ONLY — values never ride the event stream. */
export interface PipelineStateUpdatedEvent {
  readonly type: "pipeline.state.updated";
  readonly data: {
    readonly stepId: string;
    readonly path: string;
    readonly keys: string[];
  };
}

/** The pipeline finished. The run_status frame stays the status authority. */
export interface PipelineCompletedEvent {
  readonly type: "pipeline.completed";
  readonly data: {
    readonly status: "succeeded" | "failed" | "canceled";
    readonly durationMs: number;
  };
}

/** The full pipeline event union carried in `run_events` beside eve events. */
export type PipelineStreamEvent =
  | PipelineStartedEvent
  | PipelineStepStartedEvent
  | PipelineStepCompletedEvent
  | PipelineStepFailedEvent
  | PipelineStepWaitingEvent
  | PipelineStateUpdatedEvent
  | PipelineCompletedEvent;

export type PipelineStreamEventType = PipelineStreamEvent["type"];

export const PIPELINE_STREAM_EVENT_TYPES = [
  "pipeline.started",
  "pipeline.step.started",
  "pipeline.step.completed",
  "pipeline.step.failed",
  "pipeline.step.waiting",
  "pipeline.state.updated",
  "pipeline.completed",
] as const satisfies readonly PipelineStreamEventType[];

const PIPELINE_STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  PIPELINE_STREAM_EVENT_TYPES,
);

/** Narrow a mixed run-stream event to the pipeline vocabulary. */
export function isPipelineStreamEvent(event: {
  readonly type: string;
}): event is PipelineStreamEvent {
  return PIPELINE_STREAM_EVENT_TYPE_SET.has(event.type);
}

/** Byte cap on `pipeline.step.completed`'s `outputPreview` (UTF-8). */
export const PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES = 2048;

/**
 * JSON-preview a step output for `outputPreview`, truncated to the byte cap
 * on a UTF-8 boundary. Returns undefined for values with no JSON projection
 * (undefined, circular structures) — the event then simply omits the field.
 * A truncated preview is NOT valid JSON; it is for humans and step cards.
 */
export function buildStepOutputPreview(output: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length === 0) return undefined;
  const bytes = new TextEncoder().encode(json);
  if (bytes.length <= PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES) return json;
  const truncated = new TextDecoder().decode(
    bytes.slice(0, PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES),
  );
  // The decoder replaces a split trailing code point with U+FFFD — drop it.
  return truncated.replace(/�+$/, "");
}
