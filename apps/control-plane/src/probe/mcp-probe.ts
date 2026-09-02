/**
 * MCP probe client (connectors redesign spec §7): dial one connection's MCP
 * server with the official SDK client THROUGH the guarded egress fetch,
 * classify health, and trim its `tools/list` into the shape
 * `connections.tools_cache` stores.
 *
 * Classification (spec §7 table):
 *  - handshake + list OK                         → `ok` (+ trimmed tools)
 *  - HTTP 401/403, no credentials configured     → `auth_required`
 *  - HTTP 401/403 with credentials present       → `auth_error`
 *  - egress-blocked / timeout / DNS / connection / protocol failure
 *                                                → `unreachable`
 *
 * SECRETS DISCIPLINE: decrypted auth headers live in function scope only —
 * never logged, never persisted, and `error` strings are scrubbed against
 * every header value before they leave this module.
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SseError,
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 500;
const MAX_ERROR_CHARS = 500;
const MAX_CAUSE_DEPTH = 8;

/** Depth cap on the trimmed per-tool `inputSchema` kept in the cache (root = 1). */
export const MAX_INPUT_SCHEMA_DEPTH = 5;
/** Property/enum caps so one pathological server cannot bloat `tools_cache`. */
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_SCHEMA_ENUM_VALUES = 100;

/**
 * A TRIMMED JSON-Schema node cached per tool: only the keywords the pipeline
 * tool-step pre-flight and the schema-aware arg forms read
 * (`type`/`properties`/`required`/`enum`/`items`/`description`), depth-capped
 * at {@link MAX_INPUT_SCHEMA_DEPTH}. Everything else a server advertises
 * (pattern, format, $ref, …) is dropped — the SERVER stays authoritative;
 * this is a hint, never an enforcement contract.
 */
export interface ProbeToolSchema {
  type?: string;
  description?: string;
  enum?: (string | number | boolean)[];
  properties?: Record<string, ProbeToolSchema>;
  required?: string[];
  items?: ProbeToolSchema;
}

/**
 * One `tools_cache` entry: bare tool name + trimmed description + param names.
 * `inputSchema` arrived with the pipeline redesign and is OPTIONAL — cache
 * rows written by earlier probes lack it, and every reader must keep working
 * off name-presence alone when it is absent (it fills in on the next probe).
 */
export interface ProbeTool {
  name: string;
  description: string;
  params: string[];
  inputSchema?: ProbeToolSchema;
}

export interface ProbeOutcome {
  health: "ok" | "unreachable" | "auth_required" | "auth_error";
  /** null unless `ok`; capped at {@link MAX_TOOLS}, descriptions truncated. */
  tools: ProbeTool[] | null;
  /** Classification detail for `last_error`; NEVER contains credential material. */
  error: string | null;
}

