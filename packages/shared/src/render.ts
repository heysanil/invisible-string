/**
 * Task-message rendering against ONE trigger event. Since the pipeline
 * redesign, workflow dispatch renders per-step markdown through
 * pipeline-template.ts (`renderMarkdownTemplate`, full run scope) — this
 * module keeps the value helpers that rendering reuses
 * ({@link formatTriggerValue}, {@link resolveTriggerPath}) and
 * {@link renderTaskMessage}, the trigger-only task-block renderer the agent
 * step's dispatcher wraps its rendered instructions with.
 *
 * Reference semantics (trigger-only — pipeline heads `@steps` / `@state` /
 * `@item` / `@now` are left VERBATIM here; render those surfaces through
 * pipeline-template.ts instead):
 * - `@trigger.<path>` → the value at that dot path in `event.data`,
 *   formatted per {@link formatTriggerValue} ("(not provided)" when missing).
 * - `@<connection>` / `@skill.<slug>` → prose literals (`the "<slug>"
 *   connection` / `the "<slug>" skill`) — the agent's compiled instructions
 *   appendix already teaches it how to reach those resources.
 *
 * Output shape (blocks omitted when empty):
 *
 *   <workflow-task>
 *   {instructions with all @references rewritten}
 *   </workflow-task>
 *
 *   <trigger-context>
 *   {event.message}
 *   trigger.<path>: <formatted value>   (one line per referenced path)
 *   {event.context lines}
 *   </trigger-context>
 */
import { parseReferences } from "./workflow-config";

/** Resolve a dot path (e.g. "customer.email") against `TriggerEvent.data`. */
export function resolveTriggerPath(
  data: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Render one trigger-data value for the model: strings verbatim, missing
 * paths as a readable "(not provided)", everything else as JSON.
 */
export function formatTriggerValue(value: unknown): string {
  if (value === undefined) return "(not provided)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The slice of a trigger event `renderTaskMessage` consumes — message/data/
 * context of a TriggerEvent (the dispatcher passes the real envelope's
 * fields; previews may fabricate them).
 */
export interface TaskMessageEvent {
  /** Model-facing prompt / primary input (may be empty, e.g. schedules). */
  message: string;
  /** Structured fields `@trigger.*` references resolve against. */
  data: Record<string, unknown>;
  /** Extra platform context blocks appended to the trigger context. */
  context?: string[];
}

/**
 * Render workflow instructions + a trigger event into the task message.
 *
 * The `<workflow-task>` block carries the instructions with every
 * `@reference` rewritten (trigger refs inline their resolved values). The
 * `<trigger-context>` block carries the event's message, one
 * `trigger.<path>: <value>` line per unique referenced path (document
 * order — so inlined values stay auditable next to their source), and any
 * platform context lines; it is omitted entirely when it would be empty.
 */
export function renderTaskMessage(
  instructionsMarkdown: string,
  event: TaskMessageEvent,
): string {
  const refs = parseReferences(instructionsMarkdown);

  // Rewrite from the end so earlier spans stay valid. Pipeline-only heads
  // (@steps/@state/@item/@now) have no meaning against a lone trigger event
  // and stay verbatim — pipeline-template.ts owns those surfaces.
  let resolved = instructionsMarkdown;
  const referencedPaths: string[] = [];
  for (const ref of [...refs].reverse()) {
    let replacement: string | null = null;
    if (ref.kind === "trigger") {
      replacement = formatTriggerValue(resolveTriggerPath(event.data, ref.path));
    } else if (ref.kind === "skill") {
      replacement = `the "${ref.slug}" skill`;
    } else if (ref.kind === "connection") {
      replacement = `the "${ref.name}" connection`;
    }
    if (replacement === null) continue;
    resolved =
      resolved.slice(0, ref.start) + replacement + resolved.slice(ref.end);
  }
  for (const ref of refs) {
    if (ref.kind === "trigger" && !referencedPaths.includes(ref.path)) {
      referencedPaths.push(ref.path);
    }
  }

  const contextLines: string[] = [];
  if (event.message.length > 0) contextLines.push(event.message);
  for (const path of referencedPaths) {
    const value = resolveTriggerPath(event.data, path);
    contextLines.push(`trigger.${path}: ${formatTriggerValue(value)}`);
  }
  contextLines.push(...(event.context ?? []));

  const blocks = [`<workflow-task>\n${resolved.trim()}\n</workflow-task>`];
  if (contextLines.length > 0) {
    blocks.push(`<trigger-context>\n${contextLines.join("\n")}\n</trigger-context>`);
  }
  return blocks.join("\n\n");
}
