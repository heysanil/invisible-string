/**
 * TriggerEvent — the platform's normalized trigger envelope, inlined from
 * packages/shared/src/trigger-event.ts (generated projects cannot depend on
 * workspace packages). The control-plane dispatcher POSTs this shape to the
 * trigger channel with a platform JWT.
 */
export interface TriggerPrincipal {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly source: string;
}

export interface TriggerFile {
  readonly name: string;
  readonly mediaType: string;
  /** Inline base64 (small payloads) or an object-store URL string. */
  readonly data: string;
}

export interface TriggerEvent {
  readonly workflowId: string;
  readonly triggerType: string;
  readonly message: string;
  /** Structured fields that {{trigger.*}} markers resolve against. */
  readonly data: Record<string, unknown>;
  readonly files?: readonly TriggerFile[];
  readonly principal: TriggerPrincipal;
  /** Maps threaded/conversational triggers onto an existing session. */
  readonly continuationToken?: string;
  /** Extra platform context blocks folded into the model message. */
  readonly context?: readonly string[];
}

export type ParseTriggerEventResult =
  | { readonly ok: true; readonly event: TriggerEvent }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseTriggerEvent(body: unknown): ParseTriggerEventResult {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.workflowId !== "string" || body.workflowId.length === 0) {
    return { ok: false, error: "workflowId (non-empty string) is required" };
  }
  if (typeof body.triggerType !== "string" || body.triggerType.length === 0) {
    return { ok: false, error: "triggerType (non-empty string) is required" };
  }
  if (typeof body.message !== "string") {
    return { ok: false, error: "message (string) is required" };
  }
  if (!isRecord(body.data)) {
    return { ok: false, error: "data (object) is required" };
  }
  const principal = body.principal;
  if (
    !isRecord(principal) ||
    typeof principal.workspaceId !== "string" ||
    principal.workspaceId.length === 0 ||
    typeof principal.source !== "string" ||
    principal.source.length === 0 ||
    (principal.userId !== undefined && typeof principal.userId !== "string")
  ) {
    return { ok: false, error: "principal { workspaceId, source, userId? } is required" };
  }
  if (
    body.continuationToken !== undefined &&
    (typeof body.continuationToken !== "string" || body.continuationToken.length === 0)
  ) {
    return { ok: false, error: "continuationToken must be a non-empty string" };
  }
  if (body.context !== undefined && !isStringArray(body.context)) {
    return { ok: false, error: "context must be an array of strings" };
  }
  if (body.files !== undefined) {
    if (
      !Array.isArray(body.files) ||
      !body.files.every(
        (file) =>
          isRecord(file) &&
          typeof file.name === "string" &&
          typeof file.mediaType === "string" &&
          typeof file.data === "string",
      )
    ) {
      return { ok: false, error: "files must be an array of { name, mediaType, data }" };
    }
  }
  return { ok: true, event: body as unknown as TriggerEvent };
}

/** Resolve a dot path (e.g. "customer.email") against TriggerEvent.data. */
export function resolveTriggerPath(
  data: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function formatTriggerValue(value: unknown): string {
  if (value === undefined) return "(not provided)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Fold platform context blocks + resolved {{trigger.*}} marker values into
 * the model message (custom channels fold context into the message; only the
 * default eve channel has an onMessage context hook).
 */
export function buildTriggerMessage(
  event: TriggerEvent,
  refPaths: readonly string[],
): string {
  const blocks: string[] = [...(event.context ?? [])];
  for (const path of refPaths) {
    const value = resolveTriggerPath(event.data, path);
    blocks.push(`trigger.${path}: ${formatTriggerValue(value)}`);
  }
  if (blocks.length === 0) return event.message;
  return `<trigger-context>\n${blocks.join("\n")}\n</trigger-context>\n\n${event.message}`;
}