export interface ProbeMcpServerInput {
  url: string;
  transport: "streamable-http" | "sse";
  /** Decrypted static auth headers, possibly empty. Function scope only. */
  headers: Record<string, string>;
  hasCredentials: boolean;
  /** The guarded egress fetch — the probe never dials with bare fetch. */
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/**
 * Marker so the overall deadline reads as a timeout, not a protocol error.
 * Exported for the pipeline MCP caller (pipeline/mcp-call.ts), which shares
 * {@link withDeadline} and classifies this as its retryable `timeout` class.
 */
export class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`mcp request timed out after ${ms}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/** The connection fields both MCP dialers (probe + tool call) build a transport from. */
export interface McpTransportInput {
  url: string;
  transport: "streamable-http" | "sse";
  /** Decrypted static auth headers, possibly empty. Function scope only. */
  headers: Record<string, string>;
  /** The guarded egress fetch — neither dialer ever uses bare fetch. */
  fetchImpl: typeof fetch;
}

/**
 * Construct the SDK transport exactly the way the probe dials: guarded fetch
 * injected, auth headers on every request. Shared with pipeline/mcp-call.ts so
 * the two callers cannot drift on transport construction. Throws on an
 * unparseable URL (callers classify that as unreachable).
 */
export function createMcpClientTransport(input: McpTransportInput): Transport {
  const url = new URL(input.url);
  const options = {
    fetch: input.fetchImpl,
    requestInit: { headers: input.headers },
  };
  return input.transport === "sse"
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
}

/**
 * Initialize handshake + `tools/list` against one MCP server, closing the
 * client in `finally`. Never throws for server-side conditions — every
 * failure becomes a classified {@link ProbeOutcome}.
 */
export async function probeMcpServer(
  input: ProbeMcpServerInput,
): Promise<ProbeOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: "invisible-string-probe", version: "1.0.0" });
  let transport: Transport | undefined;
  try {
    transport = createMcpClientTransport(input);
    const listed = await withDeadline(timeoutMs, async () => {
      await client.connect(transport!, { timeout: timeoutMs });
      return await client.listTools(undefined, { timeout: timeoutMs });
    });
    return {
      health: "ok",
      tools: listed.tools.slice(0, MAX_TOOLS).map((tool) => {
        const inputSchema = trimToolInputSchema(tool.inputSchema);
        return {
          name: tool.name,
          description: (tool.description ?? "").slice(
            0,
            MAX_TOOL_DESCRIPTION_CHARS,
          ),
          params: Object.keys(tool.inputSchema?.properties ?? {}),
          ...(inputSchema ? { inputSchema } : {}),
        };
      }),
      error: null,
    };
  } catch (error) {
    return classifyFailure(error, input);
  } finally {
    // Close both: the client's transport reference is only set once connect
    // progressed, and closing aborts any fetch the deadline left in flight.
    await transport?.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

/**
 * Trim a server-advertised tool `inputSchema` into the cacheable subset (see
 * {@link ProbeToolSchema}). Pure and defensive: a non-object node, or a node
 * whose kept keywords all trim away, yields undefined — the cache entry then
 * simply carries no schema, exactly like a pre-pipeline row.
 */
export function trimToolInputSchema(
  raw: unknown,
  depth = 1,
): ProbeToolSchema | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const node = raw as Record<string, unknown>;
  const out: ProbeToolSchema = {};
  if (typeof node.type === "string") out.type = node.type;
  if (typeof node.description === "string") {
    out.description = node.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS);
  }
  if (Array.isArray(node.enum)) {
    const values = node.enum
      .filter(
        (value): value is string | number | boolean =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
      .slice(0, MAX_SCHEMA_ENUM_VALUES);
    if (values.length > 0) out.enum = values;
  }
  if (Array.isArray(node.required)) {
    const names = node.required.filter(
      (name): name is string => typeof name === "string",
    );
    if (names.length > 0) out.required = names;
  }
  // The depth cap prunes CHILDREN, not the node itself: a node at the cap
  // keeps its scalar keywords and drops the nesting below it.
  if (depth < MAX_INPUT_SCHEMA_DEPTH) {
    if (
      node.properties !== null &&
      typeof node.properties === "object" &&
      !Array.isArray(node.properties)
    ) {
      const properties: Record<string, ProbeToolSchema> = {};
      for (const [key, child] of Object.entries(
        node.properties as Record<string, unknown>,
      ).slice(0, MAX_SCHEMA_PROPERTIES)) {
        const trimmed = trimToolInputSchema(child, depth + 1);
        if (trimmed) properties[key] = trimmed;
      }
      if (Object.keys(properties).length > 0) out.properties = properties;
    }
    const items = trimToolInputSchema(node.items, depth + 1);
    if (items) out.items = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Race an operation against a wall-clock deadline. The SDK's per-request
 * timeout covers requests once they are issued; this outer deadline also
 * covers transport start-up (the SSE endpoint wait has no request timeout).
 * Shared with pipeline/mcp-call.ts, whose deadline covers connect + call.
 */
export async function withDeadline<T>(
  ms: number,
  op: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([op(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyFailure(
  error: unknown,
  input: Pick<ProbeMcpServerInput, "hasCredentials" | "headers">,
): ProbeOutcome {
  const authStatus = findAuthStatus(error);
  if (authStatus !== null) {
    return {
      health: input.hasCredentials ? "auth_error" : "auth_required",
      tools: null,
      error: `mcp server returned http ${authStatus}`,
    };
  }
  return {
    health: "unreachable",
    tools: null,
    error: scrubSecrets(describeError(error), input.headers),
  };
}

/**
 * Walk the error (and its `cause` chain) for an HTTP 401/403 from the
 * transport. Exported for pipeline/mcp-call.ts, which classifies auth
 * failures the same way.
 */
export function findAuthStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (current instanceof UnauthorizedError) return 401;
    if (
      (current instanceof StreamableHTTPError || current instanceof SseError) &&
      (current.code === 401 || current.code === 403)
    ) {
      return current.code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Bounded human-readable message for an unknown thrown value (shared). */
export function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return message.slice(0, MAX_ERROR_CHARS);
}

/**
 * Redact every credential header value (and, for `Bearer x`-style values,
 * the trailing token alone) from a message before it can reach `last_error`
 * (or, via pipeline/mcp-call.ts, a `run_steps.error` string).
 */
export function scrubSecrets(
  message: string,
  headers: Record<string, string>,
): string {
  let scrubbed = message;
  for (const value of Object.values(headers)) {
    if (!value) continue;
    scrubbed = scrubbed.replaceAll(value, "[redacted]");
    const lastSegment = value.split(/\s+/).at(-1);
    if (lastSegment && lastSegment !== value) {
      scrubbed = scrubbed.replaceAll(lastSegment, "[redacted]");
    }
  }
  return scrubbed;
}
