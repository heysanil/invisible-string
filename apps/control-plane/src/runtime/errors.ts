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
  skillFilesUnavailable: (skillName: string) =>
    new RuntimeApiError(
      500,
      "skill_files_unavailable",
      `skill "${skillName}" has attachments but the object store is not configured — cannot compile`,
    ),
  skillFileMissing: (skillName: string, fileName: string) =>
    new RuntimeApiError(
      500,
      "skill_file_missing",
      `skill "${skillName}" attachment "${fileName}" could not be read from the object store`,
    ),

  // ── Phase-2 resource errors ───────────────────────────────────────────────
  notFound: (resource: string) =>
    new RuntimeApiError(404, `${resource}_not_found`, `${resource.replace(/_/g, " ")} not found in this workspace`),
  invalidBody: (issues: unknown) =>
    new RuntimeApiError(422, "invalid_body", "request body failed validation", issues),
  forbiddenRole: (role: string) =>
    new RuntimeApiError(403, "forbidden", `requires ${role} role in this workspace`),
  runAsUserNotMember: (userId: string) =>
    new RuntimeApiError(
      422,
      "run_as_user_not_member",
      `run-as user ${userId} is not a member of this workspace`,
    ),
  toolFilterConflict: () =>
    new RuntimeApiError(
      422,
      "tool_filter_conflict",
      "set a tool allowlist OR a blocklist on a connection, not both",
    ),
  connectionInUse: (workflowNames: string[]) =>
    new RuntimeApiError(
      409,
      "connection_in_use",
      `connection is referenced by ${workflowNames.length} workflow(s): ${workflowNames.join(", ")}`,
      { workflows: workflowNames },
    ),
  skillFileTooLarge: (maxBytes: number) =>
    new RuntimeApiError(
      413,
      "skill_file_too_large",
      `attachment exceeds the ${maxBytes}-byte limit`,
      { maxBytes },
    ),
  skillFileLimitExceeded: (max: number) =>
    new RuntimeApiError(
      422,
      "skill_file_limit_exceeded",
      `a skill may have at most ${max} attachments`,
      { max },
    ),
  skillFileInvalid: (message: string) =>
    new RuntimeApiError(422, "skill_file_invalid", message),
  modelReferencedByPreset: (slugs: string[]) =>
    new RuntimeApiError(
      409,
      "model_referenced_by_preset",
      `model is used by the ${slugs.join(", ")} preset(s) — repoint them before removing it`,
      { presets: slugs },
    ),
  modelAllowlistDuplicate: () =>
    new RuntimeApiError(
      409,
      "model_allowlist_duplicate",
      "that provider + model is already on the allowlist",
    ),
  registryUnavailable: (detail: string) =>
    new RuntimeApiError(
      502,
      "registry_unavailable",
      `the MCP registry is unavailable: ${detail}`,
    ),
  registryServerNotFound: (name: string) =>
    new RuntimeApiError(404, "registry_server_not_found", `registry server "${name}" not found`),
  registryServerNotInstallable: (name: string) =>
    new RuntimeApiError(
      422,
      "registry_server_not_installable",
      `registry server "${name}" has no remote (streamable-http/sse) endpoint to install`,
    ),
  noPendingInput: () =>
    new RuntimeApiError(
      409,
      "no_pending_input",
      "run is not waiting on input — nothing to resolve",
    ),
  nameTaken: (resource: string, name: string) =>
    new RuntimeApiError(
      409,
      `${resource}_name_taken`,
      `a ${resource.replace(/_/g, " ")} named "${name}" already exists in this workspace`,
    ),

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
