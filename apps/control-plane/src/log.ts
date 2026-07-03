/**
 * Control-plane structured logger (docs/PLAN.md Phase 3 task 5).
 *
 * Thin app wrapper over the portable core in `@invisible-string/shared`
 * (`createStructuredLogger`): supplies the concrete stdout/stderr JSON sink and
 * the process-wide base bindings + min level. The core owns correlation-id
 * merging and the secret-redaction pass, so nothing that reaches this sink can
 * carry a raw token/URL-password (see the shared module doc + redaction tests).
 *
 * Emit one JSON object per line — a log pipeline pivots on `event` and any
 * correlation id (workspaceId/workflowId/sessionId/runId/workerId).
 */
import {
  createStructuredLogger,
  type LogBindings,
  type Logger,
  type LogLevel,
  type LoggerSink,
  type StructuredLogEvent,
} from "@invisible-string/shared";

/** Default sink: one JSON line per event; warn/error to stderr, else stdout. */
export function jsonLineSink(event: StructuredLogEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  if (event.level === "error" || event.level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

const VALID_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

/** Resolve the floor level from LOG_LEVEL (default `info`). */
export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  return raw && VALID_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : "info";
}

/**
 * Build the control-plane logger. `base` carries process-wide bindings (e.g.
 * `{ fields: { service: "control-plane" } }`); tests pass a capturing sink.
 */
export function createLogger(options: {
  base?: LogBindings;
  sink?: LoggerSink;
  minLevel?: LogLevel;
  env?: Record<string, string | undefined>;
} = {}): Logger {
  return createStructuredLogger({
    sink: options.sink ?? jsonLineSink,
    minLevel: options.minLevel ?? resolveLogLevel(options.env),
    base: {
      ...options.base,
      fields: { service: "control-plane", ...options.base?.fields },
    },
  });
}
