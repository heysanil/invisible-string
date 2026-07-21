/**
 * `WS /workspaces/:workspaceId/copilot` — the copilot socket (spec §12).
 * One socket, two surfaces: each `user_message` frame names the editor it is
 * about (`surface: "workflow" | "agent"`) plus the `entityId` being edited;
 * the server selects the matching toolset/prompt (see prompt.ts).
 *
 * - Authenticated at UPGRADE via the Better Auth session cookie the SPA
 *   already sends (beforeHandle rejects 401/403 before the handshake
 *   completes), workspace-scoped through the same `resolveWorkspace` logic
 *   as every product route — and RE-VALIDATED on every user_message turn so
 *   a revoked session / removed membership cannot keep driving the model on
 *   a long-lived socket.
 * - Per-workspace concurrent session cap (default 2, COPILOT_MAX_SESSIONS).
 * - Per-workspace rolling budget: turns AND estimated tokens per window
 *   (config.maxTurnsPerWindow / maxTokensPerWindow / budgetWindowMs) — the
 *   per-turn caps alone would let a client loop unlimited cheap turns on the
 *   platform key.
 * - Each `user_message` frame re-checks that the surface entity belongs to
 *   the socket's workspace (workflow or agent row per `surface`) and reloads
 *   the workspace inventory fresh, then runs one CopilotSession turn (see
 *   session.ts for the tool loop).
 */
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  copilotClientFrameSchema,
  type CopilotServerFrame,
  type CopilotSurface,
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
  /**
   * True when the surface's entity (workflow or agent row per `surface`)
   * exists inside `organizationId` (IDOR guard).
   */
  entityExists: (
    surface: CopilotSurface,
    entityId: string,
    organizationId: string,
  ) => Promise<boolean>;
}

/** Production `entityExists` backed by drizzle. */
export function createEntityExists(db: Db): CopilotDeps["entityExists"] {
  return async (surface, entityId, organizationId) => {
    if (surface === "workflow") {
      const rows = await db
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(
          and(
            eq(schema.workflows.id, entityId),
            eq(schema.workflows.organizationId, organizationId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }
    const rows = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.id, entityId),
          eq(schema.agents.organizationId, organizationId),
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
    entityExists: createEntityExists(opts.db),
  };
}

interface SocketState {
  workspace: WorkspaceContext;
  /** Upgrade-request headers, re-presented to resolveWorkspace every turn. */
  headers: Headers;
  session: CopilotSession;
  counted: boolean;
}

/** Rolling per-workspace spend window (turns + estimated tokens). */
interface BudgetWindow {
  windowStart: number;
  turns: number;
  tokens: number;
}

/** Rough chars→tokens estimate for input-side budget metering. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function copilotPlugin(deps: CopilotDeps) {
  // Upgrade-time auth result, keyed by the upgrade Request (beforeHandle and
  // open() see the same Request object).
  const authorized = new WeakMap<Request, WorkspaceContext>();
  // Live sessions per workspace (concurrency cap).
  const liveByWorkspace = new Map<string, number>();
  const states = new Map<string, SocketState>();
  // Rolling budget per workspace (organizationId → window).
  const budgets = new Map<string, BudgetWindow>();

  function budgetFor(organizationId: string): BudgetWindow {
    const now = Date.now();
    const existing = budgets.get(organizationId);
    if (existing && now - existing.windowStart < deps.config.budgetWindowMs) {
      return existing;
    }
    const fresh: BudgetWindow = { windowStart: now, turns: 0, tokens: 0 };
    budgets.set(organizationId, fresh);
    return fresh;
  }

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
      const request = ws.data.request as Request;
      const workspace = authorized.get(request);
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
      states.set(ws.id, {
        workspace,
        headers: request.headers,
        session,
        counted: true,
      });
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
          // A fresh user message supersedes any stale idle-abort latch; an
          // abort arriving DURING the awaits below re-latches and cancels the
          // turn before its first model call (see session.clearPendingAbort).
          state.session.clearPendingAbort();
          // Rolling per-workspace budget: bounded turns + tokens per window.
          const budget = budgetFor(state.workspace.organizationId);
          const inputEstimate = estimateTokens(
            frame.message.length + JSON.stringify(frame.draft).length,
          );
          if (
            budget.turns >= deps.config.maxTurnsPerWindow ||
            budget.tokens + inputEstimate > deps.config.maxTokensPerWindow
          ) {
            send(ws, {
              type: "error",
              code: "over_budget",
              message:
                "this workspace's copilot budget for the current window is used up — try again later",
            });
            return;
          }
          budget.turns += 1;
          budget.tokens += inputEstimate;
          // Async turn: re-authorize the caller, scope-check the surface
          // entity, load fresh inventory, run.
          void (async () => {
            // Membership/session re-validation per turn: a socket opened with
            // a since-revoked session (logout, member removal) must not keep
            // running copilot turns until it happens to drop.
            const auth = await resolveWorkspace(
              deps.workspaceDeps,
              state.headers,
              undefined,
              state.workspace.organizationId,
            );
            if (
              !auth.ok ||
              auth.workspace.organizationId !== state.workspace.organizationId ||
              auth.workspace.userId !== state.workspace.userId
            ) {
              send(ws, {
                type: "error",
                code: "unauthorized",
                message: "your session is no longer valid for this workspace",
              });
              ws.close(1008, "unauthorized");
              return;
            }
            const exists = await deps.entityExists(
              frame.surface,
              frame.entityId,
              state.workspace.organizationId,
            );
            if (!exists) {
              send(ws, {
                type: "error",
                code: "entity_not_found",
                message: `${frame.surface} not found in this workspace`,
              });
              return;
            }
            const inventory = await deps.loadInventory(
              state.workspace.organizationId,
              state.workspace.userId,
            );
            const outputTokens = await state.session.runTurn({
              surface: frame.surface,
              message: frame.message,
              draft: frame.draft,
              inventory,
            });
            budgetFor(state.workspace.organizationId).tokens += outputTokens;
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
