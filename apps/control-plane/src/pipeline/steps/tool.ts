/**
 * `tool` step executor — one deterministic MCP `tools/call` against a
 * workspace connection (pipeline redesign plan, step mechanics).
 *
 * The runner renders the step's tagged-template args against the run scope
 * and hands them here as `input` (see {@link toolStepRenderedInputSchema} —
 * the decreed rendered-input shape); this executor never re-renders. The
 * connection is loaded WORKSPACE-scoped (user-scoped connections are rejected
 * at publish, and the org-id predicate structurally excludes them anyway) and
 * must be enabled; auth resolves per `auth_type` — none, static headers via
 * `decryptConnectionAuthHeaders`, or a live OAuth access token through the
 * broker's central refresh — with plaintext confined to this function's scope.
 *
 * Failure classes (→ `run_steps.error_class`):
 *  - `config_error`      connection missing/disabled, tool filtered out, or
 *                        the server says the tool does not exist (which also
 *                        fire-and-forgets a re-probe to refresh the cache)
 *  - `invalid_args`      structural pre-flight against the CACHED inputSchema
 *                        (when present — a cache miss calls anyway; the
 *                        server stays authoritative), or the server's own
 *                        invalid-params answer
 *  - `tool_error`        the server executed the tool and flagged `isError`
 *  - `output_too_large`  structured result over {@link MAX_TOOL_RESULT_BYTES}
 *  - `auth_*` / `oauth_not_connected` / crypto codes — never retryable
 *  - `unreachable` / `timeout` / `rate_limited` / `server_error` — the ONLY
 *    retryable classes (the runner owns backoff + attempt budgets)
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";

import { getAccessToken } from "../../oauth/tokens";
import {
  scrubSecrets,
  type ProbeTool,
  type ProbeToolSchema,
} from "../../probe/mcp-probe";
import { probeAndPersist, type ConnectionRow } from "../../probe/service";
import { decryptConnectionAuthHeaders } from "../../resources/mcp-crypto";
import { isRuntimeApiError } from "../../runtime/errors";
import { callMcpTool } from "../mcp-call";
import type { StepExecuteContext, StepExecutor, StepOutcome } from "../types";

/** Default per-call wall clock (schema caps `timeoutMs` at 300s). */
export const TOOL_STEP_DEFAULT_TIMEOUT_MS = 60_000;

/** `output.text` cap — beyond it the text is TRUNCATED (marked), not failed. */
export const MAX_TOOL_TEXT_BYTES = 262_144;

/** Structured `output.result` cap — beyond it the step FAILS `output_too_large`. */
export const MAX_TOOL_RESULT_BYTES = 262_144;

/** Appended to a truncated `output.text` so consumers can tell. */
export const TOOL_TEXT_TRUNCATION_MARKER = "\n… [truncated]";

/** Failure messages are bounded like the probe's `last_error`. */
const MAX_STEP_ERROR_CHARS = 500;

/**
 * The DECREED rendered-input shape the runner persists to `run_steps.input`
 * for a `tool` step: the step's args after the tagged-template walk.
 */
export const toolStepRenderedInputSchema = z.object({
  args: z.record(z.string(), z.unknown()),
});
export type ToolStepRenderedInput = z.infer<typeof toolStepRenderedInputSchema>;

