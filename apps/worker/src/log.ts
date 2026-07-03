/**
 * Worker structured logger (docs/PLAN.md Phase 3 task 5).
 *
 * Thin app wrapper over the portable core in `@invisible-string/shared`
 * (`createStructuredLogger`): supplies the concrete stdout/stderr JSON sink and
 * process-wide base bindings + min level. Correlation-id merging and the
 * secret-redaction pass live in the core — the worker handles full agent env
 * maps, so redaction here is load-bearing (a stray token in a log field is
 * scrubbed before it reaches the sink).
 *
 * `stringLogAdapter` bridges the legacy `log(message: string)` callback the
 * supervisor threads into agents/cache/registration into this logger, so every
 * existing internal log line becomes a structured JSON event without rewriting
 * each call site.
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
      fields: { service: "worker", ...options.base?.fields },
    },
  });
}

/**
 * Adapt a {@link Logger} to the legacy `(message: string) => void` callback the
 * supervisor passes into sub-components. Each string becomes an `info`
 * `worker.log` event (the message still goes through redaction). This keeps the
 * many detailed internal log lines while upgrading them to structured JSON.
 */
export function stringLogAdapter(logger: Logger): (message: string) => void {
  return (message: string) => logger.info("worker.log", { msg: message });
}
