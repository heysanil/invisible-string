/**
 * Resource CRUD plugin — wires the HTTP surface for agents, workflows,
 * sessions (list), MCP connections (+ registry proxy/install), skills
 * (+ attachments), model presets/allowlist, and members onto the pure
 * service functions in this directory. Mounted unconditionally (product CRUD
 * does not require the runtime env); skill uploads that need the object
 * store fail with a typed error when it is unconfigured.
 *
 * Scopes: workspace resources use the `requireWorkspace` macro (role-gated
 * where noted); user-scoped `/me/...` resources use the `requireAuth` macro.
 */
import { Elysia } from "elysia";
import { SKILL_FILE_MAX_BYTES } from "@invisible-string/shared";

import { errors, isRuntimeApiError } from "../runtime/errors";
import { workspacePlugin } from "../workspace";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "./agents";
import type { ResourceDeps, Scope } from "./common";
import { listWorkspaceMembers } from "./members";
import {
  createConnection,
  deleteConnection,
  getConnection,
  installConnection,
  listConnections,
  updateConnection,
} from "./mcp-connections";
import {
  addModelAllowlistEntry,
  deleteModelAllowlistEntry,
  listModelAllowlist,
  listModelPresets,
  updateModelAllowlistEntry,
  updateModelPreset,
} from "./presets";
import { toRegistrySearchResponse } from "./registry";
import { listSessions } from "./sessions";
import {
  createSkill,
  deleteSkill,
  deleteSkillFile,
  getSkill,
  listSkills,
  updateSkill,
  uploadSkillFile,
  type UploadedFile,
} from "./skills";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  publishWorkflow,
  updateWorkflow,
} from "./workflows";

/**
 * Transport ceiling for a skill upload body — the per-file cap plus a little
 * multipart framing overhead. Enforced from the Content-Length header BEFORE
 * the body is buffered, so an authenticated member cannot force large
 * allocations by streaming a body far above the 5 MiB attachment limit.
 */
const SKILL_UPLOAD_MAX_BODY_BYTES = SKILL_FILE_MAX_BYTES + 1024 * 1024;

/** Reject an oversized upload by Content-Length before reading the body. */
function assertUploadWithinLimit(request: Request): void {
  const header = request.headers.get("content-length");
  if (header === null) return;
  const length = Number(header);
  if (Number.isFinite(length) && length > SKILL_UPLOAD_MAX_BODY_BYTES) {
    throw errors.skillFileTooLarge(SKILL_FILE_MAX_BYTES);
  }
}

/** Pull an uploaded file out of a parsed multipart body. */
async function readUploadedFile(body: unknown): Promise<UploadedFile> {
  const field = (body as { file?: unknown } | null)?.file;
  if (
    !field ||
    typeof field !== "object" ||
    typeof (field as Blob).arrayBuffer !== "function"
  ) {
    throw errors.skillFileInvalid("expected a multipart form field named 'file'");
  }
  const blob = field as File;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    name: typeof blob.name === "string" && blob.name.length > 0 ? blob.name : "file",
    mediaType: blob.type || "application/octet-stream",
    bytes,
  };
}