export const executeToolStep: StepExecutor = async (ctx) => {
  const { deps, step } = ctx;
  if (step.kind !== "tool") {
    return failed("internal", `executeToolStep received a "${step.kind}" step`);
  }
  const parsed = toolStepRenderedInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return failed(
      "internal",
      "rendered tool input is malformed — expected { args: Record<string, unknown> }",
    );
  }
  const args = parsed.data.args;

  // Workspace-scoped row ownership: the org-id predicate can only match a
  // `scope = 'workspace'` row (user-scoped rows have a NULL organization_id).
  const rows = await deps.db
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, step.connectionId),
        eq(schema.connections.organizationId, ctx.orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return failed(
      "config_error",
      `connection ${step.connectionId} not found in this workspace`,
    );
  }
  if (!row.enabled) {
    return failed("config_error", `connection "${row.name}" is disabled`);
  }
  // The connection's tool filters bind unattended runs too: a tool an agent
  // could not see must not be reachable through a pipeline step either.
  if (row.toolAllow && !row.toolAllow.includes(step.tool)) {
    return failed(
      "config_error",
      `tool "${step.tool}" is not on connection "${row.name}"'s tool allowlist`,
    );
  }
  if (row.toolBlock?.includes(step.tool)) {
    return failed(
      "config_error",
      `tool "${step.tool}" is blocked on connection "${row.name}"`,
    );
  }

  // Auth — plaintext lives in this function's scope only, never logged,
  // never persisted, never in an outcome.
  let headers: Record<string, string>;
  if (row.authType === "oauth") {
    if (!deps.oauthTokens) {
      return failed(
        "oauth_not_connected",
        "the OAuth broker is not configured on this deployment — cannot obtain an access token",
      );
    }
    try {
      const grant = await getAccessToken(deps.oauthTokens, row.id);
      headers = { Authorization: `Bearer ${grant.token}` };
    } catch (error) {
      // `oauth_not_connected` (dead grant — re-consent is the only recovery)
      // and the crypto/exchange codes are all non-retryable by construction.
      if (isRuntimeApiError(error)) return failed(error.code, error.message);
      throw error;
    }
  } else {
    try {
      headers = decryptConnectionAuthHeaders(row, deps.masterKey);
    } catch (error) {
      if (isRuntimeApiError(error)) return failed(error.code, error.message);
      throw error;
    }
  }

  // Structural pre-flight against the CACHED schema when the probe stored
  // one. A cache row without `inputSchema` (pre-pipeline probe) or without
  // this tool at all is a MISS: call anyway — the server is authoritative.
  const cachedTools: ProbeTool[] = row.toolsCache ?? [];
  const cached = cachedTools.find((tool) => tool.name === step.tool);
  if (cached?.inputSchema) {
    const problems = preflightToolArgs(cached.inputSchema, args);
    if (problems.length > 0) {
      return failed(
        "invalid_args",
        `arguments do not match the tool's schema: ${problems.join("; ")}`,
      );
    }
  }

  const outcome = await callMcpTool({
    url: row.url,
    transport: row.transport,
    headers,
    // Mirrors probeAndPersist: an `oauth` row counts as credentialed.
    hasCredentials: row.authConfigEncrypted != null || row.authType === "oauth",
    fetchImpl: deps.fetchImpl,
    toolName: step.tool,
    args,
    timeoutMs: step.timeoutMs ?? TOOL_STEP_DEFAULT_TIMEOUT_MS,
    signal: ctx.signal,
  });

  if (outcome.kind === "error") {
    if (outcome.errorClass === "tool_not_found") {
      // The cache lied (or was empty) and the server disagreed — refresh it
      // in the background so the next attempt/edit sees reality.
      kickReProbe(ctx, row);
      return failed("config_error", outcome.error);
    }
    return {
      status: "failed",
      errorClass: outcome.errorClass,
      error: outcome.error.slice(0, MAX_STEP_ERROR_CHARS),
      retryable: outcome.retryable,
    };
  }

  if (outcome.isError) {
    const detail = outcome.textParts.join("\n").trim();
    return failed(
      "tool_error",
      detail === ""
        ? "the tool reported an error with no message"
        : // headers is still in scope — scrub tool-authored failure text the
          // way the probe scrubs `last_error` (transport-level classes arrive
          // pre-scrubbed from mcp-call).
          scrubSecrets(detail, headers),
    );
  }

  const { text } = truncateText(outcome.textParts.join("\n"));
  const result =
    outcome.structuredContent ?? parseSingleTextJson(outcome.textParts) ?? null;
  if (result !== null && jsonByteLength(result) > MAX_TOOL_RESULT_BYTES) {
    return failed(
      "output_too_large",
      `the tool's structured result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte cap`,
    );
  }
  return {
    status: "succeeded",
    output: { result, text, isError: false },
  };
};

