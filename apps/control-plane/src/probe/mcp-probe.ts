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

/** One `tools_cache` entry: bare tool name + trimmed description + param names. */
export interface ProbeTool {
  name: string;
  description: string;
  params: string[];
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

/** Internal marker so the overall deadline reads as a timeout, not a protocol error. */
class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`probe timed out after ${ms}ms`);
    this.name = "ProbeTimeoutError";
  }
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
    const url = new URL(input.url);
    const options = {
      fetch: input.fetchImpl,
      requestInit: { headers: input.headers },
    };
    transport =
      input.transport === "sse"
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, options);
    const listed = await withDeadline(timeoutMs, async () => {
      await client.connect(transport!, { timeout: timeoutMs });
      return await client.listTools(undefined, { timeout: timeoutMs });
    });
    return {
      health: "ok",
      tools: listed.tools.slice(0, MAX_TOOLS).map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(
          0,
          MAX_TOOL_DESCRIPTION_CHARS,
        ),
        params: Object.keys(tool.inputSchema?.properties ?? {}),
      })),
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
 * Race an operation against a wall-clock deadline. The SDK's per-request
 * timeout covers requests once they are issued; this outer deadline also
 * covers transport start-up (the SSE endpoint wait has no request timeout).
 */
async function withDeadline<T>(ms: number, op: () => Promise<T>): Promise<T> {
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

/** Walk the error (and its `cause` chain) for an HTTP 401/403 from the transport. */
function findAuthStatus(error: unknown): number | null {
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

function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return message.slice(0, MAX_ERROR_CHARS);
}

/**
 * Redact every credential header value (and, for `Bearer x`-style values,
 * the trailing token alone) from a message before it can reach `last_error`.
 */
function scrubSecrets(
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