export function resourcesPlugin(deps: ResourceDeps) {
  const wsScope = (organizationId: string): Scope => ({
    kind: "workspace",
    organizationId,
  });
  const userScope = (userId: string): Scope => ({ kind: "user", userId });

  return (
    new Elysia({ name: "resources" })
      .use(workspacePlugin(deps.workspaceDeps))
      .onError(({ error, set }) => {
        if (isRuntimeApiError(error)) {
          set.status = error.status;
          return error.toBody();
        }
        return undefined;
      })

      // ── Workflows (workspace-scoped; role-gated) ──────────────────────────
      .get(
        "/workspaces/:workspaceId/workflows",
        ({ workspace }) => listWorkflows(deps, workspace.organizationId),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/workflows",
        async ({ workspace, body, set }) => {
          const result = await createWorkflow(
            deps,
            { organizationId: workspace.organizationId, userId: workspace.userId },
            body,
          );
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .get(
        "/workspaces/:workspaceId/workflows/:wfId",
        ({ workspace, params }) =>
          getWorkflow(deps, workspace.organizationId, params.wfId),
        { requireWorkspace: true },
      )
      .patch(
        "/workspaces/:workspaceId/workflows/:wfId",
        ({ workspace, params, body }) =>
          updateWorkflow(
            deps,
            { organizationId: workspace.organizationId, userId: workspace.userId },
            params.wfId,
            body,
          ),
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/workflows/:wfId",
        ({ workspace, params }) =>
          deleteWorkflow(deps, workspace.organizationId, params.wfId),
        { requireWorkspace: "admin" },
      )
      // Publish = validate + snapshot draft→published + sync the trigger row.
      // NO compile/build (the agent is the compile unit) — member-gated like
      // create/edit; blocking diagnostics 422 `workflow_validation_failed`.
      .post(
        "/workspaces/:workspaceId/workflows/:wfId/publish",
        ({ workspace, params }) =>
          publishWorkflow(deps, workspace.organizationId, params.wfId),
        { requireWorkspace: true },
      )

      // ── Sessions list (workspace-scoped) ──────────────────────────────────
      .get(
        "/workspaces/:workspaceId/sessions",
        ({ workspace, query }) =>
          listSessions(deps, workspace.organizationId, query),
        { requireWorkspace: true },
      )

      // ── MCP connections — workspace scope ─────────────────────────────────
      .get(
        "/workspaces/:workspaceId/mcp-connections",
        ({ workspace }) => listConnections(deps, wsScope(workspace.organizationId)),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/mcp-connections",
        async ({ workspace, body, set }) => {
          const result = await createConnection(deps, wsScope(workspace.organizationId), body);
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/mcp-connections/install",
        async ({ workspace, body, set }) => {
          const result = await installConnection(deps, wsScope(workspace.organizationId), body);
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .get(
        "/workspaces/:workspaceId/mcp-connections/:id",
        ({ workspace, params }) =>
          getConnection(deps, wsScope(workspace.organizationId), params.id),
        { requireWorkspace: true },
      )
      .patch(
        "/workspaces/:workspaceId/mcp-connections/:id",
        ({ workspace, params, body }) =>
          updateConnection(deps, wsScope(workspace.organizationId), params.id, body),
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/mcp-connections/:id",
        ({ workspace, params }) =>
          deleteConnection(deps, wsScope(workspace.organizationId), params.id),
        { requireWorkspace: true },
      )

      // ── MCP connections — user scope (/me) ────────────────────────────────
      .get(
        "/me/mcp-connections",
        ({ authUser }) => listConnections(deps, userScope(authUser.id)),
        { requireAuth: true },
      )
      .post(
        "/me/mcp-connections",
        async ({ authUser, body, set }) => {
          const result = await createConnection(deps, userScope(authUser.id), body);
          set.status = 201;
          return result;
        },
        { requireAuth: true },
      )
      .post(
        "/me/mcp-connections/install",
        async ({ authUser, body, set }) => {
          const result = await installConnection(deps, userScope(authUser.id), body);
          set.status = 201;
          return result;
        },
        { requireAuth: true },
      )
      .get(
        "/me/mcp-connections/:id",
        ({ authUser, params }) => getConnection(deps, userScope(authUser.id), params.id),
        { requireAuth: true },
      )
      .patch(
        "/me/mcp-connections/:id",
        ({ authUser, params, body }) =>
          updateConnection(deps, userScope(authUser.id), params.id, body),
        { requireAuth: true },
      )
      .delete(
        "/me/mcp-connections/:id",
        ({ authUser, params }) => deleteConnection(deps, userScope(authUser.id), params.id),
        { requireAuth: true },
      )

      // ── MCP registry proxy (SSRF-contained: fixed host only) ──────────────
      .get(
        "/mcp-registry/search",
        async ({ query }) => {
          const q = typeof query.q === "string" ? query.q.trim() : "";
          if (q.length === 0) return toRegistrySearchResponse([]);
          return toRegistrySearchResponse(await deps.registry.search(q));
        },
        { requireAuth: true },
      )

      // ── Skills — workspace scope ──────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/skills",
        ({ workspace }) => listSkills(deps, wsScope(workspace.organizationId)),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/skills",
        async ({ workspace, body, set }) => {
          const result = await createSkill(deps, wsScope(workspace.organizationId), body);
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .get(
        "/workspaces/:workspaceId/skills/:id",
        ({ workspace, params }) => getSkill(deps, wsScope(workspace.organizationId), params.id),
        { requireWorkspace: true },
      )
      .patch(
        "/workspaces/:workspaceId/skills/:id",
        ({ workspace, params, body }) =>
          updateSkill(deps, wsScope(workspace.organizationId), params.id, body),
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/skills/:id",
        ({ workspace, params }) =>
          deleteSkill(deps, wsScope(workspace.organizationId), params.id),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/skills/:id/files",
        async ({ workspace, params, body, request }) => {
          assertUploadWithinLimit(request);
          return uploadSkillFile(
            deps,
            wsScope(workspace.organizationId),
            params.id,
            await readUploadedFile(body),
          );
        },
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/skills/:id/files/*",
        ({ workspace, params }) =>
          deleteSkillFile(
            deps,
            wsScope(workspace.organizationId),
            params.id,
            decodeSegment(params["*"]),
          ),
        { requireWorkspace: true },
      )

      // ── Skills — user scope (/me) ─────────────────────────────────────────
      .get("/me/skills", ({ authUser }) => listSkills(deps, userScope(authUser.id)), {
        requireAuth: true,
      })
      .post(
        "/me/skills",
        async ({ authUser, body, set }) => {
          const result = await createSkill(deps, userScope(authUser.id), body);
          set.status = 201;
          return result;
        },
        { requireAuth: true },
      )
      .get(
        "/me/skills/:id",
        ({ authUser, params }) => getSkill(deps, userScope(authUser.id), params.id),
        { requireAuth: true },
      )
      .patch(
        "/me/skills/:id",
        ({ authUser, params, body }) =>
          updateSkill(deps, userScope(authUser.id), params.id, body),
        { requireAuth: true },
      )
      .delete(
        "/me/skills/:id",
        ({ authUser, params }) => deleteSkill(deps, userScope(authUser.id), params.id),
        { requireAuth: true },
      )
      .post(
        "/me/skills/:id/files",
        async ({ authUser, params, body, request }) => {
          assertUploadWithinLimit(request);
          return uploadSkillFile(
            deps,
            userScope(authUser.id),
            params.id,
            await readUploadedFile(body),
          );
        },
        { requireAuth: true },
      )
      .delete(
        "/me/skills/:id/files/*",
        ({ authUser, params }) =>
          deleteSkillFile(
            deps,
            userScope(authUser.id),
            params.id,
            decodeSegment(params["*"]),
          ),
        { requireAuth: true },
      )

      // ── Model presets ─────────────────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/model-presets",
        ({ workspace }) => listModelPresets(deps, workspace.organizationId),
        { requireWorkspace: true },
      )
      .put(
        "/workspaces/:workspaceId/model-presets/:slug",
        ({ workspace, params, body }) =>
          updateModelPreset(deps, workspace.organizationId, params.slug, body),
        { requireWorkspace: "admin" },
      )

      // ── Model allowlist ───────────────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/model-allowlist",
        ({ workspace }) => listModelAllowlist(deps, workspace.organizationId),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/model-allowlist",
        async ({ workspace, body, set }) => {
          const result = await addModelAllowlistEntry(deps, workspace.organizationId, body);
          set.status = 201;
          return result;
        },
        { requireWorkspace: "admin" },
      )
      .patch(
        "/workspaces/:workspaceId/model-allowlist/:id",
        ({ workspace, params, body }) =>
          updateModelAllowlistEntry(deps, workspace.organizationId, params.id, body),
        { requireWorkspace: "admin" },
      )
      .delete(
        "/workspaces/:workspaceId/model-allowlist/:id",
        ({ workspace, params }) =>
          deleteModelAllowlistEntry(deps, workspace.organizationId, params.id),
        { requireWorkspace: "admin" },
      )

      // ── Agents (workspace-scoped; role rules match workflows: member
      // creates/edits — agents are a primary product surface, not settings —
      // and delete is admin-gated like other destructive ops) ───────────────
      .get(
        "/workspaces/:workspaceId/agents",
        ({ workspace }) => listAgents(deps, workspace.organizationId),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/agents",
        async ({ workspace, body, set }) => {
          const result = await createAgent(
            deps,
            { organizationId: workspace.organizationId, userId: workspace.userId },
            body,
          );
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .get(
        "/workspaces/:workspaceId/agents/:agentId",
        ({ workspace, params }) => getAgent(deps, workspace.organizationId, params.agentId),
        { requireWorkspace: true },
      )
      .patch(
        "/workspaces/:workspaceId/agents/:agentId",
        ({ workspace, params, body }) =>
          updateAgent(
            deps,
            { organizationId: workspace.organizationId, userId: workspace.userId },
            params.agentId,
            body,
          ),
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/agents/:agentId",
        ({ workspace, params }) => deleteAgent(deps, workspace.organizationId, params.agentId),
        { requireWorkspace: "admin" },
      )

      // ── Members (Better Auth passthrough) ─────────────────────────────────
      .get(
        "/workspaces/:workspaceId/members",
        ({ workspace, request }) =>
          listWorkspaceMembers(deps, workspace.organizationId, request.headers),
        { requireWorkspace: true },
      )
  );
}

/** Decode a wildcard path segment (the attachment filename). */
function decodeSegment(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