// ── pre-flight ───────────────────────────────────────────────────────────────

/**
 * Structural pre-flight of rendered args against a cached tool schema:
 * required properties must be present, and declared-type args must not be a
 * PRIMITIVE type mismatch. Deliberately shallow — enums, nested shapes, and
 * everything else stay the server's call (the cache is a hint, and stale
 * hints must not veto valid calls). Returns human-readable problems; empty
 * means "go ahead".
 */
export function preflightToolArgs(
  schemaNode: ProbeToolSchema,
  args: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const name of schemaNode.required ?? []) {
    if (args[name] === undefined) {
      problems.push(`missing required argument "${name}"`);
    }
  }
  for (const [name, child] of Object.entries(schemaNode.properties ?? {})) {
    const value = args[name];
    if (value === undefined) continue;
    const mismatch = typeMismatch(child.type, value);
    if (mismatch) problems.push(`argument "${name}" ${mismatch}`);
  }
  return problems;
}

function typeMismatch(type: string | undefined, value: unknown): string | null {
  switch (type) {
    case "string":
      return typeof value === "string" ? null : expected("a string", value);
    case "number":
      return typeof value === "number" ? null : expected("a number", value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : expected("an integer", value);
    case "boolean":
      return typeof value === "boolean" ? null : expected("a boolean", value);
    case "array":
      return Array.isArray(value) ? null : expected("an array", value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? null
        : expected("an object", value);
    default:
      // Unknown or absent type keyword — no opinion; server authoritative.
      return null;
  }
}

function expected(what: string, value: unknown): string {
  return `must be ${what} (got ${describeJson(value)})`;
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── internals ────────────────────────────────────────────────────────────────

function failed(errorClass: string, error: string): StepOutcome {
  return {
    status: "failed",
    errorClass,
    error: error.slice(0, MAX_STEP_ERROR_CHARS),
    retryable: false,
  };
}

/** Fire-and-forget cache refresh after a server-side "tool not found". */
function kickReProbe(ctx: StepExecuteContext, row: ConnectionRow): void {
  const { deps } = ctx;
  // The probe resolves an oauth row's credential through the broker; without
  // one wired (unit fixtures) there is nothing to refresh the cache with.
  if (!deps.oauthTokens) return;
  void probeAndPersist(
    {
      db: deps.db,
      masterKey: deps.masterKey,
      probeFetch: deps.fetchImpl,
      oauthBroker: deps.oauthTokens,
    },
    row,
  ).catch((error) => {
    deps.logger.warn("pipeline.tool_reprobe_failed", {
      workspaceId: ctx.orgId,
      runId: ctx.run.id,
      fields: { connectionId: row.id },
      err: error,
    });
  });
}

/** UTF-8-safe truncation at {@link MAX_TOOL_TEXT_BYTES}, marked. */
function truncateText(raw: string): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  if (bytes.byteLength <= MAX_TOOL_TEXT_BYTES) {
    return { text: raw, truncated: false };
  }
  const budget =
    MAX_TOOL_TEXT_BYTES - encoder.encode(TOOL_TEXT_TRUNCATION_MARKER).byteLength;
  // Lossy decode may leave a replacement char where a code point was split.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, budget))
    .replace(/�+$/, "");
  return { text: `${head}${TOOL_TEXT_TRUNCATION_MARKER}`, truncated: true };
}

/** The `result` fallback: exactly one text part that parses as JSON. */
function parseSingleTextJson(textParts: string[]): unknown {
  if (textParts.length !== 1) return undefined;
  try {
    return JSON.parse(textParts[0]!) as unknown;
  } catch {
    return undefined;
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
