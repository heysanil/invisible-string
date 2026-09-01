/**
 * Deterministic MCP `tools/call` for pipeline `tool` steps — the probe's
 * dial machinery (probe/mcp-probe.ts) extended with one tool invocation:
 * same transport construction ({@link createMcpClientTransport}), same outer
 * wall-clock deadline, close-in-finally, and the same secrets discipline
 * (`scrubSecrets` runs over every failure message before it can reach a
 * `run_steps.error` string or an event payload).
 *
 * One call = one FRESH client (the probe precedent — pooling can arrive later
 * behind this module boundary without touching callers), and every dial rides
 * the injected guarded egress fetch; this module never touches bare fetch.
 *
 * Classification is FINER than the probe's, because the runner's retry policy
 * keys off it. Retryable classes are exactly the plan's set — `unreachable`,
 * `timeout`, `rate_limited` (HTTP 429), `server_error` (HTTP 5xx) — and
 * nothing else: a JSON-RPC answer from the server (tool not found, invalid
 * params, internal error) means the server is up and answered, so retrying a
 * deterministic call cannot help.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  createMcpClientTransport,
  describeError,
  findAuthStatus,
  ProbeTimeoutError,
  scrubSecrets,
  withDeadline,
} from "../probe/mcp-probe";

/** Default per-call wall clock; the tool step overrides via its `timeoutMs`. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

const MAX_CAUSE_DEPTH = 8;

/**
 * Failure classes a call can land in. The tool-step executor maps these onto
 * `run_steps.error_class` values (`tool_not_found` becomes `config_error`
 * there, after kicking a re-probe); `canceled` means the step's abort signal
 * fired mid-call — the runner owns cancellation and discards the outcome.
 */
export type McpCallFailureClass =
  | "unreachable"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "auth_required"
  | "auth_error"
  | "tool_not_found"
  | "invalid_args"
  | "tool_error"
  | "canceled";

const RETRYABLE_CLASSES: ReadonlySet<McpCallFailureClass> = new Set([
  "unreachable",
  "timeout",
  "rate_limited",
  "server_error",
]);

export interface McpToolCallInput {
  url: string;
  transport: "streamable-http" | "sse";
  /** Decrypted auth headers, possibly empty. Function scope only. */
  headers: Record<string, string>;
  /** Drives the probe's 401 classification: `auth_error` vs `auth_required`. */
  hasCredentials: boolean;
  /** The guarded egress fetch — this module never dials with bare fetch. */
  fetchImpl: typeof fetch;
  /** Tool name exactly as the server lists it. */
  toolName: string;
  /** Rendered args (refs already resolved — never a template). */
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** Cooperative cancellation from the step context. */
  signal?: AbortSignal;
}

export type McpToolCallOutcome =
  | {
      kind: "ok";
      /** The server's `isError` flag — a TOOL-level failure, transport fine. */
      isError: boolean;
      /** `structuredContent` when the server sent one. */
      structuredContent: Record<string, unknown> | undefined;
      /** Every `text` content part, in order (untruncated — the step caps). */
      textParts: string[];
    }
  | {
      kind: "error";
      errorClass: McpCallFailureClass;
      /** Human-readable, SCRUBBED against every header value. */
      error: string;
      retryable: boolean;
    };

/**
 * Initialize + `tools/call` against one MCP server, closing the client in
 * `finally`. Never throws for server-side conditions — every failure becomes
 * a classified {@link McpToolCallOutcome}.
 */
