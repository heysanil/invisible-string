/**
 * Typed runtime-API errors → uniform `ApiErrorBody` responses.
 *
 * Every failure the publish/session/run paths can produce is a
 * `RuntimeApiError` with a stable machine-readable `code` (surfaced to the
 * builder UI) and an HTTP status. Route handlers catch these and translate;
 * anything else is a 500 with no internals leaked.
 */
import type { ApiErrorBody } from "@invisible-string/shared";

export class RuntimeApiError extends Error {
  override readonly name: string = "RuntimeApiError";
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

// ── 4xx: caller/config problems ─────────────────────────────────────────────

export const errors = {
  workflowNotFound: () =>
    new RuntimeApiError(404, "workflow_not_found", "workflow not found in this workspace"),
  sessionNotFound: () =>
    new RuntimeApiError(404, "session_not_found", "session not found in this workspace"),
  runNotFound: () =>
    new RuntimeApiError(404, "run_not_found", "run not found in this workspace"),

  draftInvalid: (issues: unknown) =>
    new RuntimeApiError(
      422,
      "draft_invalid",
      "workflow draft is not a valid four-pillar definition",
      issues,
    ),
  agentPresetNotFound: (agentPresetId: string) =>
    new RuntimeApiError(
      422,
      "agent_preset_not_found",
      `agent preset ${agentPresetId} does not exist in this workspace`,
    ),
  modelPresetNotFound: (slug: string) =>
    new RuntimeApiError(
      422,
      "model_preset_not_found",
      `workspace has no "${slug}" model preset — re-seed workspace presets`,
    ),
  modelNotAllowlisted: (modelId: string) =>
    new RuntimeApiError(
      422,
      "model_not_allowlisted",
      `model "${modelId}" is not on this workspace's model allowlist`,
    ),
  contextResourceNotFound: (kind: "mcp_connection" | "skill", id: string) =>
    new RuntimeApiError(
      422,
      "context_resource_not_found",
      `${kind === "skill" ? "skill" : "MCP connection"} ${id} is not available to this workflow`,
    ),
  compileFailed: (issues: unknown) =>
    new RuntimeApiError(422, "compile_failed", "workflow failed to compile", issues),

  workflowNotPublished: () =>
    new RuntimeApiError(
      409,
      "workflow_not_published",
      "workflow has no published version — publish it first",
    ),
  versionNotReady: (buildStatus: string) =>
    new RuntimeApiError(
      409,
      "version_not_ready",
      `published version's build is not ready (status: ${buildStatus})`,
      { buildStatus },
    ),
  sessionNotContinuable: () =>
    new RuntimeApiError(
      409,
      "session_not_continuable",
      "session has no continuation token or is closed",
    ),
  sessionBusy: () =>
    new RuntimeApiError(
      409,
      "session_busy",
      "session already has an active run — wait for it to finish before sending another message",
    ),

  workspaceRunCapExceeded: (cap: number) =>
    new RuntimeApiError(
      429,
      "workspace_run_cap_exceeded",
      `workspace already has ${cap} active runs — wait for one to finish`,
      { cap },
    ),

  // ── 5xx: platform-side problems ───────────────────────────────────────────
  noLiveWorker: () =>
    new RuntimeApiError(503, "no_live_worker", "no live worker available to run this session"),
  providerKeyMissing: (provider: string) =>
    new RuntimeApiError(
      500,
      "provider_key_missing",
      `platform has no API key configured for provider "${provider}"`,
    ),
  mcpSecretUnavailable: (connectionId: string) =>
    new RuntimeApiError(
      500,
      "mcp_secret_unavailable",
      `failed to decrypt auth secret for MCP connection ${connectionId}`,
    ),
  encryptionKeyMissing: () =>
    new RuntimeApiError(
      500,
      "encryption_key_missing",
      "ENCRYPTION_MASTER_KEY is not configured — cannot decrypt MCP secrets",
    ),
  workerDispatchFailed: (detail: string) =>
    new RuntimeApiError(
      502,
      "worker_dispatch_failed",
      `worker did not accept the dispatch: ${detail}`,
    ),
} as const;

export function isRuntimeApiError(value: unknown): value is RuntimeApiError {
  return value instanceof RuntimeApiError;
}
