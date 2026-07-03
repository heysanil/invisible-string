/**
 * `WS /workspaces/:workspaceId/copilot` — the builder copilot socket
 * (spec §12, PLAN Phase 4).
 *
 * - Authenticated at UPGRADE via the Better Auth session cookie the SPA
 *   already sends (beforeHandle rejects 401/403 before the handshake
 *   completes), workspace-scoped through the same `resolveWorkspace` logic
 *   as every product route.
 * - Per-workspace concurrent session cap (default 2, COPILOT_MAX_SESSIONS).
 * - Each `user_message` frame re-checks that the workflowId belongs to the
 *   socket's workspace and reloads the workspace inventory fresh, then runs
 *   one CopilotSession turn (see session.ts for the tool loop).
 */
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  copilotClientFrameSchema,
  type CopilotServerFrame,
} from "@invisible-string/shared";

import type { Db } from "../db";
import {
  resolveWorkspace,
  type WorkspaceContext,
  type WorkspaceDeps,
} from "../workspace";
import type { CopilotConfig } from "./config";
import { createInventoryLoader, type LoadInventoryFn } from "./inventory";
import { CopilotSession } from "./session";
import type { CopilotTransport } from "./transport";

export interface CopilotDeps {
  workspaceDeps: WorkspaceDeps;
  config: CopilotConfig;
  transport: CopilotTransport;
  loadInventory: LoadInventoryFn;
  /** True when `workflowId` exists inside `organizationId` (IDOR guard). */
  workflowExists: (workflowId: string, organizationId: string) => Promise<boolean>;
}

/** Production `workflowExists` backed by drizzle. */
export function createWorkflowExists(db: Db): CopilotDeps["workflowExists"] {
  return async (workflowId, organizationId) => {
    const rows = await db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.id, workflowId),
          eq(schema.workflows.organizationId, organizationId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  };
}

/** Convenience constructor for the production dependency set. */
export function createCopilotDeps(opts: {
  db: Db;
  workspaceDeps: WorkspaceDeps;
  config: CopilotConfig;
  transport: CopilotTransport;
}): CopilotDeps {
  return {
    workspaceDeps: opts.workspaceDeps,
    config: opts.config,
    transport: opts.transport,
    loadInventory: createInventoryLoader(opts.db),
    workflowExists: createWorkflowExists(opts.db),
  };
}

interface SocketState {
  workspace: WorkspaceContext;
  session: CopilotSession;
  counted: boolean;
}

export function copilotPlugin(deps: CopilotDeps) {
  // Upgrade-time auth result, keyed by the upgrade Request (beforeHandle and
  // open() see the same Request object).
  const authorized = new WeakMap<Request, WorkspaceContext>();
  // Live sessions per workspace (concurrency cap).
  const liveByWorkspace = new Map<string, number>();
  const states = new Map<string, SocketState>();

  return new Elysia({ name: "copilot" }).ws("/workspaces/:workspaceId/copilot", {
    // Reject unauthenticated / workspace-less callers BEFORE the upgrade.
    // The :workspaceId path segment follows the product-route convention and
    // is IDOR-checked against the caller's ACTIVE organization (same rule as
    // every /workspaces/:workspaceId/... REST route).
    beforeHandle: async ({ request, params, status }) => {
      const result = await resolveWorkspace(
        deps.workspaceDeps,
        request.headers,
        undefined,
        (params as { workspaceId?: string }).workspaceId,
      );
      if (!result.ok) return status(result.status, { error: result.message });
      authorized.set(request, result.workspace);
      return undefined;
    },
    open: (ws) => {
      const workspace = authorized.get(ws.data.request as Request);
      if (!workspace) {
        // Defensive: beforeHandle must have run; never serve an unauthenticated socket.
        ws.close(1008, "unauthorized");
        return;
      }
      const live = liveByWorkspace.get(workspace.organizationId) ?? 0;
      if (live >= deps.config.maxSessionsPerWorkspace) {
        send(ws, {
          type: "error",
          code: "session_limit",
          message: `this workspace already has ${live} active copilot session(s) (max ${deps.config.maxSessionsPerWorkspace})`,
        });
        ws.close(1013, "copilot session limit reached");
        return;
      }
      liveByWorkspace.set(workspace.organizationId, live + 1);
      const session = new CopilotSession({
        transport: deps.transport,
        config: deps.config,
        send: (frame) => send(ws, frame),
      });
      states.set(ws.id, { workspace, session, counted: true });
    },
    message: (ws, raw) => {
      const state = states.get(ws.id);
      if (!state) {
        ws.close(1008, "unauthorized");
        return;
      }
      const parsed = copilotClientFrameSchema.safeParse(
        typeof raw === "string" ? safeJsonParse(raw) : raw,
      );
      if (!parsed.success) {
        send(ws, {
          type: "error",
          code: "invalid_frame",
          message: "frame failed validation",
        });
        return;
      }
      const frame = parsed.data;
      switch (frame.type) {
        case "abort":
          state.session.abort();
          break;
        case "mutation_result":
          state.session.resolveMutation(frame.proposalId, {
            outcome: frame.outcome,
            reason: frame.reason,
          });
          break;
        case "user_message": {
          if (state.session.busy) {
            send(ws, {
              type: "error",
              code: "turn_in_progress",
              message: "a copilot turn is already streaming on this connection",
            });
            return;
          }
          // Async turn: scope-check the workflow, load fresh inventory, run.
          void (async () => {
            const exists = await deps.workflowExists(
              frame.workflowId,
              state.workspace.organizationId,
            );
            if (!exists) {
              send(ws, {
                type: "error",
                code: "workflow_not_found",
                message: "workflow not found in this workspace",
              });
              return;
            }
            const inventory = await deps.loadInventory(
              state.workspace.organizationId,
              state.workspace.userId,
            );
            await state.session.runTurn({
              message: frame.message,
              draft: frame.draft,
              inventory,
            });
          })().catch(() => {
            send(ws, {
              type: "error",
              code: "llm_error",
              message: "copilot turn failed",
            });
          });
          break;
        }
      }
    },
    close: (ws) => {
      const state = states.get(ws.id);
      if (!state) return;
      states.delete(ws.id);
      state.session.dispose();
      if (state.counted) {
        const live = liveByWorkspace.get(state.workspace.organizationId) ?? 1;
        if (live <= 1) liveByWorkspace.delete(state.workspace.organizationId);
        else liveByWorkspace.set(state.workspace.organizationId, live - 1);
      }
    },
  });
}

function send(
  ws: { send: (data: string) => unknown; readyState?: number },
  frame: CopilotServerFrame,
): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // socket already closed — frame dropped
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
