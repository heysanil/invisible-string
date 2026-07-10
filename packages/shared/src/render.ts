/**
 * Dispatch-time rendering: workflow instructions + trigger event → the task
 * message. `renderTaskMessage` produces the EXACT string the control plane
 * sends to the agent's eve session (`createEveSession`/`continueEveSession`)
 * and persists on `runs.task_message` — agents never see the TriggerEvent
 * envelope itself (trigger-event.ts is storage/provenance only). Shared so
 * the SPA can preview a rendered task message without a round-trip.
 *
 * Reference semantics (the dispatch half of the `@reference` contract; the
 * compile half — personas — lives in packages/compiler):
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

  // Rewrite from the end so earlier spans stay valid.
  let resolved = instructionsMarkdown;
  const referencedPaths: string[] = [];
  for (const ref of [...refs].reverse()) {
    const replacement =
      ref.kind === "trigger"
        ? formatTriggerValue(resolveTriggerPath(event.data, ref.path))
        : ref.kind === "skill"
          ? `the "${ref.slug}" skill`
          : `the "${ref.name}" connection`;
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