export async function callMcpTool(
  input: McpToolCallInput,
): Promise<McpToolCallOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
  if (input.signal?.aborted) {
    return failure("canceled", "the run was canceled before the tool call");
  }
  const client = new Client({
    name: "invisible-string-pipeline",
    version: "1.0.0",
  });
  let transport: Transport | undefined;
  try {
    transport = createMcpClientTransport(input);
    const requestOptions = {
      timeout: timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const result = (await withDeadline(timeoutMs, async () => {
      await client.connect(transport!, requestOptions);
      return await client.callTool(
        { name: input.toolName, arguments: input.args },
        undefined,
        requestOptions,
      );
    })) as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(result.content) ? result.content : [];
    const textParts = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    const structuredContent =
      result.structuredContent !== null &&
      typeof result.structuredContent === "object" &&
      !Array.isArray(result.structuredContent)
        ? (result.structuredContent as Record<string, unknown>)
        : undefined;
    if (result.isError === true) {
      // The official SDK SERVER wraps protocol-level failures — unknown tool,
      // disabled tool, input-validation rejection — into an `isError` result
      // whose text is the stringified McpError (`server/mcp.js`
      // createToolError), while spec-conformant non-SDK servers answer real
      // JSON-RPC errors (the catch below). Recognize the wrapped shape so
      // both server styles land in the same classes.
      const wrapped = classifyWrappedProtocolError(textParts);
      if (wrapped) {
        return failure(
          wrapped.errorClass,
          scrubSecrets(wrapped.detail, input.headers),
        );
      }
    }
    return {
      kind: "ok",
      isError: result.isError === true,
      structuredContent,
      textParts,
    };
  } catch (error) {
    return classifyCallFailure(error, input);
  } finally {
    // Close both: the client's transport reference is only set once connect
    // progressed, and closing aborts any fetch the deadline left in flight.
    await transport?.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

function failure(
  errorClass: McpCallFailureClass,
  error: string,
): McpToolCallOutcome {
  return {
    kind: "error",
    errorClass,
    error,
    retryable: RETRYABLE_CLASSES.has(errorClass),
  };
}

function classifyCallFailure(
  error: unknown,
  input: Pick<McpToolCallInput, "hasCredentials" | "headers" | "signal">,
): McpToolCallOutcome {
  const scrubbed = scrubSecrets(describeError(error), input.headers);
  if (input.signal?.aborted) {
    return failure("canceled", "the run was canceled during the tool call");
  }
  if (error instanceof ProbeTimeoutError) return failure("timeout", scrubbed);
  if (error instanceof McpError) {
    // The server ANSWERED with a JSON-RPC error — the transport is fine, so
    // none of these retry. `-32602` doubles as the official SDK's "Tool X not
    // found" (server/mcp.js), which the tool step turns into a config error
    // plus a fire-and-forget re-probe to refresh the stale cache.
    if (error.code === ErrorCode.RequestTimeout) {
      return failure("timeout", scrubbed);
    }
    if (error.code === ErrorCode.MethodNotFound) {
      return failure("tool_not_found", scrubbed);
    }
    if (error.code === ErrorCode.InvalidParams) {
      return /\bnot found\b|unknown tool/i.test(error.message)
        ? failure("tool_not_found", scrubbed)
        : failure("invalid_args", scrubbed);
    }
    return failure("tool_error", scrubbed);
  }
  const authStatus = findAuthStatus(error);
  if (authStatus !== null) {
    return failure(
      input.hasCredentials ? "auth_error" : "auth_required",
      `mcp server returned http ${authStatus}`,
    );
  }
  const httpStatus = findHttpStatus(error);
  if (httpStatus === 429) return failure("rate_limited", scrubbed);
  if (httpStatus !== null && httpStatus >= 500) {
    return failure("server_error", scrubbed);
  }
  return failure("unreachable", scrubbed);
}

/**
 * Recognize an SDK-server-wrapped protocol failure inside an `isError`
 * result: exactly one text part of the stringified-McpError shape
 * (`MCP error <code>: <detail>`). `-32601` and `-32602`+"not found"/"disabled"
 * mean the TOOL cannot be called at all; other `-32602`s are the server
 * rejecting the arguments. Any other wrapped code — and any ordinary tool
 * error text — returns null and stays a plain `isError` result.
 */
function classifyWrappedProtocolError(
  textParts: string[],
): { errorClass: McpCallFailureClass; detail: string } | null {
  if (textParts.length !== 1) return null;
  const match = /^MCP error (-\d+): ([\s\S]*)$/.exec(textParts[0]!);
  if (!match) return null;
  const code = Number(match[1]);
  const detail = match[2]!.slice(0, 500);
  if (code === ErrorCode.MethodNotFound) {
    return { errorClass: "tool_not_found", detail };
  }
  if (code === ErrorCode.InvalidParams) {
    return /\bnot found\b|\bdisabled\b|unknown tool/i.test(detail)
      ? { errorClass: "tool_not_found", detail }
      : { errorClass: "invalid_args", detail };
  }
  return null;
}

/** Walk the error (and its `cause` chain) for a transport HTTP status. */
function findHttpStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (
      (current instanceof StreamableHTTPError || current instanceof SseError) &&
      typeof current.code === "number" &&
      current.code >= 100
    ) {
      return current.code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
