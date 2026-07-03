/**
 * Phase-2 resource CRUD plugin — wires the HTTP surface for workflows,
 * sessions (list), MCP connections (+ registry proxy/install), skills
 * (+ attachments), model presets/allowlist, agent presets, and members onto
 * the pure service functions in this directory. Mounted unconditionally
 * (product CRUD does not require the runtime env); skill uploads that need the
 * object store fail with a typed error when it is unconfigured.
 *
 * Scopes: workspace resources use the `requireWorkspace` macro (role-gated
 * where noted); user-scoped `/me/...` resources use the `requireAuth` macro.
 */
import { Elysia } from "elysia";

import { errors, isRuntimeApiError } from "../runtime/errors";
import { workspacePlugin } from "../workspace";
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
  createAgentPreset,
  deleteAgentPreset,
  deleteModelAllowlistEntry,
  getAgentPreset,
  listAgentPresets,
  listModelAllowlist,
  listModelPresets,
  updateAgentPreset,
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
  updateWorkflow,
} from "./workflows";

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
        async ({ workspace, params, body }) =>
          uploadSkillFile(
            deps,
            wsScope(workspace.organizationId),
            params.id,
            await readUploadedFile(body),
          ),
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
        async ({ authUser, params, body }) =>
          uploadSkillFile(
            deps,
            userScope(authUser.id),
            params.id,
            await readUploadedFile(body),
          ),
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

      // ── Agent presets ─────────────────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/agents",
        ({ workspace }) => listAgentPresets(deps, workspace.organizationId),
        { requireWorkspace: true },
      )
      .post(
        "/workspaces/:workspaceId/agents",
        async ({ workspace, body, set }) => {
          const result = await createAgentPreset(deps, workspace.organizationId, body);
          set.status = 201;
          return result;
        },
        { requireWorkspace: true },
      )
      .get(
        "/workspaces/:workspaceId/agents/:id",
        ({ workspace, params }) => getAgentPreset(deps, workspace.organizationId, params.id),
        { requireWorkspace: true },
      )
      .patch(
        "/workspaces/:workspaceId/agents/:id",
        ({ workspace, params, body }) =>
          updateAgentPreset(deps, workspace.organizationId, params.id, body),
        { requireWorkspace: true },
      )
      .delete(
        "/workspaces/:workspaceId/agents/:id",
        ({ workspace, params }) => deleteAgentPreset(deps, workspace.organizationId, params.id),
        { requireWorkspace: true },
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
